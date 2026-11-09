#!/usr/bin/env node
/**
 * ShareDrop Terminal CLI (`sharedrop`)
 * Production-grade CLI for beaming files, folders, and text snippets to/from
 * ShareDrop (`https://sharedrop.sarthakml.in` or local LAN server).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');

const DEFAULT_SERVER = process.env.SHAREDROP_SERVER || process.env.PUBLIC_URL || 'http://localhost:3000';
const PUBLIC_DOMAIN_URL = 'https://sharedrop.sarthakml.in';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  orange: '\x1b[38;5;208m',
  teal: '\x1b[38;5;37m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = num / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIdx]}`;
}

function normalizeServerUrl(rawUrl) {
  const trimmed = (rawUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {
    server: DEFAULT_SERVER,
    room: '',
    name: `CLI-${os.hostname().slice(0, 12)}`,
    output: '',
    help: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help' || arg === 'help') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--server' || arg === '-s') {
      flags.server = args[++i] || DEFAULT_SERVER;
    } else if (arg.startsWith('--server=')) {
      flags.server = arg.split('=')[1];
    } else if (arg === '--room' || arg === '-r') {
      flags.room = (args[++i] || '').toUpperCase();
    } else if (arg.startsWith('--room=')) {
      flags.room = arg.split('=')[1].toUpperCase();
    } else if (arg === '--name' || arg === '-n') {
      flags.name = args[++i] || flags.name;
    } else if (arg.startsWith('--name=')) {
      flags.name = arg.split('=')[1];
    } else if (arg === '-o' || arg === '--output') {
      flags.output = args[++i] || '';
    } else if (arg.startsWith('--output=')) {
      flags.output = arg.split('=')[1];
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || (flags.help ? 'help' : ''),
    targets: positional.slice(1),
    flags,
  };
}

function printHelp() {
  console.log(`
${ANSI.bold}${ANSI.orange}ShareDrop CLI${ANSI.reset} — P2P & Ephemeral Relay File Sharing (${ANSI.teal}${PUBLIC_DOMAIN_URL}${ANSI.reset})

${ANSI.bold}USAGE:${ANSI.reset}
  sharedrop <command> [arguments] [options]

${ANSI.bold}COMMANDS:${ANSI.reset}
  ${ANSI.teal}send${ANSI.reset} <file-or-text...>   Upload file(s) or text snippet and generate a 6-char Drop Code + QR
  ${ANSI.teal}receive${ANSI.reset} <code-or-url>    Download a drop by its 6-char code or direct /d/:code URL
  ${ANSI.teal}status${ANSI.reset}                   Inspect server health, LAN/Public URLs, active peers, and drops
  ${ANSI.teal}--help${ANSI.reset}                   Show this usage guide

${ANSI.bold}OPTIONS:${ANSI.reset}
  -s, --server <url>       Target ShareDrop server (default: ${DEFAULT_SERVER})
  -r, --room <ABCDE>       Announce drop to a 5-character public room on radar
  -n, --name <display>     Sender display name (default: CLI-<hostname>)
  -o, --output <path>      Output directory or file path for 'receive'
      --json               Print machine-readable JSON output

${ANSI.bold}EXAMPLES:${ANSI.reset}
  sharedrop send ./report.pdf --server https://sharedrop.sarthakml.in
  sharedrop send ./photo.png --room K7M9P --name "Sarthak-Laptop"
  sharedrop receive X9K2M4 -o ./downloads
  sharedrop status --server http://localhost:3000
`);
}

function requestJson(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlString);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsedUrl,
      {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.headers || {}),
        },
        timeout: options.timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { raw };
          }
          if (res.statusCode >= 400) {
            const errMessage =
              (data && data.error && (data.error.message || data.error)) ||
              (data && data.message) ||
              `HTTP ${res.statusCode}`;
            const err = new Error(errMessage);
            err.statusCode = res.statusCode;
            err.response = data;
            return reject(err);
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeout || 15000}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function collectInputFiles(targets) {
  const entries = [];
  for (const target of targets) {
    const resolved = path.resolve(process.cwd(), target);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        entries.push({
          type: 'file',
          filePath: resolved,
          fileName: path.basename(resolved),
          size: stat.size,
        });
      } else if (stat.isDirectory()) {
        const childNames = fs.readdirSync(resolved);
        for (const child of childNames) {
          const childPath = path.join(resolved, child);
          const childStat = fs.statSync(childPath);
          if (childStat.isFile()) {
            entries.push({
              type: 'file',
              filePath: childPath,
              fileName: path.basename(childPath),
              size: childStat.size,
            });
          }
        }
      }
    } else {
      const buffer = Buffer.from(String(target), 'utf8');
      entries.push({
        type: 'buffer',
        buffer,
        fileName: 'snippet.txt',
        size: buffer.length,
        textValue: String(target),
      });
    }
  }
  return entries;
}

function uploadMultipartDrop(serverUrl, entries, flags) {
  return new Promise((resolve, reject) => {
    const boundary = `----ShareDropBoundary${crypto.randomBytes(12).toString('hex')}`;
    const endpoint = new URL('/api/drop', `${serverUrl}/`);
    if (flags.room) endpoint.searchParams.set('roomCode', flags.room);
    if (flags.name) endpoint.searchParams.set('senderName', flags.name);

    const CRLF = '\r\n';
    const preambleParts = [];

    const addTextField = (name, value) => {
      if (!value) return;
      preambleParts.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
            `${value}${CRLF}`,
          'utf8'
        )
      );
    };

    addTextField('senderName', flags.name);
    addTextField('name', flags.name);
    if (flags.room) {
      addTextField('roomCode', flags.room);
      addTextField('room', flags.room);
    }

    const fileHeaders = entries.map((entry) => {
      const safeName = entry.fileName.replace(/"/g, '_');
      return Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="files"; filename="${safeName}"${CRLF}` +
          `Content-Type: application/octet-stream${CRLF}${CRLF}`,
        'utf8'
      );
    });

    const epilogue = Buffer.from(`--${boundary}--${CRLF}`, 'utf8');
    const crlfBuf = Buffer.from(CRLF, 'utf8');

    let contentLength = epilogue.length;
    for (const part of preambleParts) contentLength += part.length;
    for (let i = 0; i < entries.length; i++) {
      contentLength += fileHeaders[i].length + entries[i].size + crlfBuf.length;
    }

    const transport = endpoint.protocol === 'https:' ? https : http;
    const req = transport.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
          Accept: 'application/json',
          'X-ShareDrop-Sender': flags.name,
          ...(flags.room ? { 'X-ShareDrop-Room': flags.room } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode >= 400) {
            const msg =
              (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
              (parsed && parsed.message) ||
              `Upload failed with HTTP ${res.statusCode}`;
            return reject(new Error(msg));
          }
          resolve(parsed);
        });
      }
    );

    req.on('error', reject);

    (async () => {
      try {
        for (const part of preambleParts) {
          req.write(part);
        }

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          req.write(fileHeaders[i]);
          if (entry.type === 'buffer') {
            req.write(entry.buffer);
          } else {
            await new Promise((resStream, rejStream) => {
              const readStream = fs.createReadStream(entry.filePath, { highWaterMark: 65536 });
              readStream.on('error', rejStream);
              readStream.on('end', resStream);
              readStream.pipe(req, { end: false });
            });
          }
          req.write(crlfBuf);
        }

        req.end(epilogue);
      } catch (err) {
        req.destroy(err);
        reject(err);
      }
    })();
  });
}

function drawBox(lines) {
  const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
  const maxWidth = Math.max(...lines.map((line) => stripAnsi(line).length), 56);
  const top = `╭─${'─'.repeat(maxWidth)}─╮`;
  const bottom = `╰─${'─'.repeat(maxWidth)}─╯`;
  const body = lines.map((line) => {
    const visibleLen = stripAnsi(line).length;
    const pad = ' '.repeat(Math.max(0, maxWidth - visibleLen));
    return `│ ${line}${pad} │`;
  });
  return [top, ...body, bottom].join('\n');
}

async function handleSend(targets, flags) {
  if (!targets || targets.length === 0) {
    throw new Error('Missing <file-or-text> argument. Usage: sharedrop send <file-or-text>');
  }

  const serverUrl = normalizeServerUrl(flags.server);
  const entries = collectInputFiles(targets);
  if (entries.length === 0) {
    throw new Error('No readable files found to upload.');
  }

  const totalBytes = entries.reduce((acc, item) => acc + item.size, 0);
  const response = await uploadMultipartDrop(serverUrl, entries, flags);
  const drop = response.drop || response.data || response;
  const code = drop.code || response.code;
  if (!code) {
    throw new Error(`Unexpected response from server: ${JSON.stringify(response)}`);
  }

  const directPath = drop.downloadUrl || `/d/${code}`;
  const downloadUrl = directPath.startsWith('http')
    ? directPath
    : `${serverUrl}${directPath.startsWith('/') ? '' : '/'}${directPath}`;
  const publicDownloadUrl = `${PUBLIC_DOMAIN_URL}/d/${code}`;
  const curlCommand = `curl -fSL -OJ "${downloadUrl}"`;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          code,
          downloadUrl,
          publicDownloadUrl,
          curlCommand,
          totalSize: drop.totalSize || totalBytes,
          expiresAt: drop.expiresAt || null,
          files: drop.files || entries.map((e) => ({ name: e.fileName, size: e.size })),
        },
        null,
        2
      )
    );
    return;
  }

  const qrAscii = await QRCode.toString(downloadUrl, { type: 'terminal', small: true });
  const fileSummary =
    entries.length === 1
      ? `${entries[0].fileName} (${formatBytes(totalBytes)})`
      : `${entries.length} files (${formatBytes(totalBytes)})`;

  const boxLines = [
    `${ANSI.bold}${ANSI.orange}SHAREDROP BEAM READY${ANSI.reset}`,
    ``,
    `${ANSI.bold}6-Char Drop Code :${ANSI.reset} ${ANSI.bold}${ANSI.teal}${code}${ANSI.reset}`,
    `${ANSI.bold}Payload          :${ANSI.reset} ${fileSummary}`,
    ...(flags.room ? [`${ANSI.bold}Room Radar       :${ANSI.reset} ${flags.room}`] : []),
    `${ANSI.bold}Download URL     :${ANSI.reset} ${ANSI.cyan}${downloadUrl}${ANSI.reset}`,
    `${ANSI.bold}Public Domain URL:${ANSI.reset} ${ANSI.dim}${publicDownloadUrl}${ANSI.reset}`,
    `${ANSI.bold}cURL One-Liner   :${ANSI.reset} ${ANSI.yellow}curl -OJ ${downloadUrl}${ANSI.reset}`,
    `${ANSI.bold}CLI Receive      :${ANSI.reset} ${ANSI.green}sharedrop receive ${code}${ANSI.reset}`,
  ];

  console.log('\n' + drawBox(boxLines));
  console.log(`\n${ANSI.dim}Scan QR Code with mobile camera to download directly:${ANSI.reset}`);
  console.log(qrAscii);
}

function extractFilenameFromHeaders(headers, fallbackName) {
  const disposition = headers['content-disposition'] || '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return path.basename(decodeURIComponent(utf8Match[1]));
    } catch {
      // fall through
    }
  }
  const quotedMatch = disposition.match(/filename="?([^";\r\n]+)"?/i);
  if (quotedMatch && quotedMatch[1]) {
    return path.basename(quotedMatch[1].trim());
  }
  return path.basename(fallbackName || 'sharedrop-download.bin');
}

function resolveOutputFilePath(outputOption, fileName) {
  const safeFileName = path.basename(fileName || 'sharedrop-download.bin');
  if (!outputOption) {
    return path.resolve(process.cwd(), safeFileName);
  }
  const resolvedOut = path.resolve(process.cwd(), outputOption);
  if (fs.existsSync(resolvedOut)) {
    const stat = fs.statSync(resolvedOut);
    if (stat.isDirectory()) {
      return path.join(resolvedOut, safeFileName);
    }
    return resolvedOut;
  }
  if (outputOption.endsWith('/') || outputOption.endsWith(path.sep) || path.extname(resolvedOut) === '') {
    fs.mkdirSync(resolvedOut, { recursive: true });
    return path.join(resolvedOut, safeFileName);
  }
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  return resolvedOut;
}

function downloadStream(urlString, outputOption, fallbackFileName, expectedBytes) {
  return new Promise((resolve, reject) => {
    const visit = (targetUrl, redirectsLeft = 5) => {
      const parsedUrl = new URL(targetUrl);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.get(parsedUrl, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsedUrl).toString();
          return visit(nextUrl, redirectsLeft - 1);
        }

        if (res.statusCode >= 400) {
          const errChunks = [];
          res.on('data', (c) => errChunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(errChunks).toString('utf8');
            reject(new Error(`Download failed (HTTP ${res.statusCode}): ${raw}`));
          });
          return;
        }

        const total = Number(res.headers['content-length']) || expectedBytes || 0;
        const resolvedName = extractFilenameFromHeaders(res.headers, fallbackFileName);
        const destPath = resolveOutputFilePath(outputOption, resolvedName);
        const fileStream = fs.createWriteStream(destPath);
        const hash = crypto.createHash('sha256');
        let received = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (process.stdout.isTTY && total > 0) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            process.stdout.write(
              `\r${ANSI.teal}Downloading:${ANSI.reset} ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`
            );
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          if (process.stdout.isTTY && total > 0) {
            process.stdout.write('\n');
          }
          resolve({
            savedPath: destPath,
            fileName: path.basename(destPath),
            bytesReceived: received,
            sha256: hash.digest('hex'),
          });
        });

        fileStream.on('error', reject);
      });

      req.on('error', reject);
    };

    visit(urlString);
  });
}

async function handleReceive(targets, flags) {
  const input = (targets && targets[0] ? targets[0] : '').trim();
  if (!input) {
    throw new Error('Missing <code-or-url> argument. Usage: sharedrop receive <code-or-url>');
  }

  let serverUrl = normalizeServerUrl(flags.server);
  let code = input;
  let downloadUrl = '';

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    serverUrl = `${parsed.protocol}//${parsed.host}`;
    const match = parsed.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
    if (match) {
      code = match[1].toUpperCase();
    }
    downloadUrl = input;
  } else {
    code = input.replace(/^\/?d\//i, '').toUpperCase();
    downloadUrl = `${serverUrl}/d/${encodeURIComponent(code)}`;
  }

  let meta = null;
  try {
    const metaRes = await requestJson(`${serverUrl}/api/drop/${encodeURIComponent(code)}/meta`);
    meta = metaRes.data.drop || metaRes.data.data || metaRes.data;
  } catch {
    // Allow direct stream download if metadata endpoint is skipped or custom URL
  }

  const primaryFile =
    (meta && Array.isArray(meta.files) && meta.files[0]) ||
    (meta && meta.file) ||
    null;
  const fallbackFileName =
    (primaryFile && (primaryFile.originalName || primaryFile.name)) ||
    (meta && meta.filename) ||
    `sharedrop-${code}.bin`;
  const expectedSize = (meta && meta.totalSize) || (primaryFile && primaryFile.size) || 0;

  if (!flags.json && meta) {
    console.log(
      `${ANSI.bold}${ANSI.orange}ShareDrop Receive${ANSI.reset} — Drop ${ANSI.teal}${code}${ANSI.reset} (${formatBytes(expectedSize)})`
    );
  }

  const result = await downloadStream(downloadUrl, flags.output, fallbackFileName, expectedSize);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          code,
          savedPath: result.savedPath,
          fileName: result.fileName,
          bytesReceived: result.bytesReceived,
          sha256: result.sha256,
        },
        null,
        2
      )
    );
    return;
  }

  const lines = [
    `${ANSI.bold}${ANSI.green}DOWNLOAD COMPLETE${ANSI.reset}`,
    ``,
    `${ANSI.bold}Drop Code :${ANSI.reset} ${ANSI.teal}${code}${ANSI.reset}`,
    `${ANSI.bold}Saved To  :${ANSI.reset} ${result.savedPath}`,
    `${ANSI.bold}Size      :${ANSI.reset} ${formatBytes(result.bytesReceived)}`,
    `${ANSI.bold}SHA-256   :${ANSI.reset} ${ANSI.dim}${result.sha256}${ANSI.reset}`,
  ];
  console.log('\n' + drawBox(lines));
}

async function handleStatus(flags) {
  const serverUrl = normalizeServerUrl(flags.server);
  const [healthRes, configRes] = await Promise.all([
    requestJson(`${serverUrl}/api/health`),
    requestJson(`${serverUrl}/api/config`),
  ]);

  const health = healthRes.data.data || healthRes.data;
  const config = configRes.data.data || configRes.data;

  const statusPayload = {
    status: health.status || 'ok',
    serverUrl,
    lanUrl: config.lanUrl || health.lanUrl || serverUrl,
    publicUrl: config.publicUrl || health.publicUrl || PUBLIC_DOMAIN_URL,
    activePeers:
      typeof health.activePeers === 'number'
        ? health.activePeers
        : typeof health.peers === 'number'
          ? health.peers
          : config.activePeers || 0,
    activeDrops:
      typeof health.activeDrops === 'number'
        ? health.activeDrops
        : typeof health.drops === 'number'
          ? health.drops
          : config.activeDrops || 0,
    uptimeSeconds: Math.round(health.uptime || 0),
  };

  if (flags.json) {
    console.log(JSON.stringify(statusPayload, null, 2));
    return;
  }

  const lines = [
    `${ANSI.bold}${ANSI.orange}SHAREDROP SERVER STATUS${ANSI.reset}`,
    ``,
    `${ANSI.bold}Health       :${ANSI.reset} ${ANSI.green}${ String(statusPayload.status).toUpperCase() }${ANSI.reset}`,
    `${ANSI.bold}Target Server:${ANSI.reset} ${statusPayload.serverUrl}`,
    `${ANSI.bold}LAN URL      :${ANSI.reset} ${ANSI.cyan}${statusPayload.lanUrl}${ANSI.reset}`,
    `${ANSI.bold}Public URL   :${ANSI.reset} ${ANSI.teal}${statusPayload.publicUrl}${ANSI.reset}`,
    `${ANSI.bold}Active Peers :${ANSI.reset} ${statusPayload.activePeers}`,
    `${ANSI.bold}Active Drops :${ANSI.reset} ${statusPayload.activeDrops}`,
    `${ANSI.bold}Uptime       :${ANSI.reset} ${statusPayload.uptimeSeconds}s`,
  ];
  console.log('\n' + drawBox(lines));
}

async function main(argv = process.argv) {
  const { command, targets, flags } = parseArgs(argv);

  if (!command || command === 'help' || flags.help) {
    printHelp();
    return;
  }

  if (command === 'send') {
    await handleSend(targets, flags);
  } else if (command === 'receive' || command === 'get' || command === 'download') {
    await handleReceive(targets, flags);
  } else if (command === 'status' || command === 'health') {
    await handleStatus(flags);
  } else {
    throw new Error(`Unknown command "${command}". Run "sharedrop --help" for usage.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${ANSI.red}${ANSI.bold}Error:${ANSI.reset} ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  formatBytes,
  normalizeServerUrl,
};
