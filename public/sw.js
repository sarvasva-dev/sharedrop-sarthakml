const CACHE_NAME = 'sharedrop-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/network.js',
  '/js/webrtc.js',
  '/js/ui.js',
  '/icons/icon.svg',
  '/manifest.webmanifest'
];

const DB_NAME = 'sharedrop-pwa-db';
const STORE_NAME = 'shared-payloads';

function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedPayload(payload) {
  try {
    const db = await openShareDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id: 'latest', ...payload, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // Ignore IDB storage failures if client messaging succeeds
  }
}

async function consumeSharedPayload() {
  try {
    const db = await openShareDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get('latest');
      getReq.onsuccess = () => {
        const res = getReq.result || null;
        if (res) store.delete('latest');
        resolve(res);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    db.close();
    return record;
  } catch (err) {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Active Native Streaming Downloads map (streamId -> { port, filename, size, mimeType })
const activeDownloadStreams = new Map();

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'REGISTER_DOWNLOAD_STREAM') {
    const { streamId, filename, size, mimeType } = event.data;
    const port = event.ports && event.ports[0];
    if (port && streamId) {
      activeDownloadStreams.set(streamId, {
        port,
        filename: filename || 'download.bin',
        size: Number(size) || 0,
        mimeType: mimeType || 'application/octet-stream',
        registeredAt: Date.now()
      });
    }
    return;
  }

  if (event.data && event.data.type === 'consume-share-target') {
    event.waitUntil(
      consumeSharedPayload().then((payload) => {
        if (payload && event.source) {
          event.source.postMessage({
            type: 'pwa-share-target',
            files: payload.files || [],
            text: payload.text || '',
            title: payload.title || '',
            url: payload.url || ''
          });
        }
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept Native Streaming Downloads directly into user's Downloads folder (Google Drive style)
  if (url.pathname.startsWith('/sw-stream-download/')) {
    const parts = url.pathname.split('/');
    const streamId = parts[2];
    const rawFilename = parts.slice(3).join('/') || 'download.bin';
    const decodedFilename = decodeURIComponent(rawFilename);
    const reg = activeDownloadStreams.get(streamId);

    if (!reg || !reg.port) {
      event.respondWith(new Response('Stream not registered or expired', { status: 404 }));
      return;
    }

    const stream = new ReadableStream({
      start(controller) {
        reg.port.onmessage = (msgEvent) => {
          if (!msgEvent.data) return;
          if (msgEvent.data.type === 'chunk') {
            const chunk = new Uint8Array(msgEvent.data.chunk);
            controller.enqueue(chunk);
          } else if (msgEvent.data.type === 'end') {
            try { controller.close(); } catch {}
            activeDownloadStreams.delete(streamId);
          } else if (msgEvent.data.type === 'abort') {
            try { controller.error(new Error('Stream aborted')); } catch {}
            activeDownloadStreams.delete(streamId);
          }
        };
      },
      cancel() {
        activeDownloadStreams.delete(streamId);
      }
    });

    const safeFilename = decodedFilename.replace(/["\r\n]/g, '_');
    const headers = new Headers();
    headers.set('Content-Type', reg.mimeType || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(decodedFilename)}`);
    if (reg.size && reg.size > 0) {
      headers.set('Content-Length', String(reg.size));
    }
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');

    event.respondWith(new Response(stream, { headers }));
    return;
  }

  // Intercept Web Share Target POST requests
  if (event.request.method === 'POST' && url.searchParams.has('share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const files = formData.getAll('files').filter((f) => f && typeof f === 'object' && f.size !== undefined);
          const title = String(formData.get('title') || '').trim();
          const text = String(formData.get('text') || '').trim();
          const sharedUrl = String(formData.get('url') || '').trim();

          const payload = { files, title, text, url: sharedUrl };
          await saveSharedPayload(payload);

          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          await Promise.all(
            clientList.map((client) =>
              client.postMessage({
                type: 'pwa-share-target',
                files,
                title,
                text,
                url: sharedUrl
              })
            )
          );
        } catch (err) {
          // Proceed with redirect even if parsing fails
        }
        return Response.redirect('/?shared=1', 303);
      })()
    );
    return;
  }

  // Only handle GET requests for same-origin static shell
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cache API, WebSocket, or ephemeral drop download routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Network-first with cache fallback for HTML/JS/CSS so updates appear immediately while offline still works
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        throw new Error('Offline and not cached');
      })
  );
});
