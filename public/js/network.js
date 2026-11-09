const STORAGE_KEYS = {
  DISPLAY_NAME: 'sharedrop_display_name',
  PAIR_SECRETS: 'sharedrop_pair_secrets',
  AUTO_ACCEPT_PAIRED: 'sharedrop_auto_accept_paired'
};

const HEADER_FIELD_LEN = 36;
const BINARY_HEADER_LEN = HEADER_FIELD_LEN * 2; // 72 bytes
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

function padAscii36(value) {
  const str = String(value || '').slice(0, HEADER_FIELD_LEN).padEnd(HEADER_FIELD_LEN, ' ');
  return textEncoder.encode(str);
}

export class SignalingClient {
  constructor(options = {}) {
    this.ws = null;
    this.listeners = new Map();
    this.connected = false;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.maxBackoffMs = 8000;

    this.selfPeer = null;
    this.peers = new Map();
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.lanUrl = window.location.origin;
    this.publicUrl = 'https://sharedrop.sarthakml.in';
    this.roomCode = options.roomCode || this._extractUrlRoomCode() || null;

    this.displayName = this._loadDisplayName();
    this.pairSecrets = this._loadPairSecrets();
    this.autoAcceptPaired = this._loadAutoAcceptPaired();
  }

  _extractUrlRoomCode() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('room');
      return code ? code.trim().toUpperCase().slice(0, 8) : null;
    } catch {
      return null;
    }
  }

  _loadDisplayName() {
    try {
      return localStorage.getItem(STORAGE_KEYS.DISPLAY_NAME) || '';
    } catch {
      return '';
    }
  }

  _saveDisplayName(name) {
    this.displayName = String(name || '').trim().slice(0, 40);
    try {
      if (this.displayName) {
        localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, this.displayName);
      } else {
        localStorage.removeItem(STORAGE_KEYS.DISPLAY_NAME);
      }
    } catch {
      // Ignore storage quota errors
    }
  }

  _loadPairSecrets() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PAIR_SECRETS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((s) => typeof s === 'string' && s.length >= 16).slice(0, 32);
    } catch {
      return [];
    }
  }

  _savePairSecrets() {
    try {
      localStorage.setItem(STORAGE_KEYS.PAIR_SECRETS, JSON.stringify(this.pairSecrets));
    } catch {
      // Ignore storage errors
    }
  }

  _loadAutoAcceptPaired() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AUTO_ACCEPT_PAIRED);
      if (raw === null) return true; // Default true for trusted paired devices
      return raw === 'true';
    } catch {
      return true;
    }
  }

  setAutoAcceptPaired(enabled) {
    this.autoAcceptPaired = Boolean(enabled);
    try {
      localStorage.setItem(STORAGE_KEYS.AUTO_ACCEPT_PAIRED, String(this.autoAcceptPaired));
    } catch {
      // Ignore
    }
    this.emit('settings-updated', { autoAcceptPaired: this.autoAcceptPaired });
  }

  addPairSecret(secret) {
    if (!secret || typeof secret !== 'string') return;
    if (!this.pairSecrets.includes(secret)) {
      this.pairSecrets.push(secret);
      if (this.pairSecrets.length > 32) {
        this.pairSecrets = this.pairSecrets.slice(-32);
      }
      this._savePairSecrets();
      this.emit('pair-secrets-changed', this.pairSecrets);
    }
  }

  clearPairSecrets() {
    this.pairSecrets = [];
    this._savePairSecrets();
    this.emit('pair-secrets-changed', this.pairSecrets);
    if (this.connected) {
      this.reconnectNow();
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[SignalingClient] Error in ${event} listener:`, err);
      }
    }
  }

  getWsUrl() {
    if (window.SHAREDROP_WS_URL) {
      return window.SHAREDROP_WS_URL;
    }
    const host = window.location.hostname || '';
    if (host.endsWith('.netlify.app') || this._useCloudWsFallback) {
      return 'wss://sharedrop-production.up.railway.app/ws';
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  connect() {
    this.intentionalClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    if (this.reconnectAttempts >= 1 && window.location.hostname && !window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1')) {
      this._useCloudWsFallback = true;
    }
    const wsUrl = this.getWsUrl();

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.sendJson({
        type: 'join-init',
        displayName: this.displayName || undefined,
        pairSecrets: this.pairSecrets,
        roomCode: this.roomCode || undefined
      });
      this.emit('connected');
    });

    this.ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        this._handleJsonMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this._handleBinaryMessage(event.data);
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buf) => this._handleBinaryMessage(buf)).catch(() => {});
      }
    });

    this.ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      if (!this.intentionalClose) {
        this._scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      // Browser fires 'close' right after 'error'
    });
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  reconnectNow() {
    this.disconnect();
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const exp = Math.min(this.reconnectAttempts, 3); // 1s, 2s, 4s, 8s
    const delay = Math.min(1000 * Math.pow(2, exp), this.maxBackoffMs);
    this.reconnectAttempts += 1;
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  _handleJsonMessage(rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'welcome': {
        this.selfPeer = msg.peer || this.selfPeer;
        if (this.selfPeer && this.selfPeer.displayName && !this.displayName) {
          this.displayName = this.selfPeer.displayName;
        }
        if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
          this.iceServers = msg.iceServers;
        }
        if (msg.lanUrl) this.lanUrl = msg.lanUrl;
        if (msg.publicUrl) this.publicUrl = msg.publicUrl;
        if (msg.peer && msg.peer.roomCode) {
          this.roomCode = msg.peer.roomCode;
        }
        this._syncPeerList(msg.peers || []);
        this.emit('welcome', msg);
        break;
      }

      case 'peers': {
        this._syncPeerList(msg.peers || []);
        this.emit('peers', Array.from(this.peers.values()));
        break;
      }

      case 'peer-joined': {
        if (msg.peer && msg.peer.id) {
          const peerObj = {
            ...msg.peer,
            sharedVia: msg.sharedVia || msg.peer.sharedVia || 'lan'
          };
          this.peers.set(peerObj.id, peerObj);
          this.emit('peer-joined', peerObj);
          this.emit('peers', Array.from(this.peers.values()));
        }
        break;
      }

      case 'peer-left': {
        if (msg.peerId && this.peers.has(msg.peerId)) {
          const departed = this.peers.get(msg.peerId);
          this.peers.delete(msg.peerId);
          this.emit('peer-left', { peerId: msg.peerId, peer: departed });
          this.emit('peers', Array.from(this.peers.values()));
        }
        break;
      }

      case 'peer-updated': {
        if (msg.peer && msg.peer.id) {
          if (this.selfPeer && msg.peer.id === this.selfPeer.id) {
            this.selfPeer = { ...this.selfPeer, ...msg.peer };
            this.emit('self-updated', this.selfPeer);
          } else {
            const existing = this.peers.get(msg.peer.id) || {};
            const updated = { ...existing, ...msg.peer };
            this.peers.set(msg.peer.id, updated);
            this.emit('peer-updated', updated);
            this.emit('peers', Array.from(this.peers.values()));
          }
        }
        break;
      }

      case 'pair-code-created': {
        this.emit('pair-code-created', msg);
        break;
      }

      case 'pair-success': {
        if (msg.pairSecret) {
          this.addPairSecret(msg.pairSecret);
        }
        if (msg.peer && msg.peer.id) {
          const peerObj = { ...msg.peer, sharedVia: 'paired' };
          this.peers.set(peerObj.id, peerObj);
          this.emit('peers', Array.from(this.peers.values()));
        }
        this.emit('pair-success', msg);
        break;
      }

      case 'room-joined': {
        this.roomCode = msg.roomCode || null;
        if (Array.isArray(msg.peers)) {
          this._syncPeerList(msg.peers);
        }
        this.emit('room-joined', msg);
        break;
      }

      case 'room-left': {
        this.roomCode = null;
        if (Array.isArray(msg.peers)) {
          this._syncPeerList(msg.peers);
        }
        this.emit('room-left', msg);
        break;
      }

      case 'signal':
      case 'file-offer':
      case 'file-response':
      case 'transfer-cancel':
      case 'text-beam':
      case 'ws-chunk-meta':
      case 'ws-chunk-ack':
      case 'drop-available':
      case 'error': {
        this.emit(msg.type, msg);
        break;
      }

      default: {
        this.emit(msg.type, msg);
        break;
      }
    }
  }

  _syncPeerList(peerArray) {
    this.peers.clear();
    for (const p of peerArray) {
      if (p && p.id && (!this.selfPeer || p.id !== this.selfPeer.id)) {
        this.peers.set(p.id, p);
      }
    }
  }

  _handleBinaryMessage(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < BINARY_HEADER_LEN) {
      return;
    }
    const headerBytes = new Uint8Array(arrayBuffer, 0, BINARY_HEADER_LEN);
    const senderId = textDecoder.decode(headerBytes.subarray(0, HEADER_FIELD_LEN)).trim();
    const transferId = textDecoder.decode(headerBytes.subarray(HEADER_FIELD_LEN, BINARY_HEADER_LEN)).trim();
    const chunkBuffer = arrayBuffer.slice(BINARY_HEADER_LEN);

    if (!senderId || !transferId) return;

    this.emit('ws-binary-chunk', {
      senderId,
      transferId,
      chunk: chunkBuffer
    });
  }

  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error('[SignalingClient] Failed to send JSON:', err);
      return false;
    }
  }

  updateDisplayName(name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return false;
    this._saveDisplayName(clean);
    if (this.selfPeer) {
      this.selfPeer.displayName = clean;
      this.emit('self-updated', this.selfPeer);
    }
    return this.sendJson({
      type: 'update-profile',
      displayName: clean
    });
  }

  createPairCode() {
    return this.sendJson({ type: 'create-pair-code' });
  }

  joinPairCode(code) {
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) return false;
    return this.sendJson({
      type: 'join-pair-code',
      code: clean
    });
  }

  createRoom() {
    return this.sendJson({ type: 'create-room' });
  }

  joinRoom(code) {
    const clean = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!clean) return false;
    this.roomCode = clean;
    return this.sendJson({
      type: 'join-room',
      roomCode: clean
    });
  }

  leaveRoom() {
    this.roomCode = null;
    return this.sendJson({ type: 'leave-room' });
  }

  sendSignal(targetId, signal) {
    return this.sendJson({
      type: 'signal',
      targetId,
      signal
    });
  }

  sendFileOffer(targetId, transferId, filesMeta, totalSize, mode = 'webrtc') {
    return this.sendJson({
      type: 'file-offer',
      targetId,
      transferId,
      files: filesMeta,
      totalSize,
      mode
    });
  }

  sendFileResponse(targetId, transferId, accepted) {
    return this.sendJson({
      type: 'file-response',
      targetId,
      transferId,
      accepted: Boolean(accepted)
    });
  }

  sendTransferCancel(targetId, transferId, reason = 'user-cancelled') {
    return this.sendJson({
      type: 'transfer-cancel',
      targetId,
      transferId,
      reason
    });
  }

  sendTextBeam(targetId, text) {
    const trimmed = String(text || '');
    if (!trimmed) return false;
    const id = `txt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.sendJson({
      type: 'text-beam',
      targetId,
      id,
      text: trimmed
    });
  }

  sendWsChunkMeta(targetId, transferId, meta) {
    return this.sendJson({
      type: 'ws-chunk-meta',
      targetId,
      transferId,
      ...meta
    });
  }

  sendWsChunkAck(targetId, transferId, offset) {
    return this.sendJson({
      type: 'ws-chunk-ack',
      targetId,
      transferId,
      offset
    });
  }

  sendWsBinaryChunk(targetId, transferId, arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payloadBytes = arrayBuffer instanceof Uint8Array
      ? arrayBuffer
      : new Uint8Array(arrayBuffer);

    const frame = new Uint8Array(BINARY_HEADER_LEN + payloadBytes.byteLength);
    frame.set(padAscii36(targetId), 0);
    frame.set(padAscii36(transferId), HEADER_FIELD_LEN);
    frame.set(payloadBytes, BINARY_HEADER_LEN);

    try {
      this.ws.send(frame.buffer);
      return true;
    } catch (err) {
      console.error('[SignalingClient] Failed to send WS binary chunk:', err);
      return false;
    }
  }

  getBufferedAmount() {
    return this.ws ? this.ws.bufferedAmount || 0 : 0;
  }
}
