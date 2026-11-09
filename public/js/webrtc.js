/**
 * WebRTC & WebSocket Chunk Streaming Engine
 * 64KB chunk streaming, flow control (bufferedAmountLowThreshold: 512KB)
 * Multi-file support, automatic 6-second timeout fallback to WebSocket binary relay
 */

const CHUNK_SIZE = 64 * 1024; // 64 KB
const BUFFERED_AMOUNT_LOW_THRESHOLD = 512 * 1024; // 512 KB
const RTC_CONNECT_TIMEOUT_MS = 6000; // 6s timeout before WS relay fallback
const DATA_CHANNEL_LABEL = 'sharedrop-data';

export class TransferManager {
  /**
   * @param {import('./network.js').SignalingClient} signaling
   * @param {object} options
   */
  constructor(signaling, options = {}) {
    this.signaling = signaling;
    this.options = options;

    /** @type {Map<string, RTCPeerConnection>} key: targetPeerId */
    this.peerConnections = new Map();
    /** @type {Map<string, RTCDataChannel>} key: targetPeerId */
    this.dataChannels = new Map();
    /** @type {Map<string, any>} key: targetPeerId (timeout timer) */
    this.connectTimeouts = new Map();

    /**
     * Active transfers
     * @type {Map<string, {
     *   id: string,
     *   peerId: string,
     *   direction: 'send'|'receive',
     *   mode: 'webrtc'|'ws-relay',
     *   files: Array<any>,
     *   totalSize: number,
     *   bytesTransferred: number,
     *   currentFileIndex: number,
     *   status: 'pending'|'transferring'|'completed'|'cancelled'|'failed',
     *   abortController?: AbortController,
     *   receivedChunks?: Array<ArrayBuffer>,
     *   currentFileBytesReceived?: number,
     *   startTime?: number,
     *   lastSpeedSampleTime?: number,
     *   lastSpeedSampleBytes?: number,
     *   speed?: number
     * }>}
     */
    this.transfers = new Map();

    this.listeners = new Map();

    this._bindSignalingEvents();
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
    if (set) set.delete(handler);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[TransferManager] Error in ${event} listener:`, err);
      }
    }
  }

  _bindSignalingEvents() {
    this.signaling.on('signal', async ({ senderId, signal }) => {
      await this._handleSignal(senderId, signal);
    });

    this.signaling.on('file-response', async ({ senderId, transferId, accepted }) => {
      const tx = this.transfers.get(transferId);
      if (!tx || tx.direction !== 'send') return;

      if (!accepted) {
        tx.status = 'cancelled';
        this.emit('transfer-declined', { transferId, peerId: senderId });
        this.emit('transfer-progress', { ...tx });
        this._cleanupTransfer(transferId);
        return;
      }

      this.emit('transfer-accepted', { transferId, peerId: senderId });
      // Start transferring files
      this._startSending(transferId);
    });

    this.signaling.on('transfer-cancel', ({ senderId, transferId, reason }) => {
      const tx = this.transfers.get(transferId);
      if (tx) {
        tx.status = 'cancelled';
        if (tx.abortController) tx.abortController.abort();
        this.emit('transfer-cancelled', { transferId, peerId: senderId, reason });
        this.emit('transfer-progress', { ...tx });
        this._cleanupTransfer(transferId);
      }
    });

    this.signaling.on('ws-chunk-meta', ({ senderId, transferId, fileIndex, offset, size, eof }) => {
      this._handleWsChunkMeta(senderId, transferId, { fileIndex, offset, size, eof });
    });

    this.signaling.on('ws-chunk-ack', ({ senderId, transferId, offset }) => {
      this.emit(`ws-ack-${transferId}-${offset}`, { offset });
    });

    this.signaling.on('ws-binary-chunk', ({ senderId, transferId, chunk }) => {
      this._handleIncomingChunk(transferId, chunk);
    });

    this.signaling.on('peer-left', ({ peerId }) => {
      this._closePeerConnection(peerId);
      for (const [txId, tx] of this.transfers.entries()) {
        if (tx.peerId === peerId && tx.status === 'transferring') {
          tx.status = 'failed';
          if (tx.abortController) tx.abortController.abort();
          this.emit('transfer-failed', { transferId: txId, peerId, error: 'Peer disconnected' });
          this._cleanupTransfer(txId);
        }
      }
    });
  }

  /* ------------------------------------------------------------- */
  /* RTCPeerConnection & DataChannel Setup                         */
  /* ------------------------------------------------------------- */

  _getOrCreatePeerConnection(targetPeerId) {
    if (this.peerConnections.has(targetPeerId)) {
      return this.peerConnections.get(targetPeerId);
    }

    const config = {
      iceServers: this.signaling.iceServers && this.signaling.iceServers.length > 0
        ? this.signaling.iceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendSignal(targetPeerId, {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this._clearConnectTimeout(targetPeerId);
      } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this._closePeerConnection(targetPeerId);
      }
    };

    pc.ondatachannel = (event) => {
      this._setupDataChannel(targetPeerId, event.channel);
    };

    this.peerConnections.set(targetPeerId, pc);
    return pc;
  }

  _setupDataChannel(targetPeerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    dc.onopen = () => {
      this._clearConnectTimeout(targetPeerId);
      this.emit('datachannel-open', { peerId: targetPeerId });
    };

    dc.onclose = () => {
      this.dataChannels.delete(targetPeerId);
      this.emit('datachannel-close', { peerId: targetPeerId });
    };

    dc.onerror = (err) => {
      console.warn(`[TransferManager] DataChannel error with ${targetPeerId}:`, err);
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          this._handleDataChannelMessage(targetPeerId, msg);
        } catch {
          // ignore
        }
      } else if (event.data instanceof ArrayBuffer) {
        this._handleDataChannelBinary(targetPeerId, event.data);
      }
    };

    this.dataChannels.set(targetPeerId, dc);
  }

  _clearConnectTimeout(peerId) {
    if (this.connectTimeouts.has(peerId)) {
      clearTimeout(this.connectTimeouts.get(peerId));
      this.connectTimeouts.delete(peerId);
    }
  }

  _closePeerConnection(peerId) {
    this._clearConnectTimeout(peerId);
    if (this.dataChannels.has(peerId)) {
      try { this.dataChannels.get(peerId).close(); } catch {}
      this.dataChannels.delete(peerId);
    }
    if (this.peerConnections.has(peerId)) {
      try { this.peerConnections.get(peerId).close(); } catch {}
      this.peerConnections.delete(peerId);
    }
  }

  async _handleSignal(senderId, signal) {
    if (!signal) return;
    const pc = this._getOrCreatePeerConnection(senderId);

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signaling.sendSignal(senderId, answer);
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.type === 'candidate' && signal.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (candErr) {
          // Candidate can race with remote description
        }
      }
    } catch (err) {
      console.warn(`[TransferManager] Signaling error handling signal from ${senderId}:`, err);
    }
  }

  /**
   * Ensures WebRTC DataChannel connection is ready or initiates fallback
   */
  async _ensureDataChannel(targetPeerId) {
    const existing = this.dataChannels.get(targetPeerId);
    if (existing && existing.readyState === 'open') {
      return 'webrtc';
    }

    return new Promise((resolve) => {
      let resolved = false;
      const pc = this._getOrCreatePeerConnection(targetPeerId);

      // Create data channel if we are initiator
      let dc = this.dataChannels.get(targetPeerId);
      if (!dc) {
        dc = pc.createDataChannel(DATA_CHANNEL_LABEL, {
          ordered: true
        });
        this._setupDataChannel(targetPeerId, dc);
      }

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn(`[TransferManager] WebRTC timeout with ${targetPeerId} (6s). Falling back to WebSocket relay.`);
          resolve('ws-relay');
        }
      }, RTC_CONNECT_TIMEOUT_MS);
      this.connectTimeouts.set(targetPeerId, timer);

      const checkOpen = () => {
        if (dc.readyState === 'open') {
          if (!resolved) {
            resolved = true;
            this._clearConnectTimeout(targetPeerId);
            resolve('webrtc');
          }
        }
      };

      if (dc.readyState === 'open') {
        checkOpen();
        return;
      }

      dc.addEventListener('open', checkOpen, { once: true });

      // Trigger WebRTC offer if new connection
      if (pc.signalingState === 'stable') {
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            this.signaling.sendSignal(targetPeerId, pc.localDescription);
          })
          .catch((err) => {
            console.warn('[TransferManager] Error creating offer:', err);
            if (!resolved) {
              resolved = true;
              this._clearConnectTimeout(targetPeerId);
              resolve('ws-relay');
            }
          });
      }
    });
  }

  /* ------------------------------------------------------------- */
  /* Outgoing Transfers                                            */
  /* ------------------------------------------------------------- */

  /**
   * Initiate file transfer to a peer
   * @param {string} targetPeerId
   * @param {FileList|Array<File>} files
   */
  async sendFiles(targetPeerId, files) {
    const fileList = Array.from(files || []);
    if (fileList.length === 0) return null;

    const transferId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const totalSize = fileList.reduce((sum, f) => sum + (f.size || 0), 0);

    const filesMeta = fileList.map((f, idx) => ({
      index: idx,
      name: f.name || `file-${idx}`,
      size: f.size || 0,
      type: f.type || 'application/octet-stream',
      webkitRelativePath: f.webkitRelativePath || ''
    }));

    const tx = {
      id: transferId,
      peerId: targetPeerId,
      direction: 'send',
      mode: 'webrtc',
      files: fileList,
      filesMeta,
      totalSize,
      bytesTransferred: 0,
      currentFileIndex: 0,
      status: 'pending',
      abortController: new AbortController(),
      startTime: Date.now(),
      lastSpeedSampleTime: Date.now(),
      lastSpeedSampleBytes: 0,
      speed: 0
    };
    this.transfers.set(transferId, tx);

    this.emit('transfer-started', { ...tx });

    // Establish channel (or fallback)
    const mode = await this._ensureDataChannel(targetPeerId);
    tx.mode = mode;

    // Send file offer to peer
    this.signaling.sendFileOffer(targetPeerId, transferId, filesMeta, totalSize, mode);
    return transferId;
  }

  async _startSending(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx || tx.status !== 'pending') return;

    tx.status = 'transferring';
    tx.startTime = Date.now();
    tx.lastSpeedSampleTime = Date.now();
    tx.lastSpeedSampleBytes = 0;
    this.emit('transfer-progress', { ...tx });

    try {
      for (let i = 0; i < tx.files.length; i++) {
        if (tx.abortController.signal.aborted) break;
        tx.currentFileIndex = i;
        const file = tx.files[i];
        await this._sendFile(tx, file, i);
      }

      if (!tx.abortController.signal.aborted) {
        tx.status = 'completed';
        this.emit('transfer-completed', { ...tx });
        this._cleanupTransfer(transferId);
      }
    } catch (err) {
      if (!tx.abortController.signal.aborted) {
        tx.status = 'failed';
        this.emit('transfer-failed', { transferId, peerId: tx.peerId, error: err.message });
        this._cleanupTransfer(transferId);
      }
    }
  }

  async _sendFile(tx, file, fileIndex) {
    const fileSize = file.size;
    let offset = 0;

    // Notify receiver about beginning of this file
    const metaPayload = {
      type: 'file-meta',
      transferId: tx.id,
      fileIndex,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      webkitRelativePath: file.webkitRelativePath || ''
    };

    if (tx.mode === 'webrtc') {
      const dc = this.dataChannels.get(tx.peerId);
      if (!dc || dc.readyState !== 'open') {
        throw new Error('DataChannel disconnected during transfer');
      }
      dc.send(JSON.stringify(metaPayload));
    } else {
      this.signaling.sendWsChunkMeta(tx.peerId, tx.id, {
        fileIndex,
        offset: 0,
        size: fileSize,
        eof: false,
        name: file.name,
        mimeType: file.type,
        webkitRelativePath: file.webkitRelativePath
      });
    }

    if (fileSize === 0) {
      // Empty file
      if (tx.mode === 'webrtc') {
        const dc = this.dataChannels.get(tx.peerId);
        dc.send(JSON.stringify({ type: 'file-end', transferId: tx.id, fileIndex }));
      } else {
        this.signaling.sendWsChunkMeta(tx.peerId, tx.id, {
          fileIndex,
          offset: 0,
          size: 0,
          eof: true
        });
      }
      return;
    }

    while (offset < fileSize) {
      if (tx.abortController.signal.aborted) return;

      const sliceEnd = Math.min(offset + CHUNK_SIZE, fileSize);
      const sliceBlob = file.slice(offset, sliceEnd);
      const chunkBuffer = await sliceBlob.arrayBuffer();

      if (tx.mode === 'webrtc') {
        await this._sendRtcChunk(tx.peerId, tx.id, fileIndex, offset, chunkBuffer);
      } else {
        await this._sendWsChunk(tx.peerId, tx.id, fileIndex, offset, chunkBuffer);
      }

      offset += chunkBuffer.byteLength;
      tx.bytesTransferred += chunkBuffer.byteLength;

      // Calculate transfer speed
      const now = Date.now();
      const elapsedSec = (now - tx.lastSpeedSampleTime) / 1000;
      if (elapsedSec >= 0.5) {
        const deltaBytes = tx.bytesTransferred - tx.lastSpeedSampleBytes;
        tx.speed = deltaBytes / elapsedSec; // bytes/sec
        tx.lastSpeedSampleTime = now;
        tx.lastSpeedSampleBytes = tx.bytesTransferred;
      }

      this.emit('transfer-progress', { ...tx });
    }

    // End of file marker
    if (tx.mode === 'webrtc') {
      const dc = this.dataChannels.get(tx.peerId);
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'file-end', transferId: tx.id, fileIndex }));
      }
    } else {
      this.signaling.sendWsChunkMeta(tx.peerId, tx.id, {
        fileIndex,
        offset,
        size: 0,
        eof: true
      });
    }
  }

  async _sendRtcChunk(targetPeerId, transferId, fileIndex, offset, chunkBuffer) {
    const dc = this.dataChannels.get(targetPeerId);
    if (!dc || dc.readyState !== 'open') {
      throw new Error('DataChannel closed unexpectedly');
    }

    // Header prefix for chunk: [4 bytes transferId length, transferId, 4 bytes fileIndex, 8 bytes offset]
    // Or we send a binary frame with a compact 44-byte binary header:
    // [36 bytes ASCII transferId][4 bytes fileIndex Uint32][4 bytes offset Uint32][chunk]
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const enc = new TextEncoder();
    const idBytes = enc.encode(transferId.slice(0, 36).padEnd(36, ' '));
    new Uint8Array(header).set(idBytes, 0);
    view.setUint32(36, fileIndex);
    view.setUint32(40, offset);

    const fullFrame = new Uint8Array(header.byteLength + chunkBuffer.byteLength);
    fullFrame.set(new Uint8Array(header), 0);
    fullFrame.set(new Uint8Array(chunkBuffer), header.byteLength);

    // Flow control backpressure: wait if bufferedAmount exceeds threshold
    if (dc.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
      await new Promise((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', onLow);
      });
    }

    dc.send(fullFrame.buffer);
  }

  async _sendWsChunk(targetPeerId, transferId, fileIndex, offset, chunkBuffer) {
    // Send binary chunk over WebSocket relay
    this.signaling.sendWsBinaryChunk(targetPeerId, transferId, chunkBuffer);

    // Flow control: wait for client WS socket buffer or server ack if heavily queued
    if (this.signaling.getBufferedAmount() > BUFFERED_AMOUNT_LOW_THRESHOLD) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  /* ------------------------------------------------------------- */
  /* Incoming Transfers                                            */
  /* ------------------------------------------------------------- */

  /**
   * Called when peer initiates a file offer
   */
  handleIncomingOffer(offer) {
    const { senderId, sender, transferId, files, totalSize, mode } = offer;

    const tx = {
      id: transferId,
      peerId: senderId,
      sender,
      direction: 'receive',
      mode: mode || 'webrtc',
      files: files || [],
      totalSize: totalSize || 0,
      bytesTransferred: 0,
      currentFileIndex: 0,
      status: 'pending',
      abortController: new AbortController(),
      receivedChunks: [],
      currentFileBytesReceived: 0,
      downloadedBlobs: [],
      startTime: Date.now(),
      lastSpeedSampleTime: Date.now(),
      lastSpeedSampleBytes: 0,
      speed: 0
    };

    this.transfers.set(transferId, tx);

    const autoAccept = this.signaling.autoAcceptPaired && (sender && sender.sharedVia === 'paired');

    this.emit('incoming-offer', {
      transferId,
      peerId: senderId,
      sender,
      files,
      totalSize,
      mode,
      autoAccept
    });

    if (autoAccept) {
      this.respondToOffer(transferId, true);
    }
  }

  respondToOffer(transferId, accepted) {
    const tx = this.transfers.get(transferId);
    if (!tx || tx.status !== 'pending') return;

    if (!accepted) {
      tx.status = 'cancelled';
      this.signaling.sendFileResponse(tx.peerId, transferId, false);
      this._cleanupTransfer(transferId);
      return;
    }

    tx.status = 'transferring';
    tx.startTime = Date.now();
    tx.lastSpeedSampleTime = Date.now();
    tx.lastSpeedSampleBytes = 0;
    this.signaling.sendFileResponse(tx.peerId, transferId, true);
    this.emit('transfer-progress', { ...tx });
  }

  cancelTransfer(transferId, reason = 'user-cancelled') {
    const tx = this.transfers.get(transferId);
    if (!tx) return;

    tx.status = 'cancelled';
    if (tx.abortController) tx.abortController.abort();
    this.signaling.sendTransferCancel(tx.peerId, transferId, reason);
    this.emit('transfer-cancelled', { transferId, peerId: tx.peerId, reason });
    this._cleanupTransfer(transferId);
  }

  _handleDataChannelMessage(peerId, msg) {
    if (!msg || !msg.transferId) return;
    const tx = this.transfers.get(msg.transferId);
    if (!tx) return;

    if (msg.type === 'file-meta') {
      tx.currentFileIndex = msg.fileIndex;
      tx.receivedChunks = [];
      tx.currentFileBytesReceived = 0;
    } else if (msg.type === 'file-end') {
      this._finalizeReceivedFile(tx, msg.fileIndex);
    }
  }

  _handleDataChannelBinary(peerId, arrayBuffer) {
    if (arrayBuffer.byteLength < 44) return;
    const headerView = new DataView(arrayBuffer, 0, 44);
    const enc = new TextDecoder('utf-8');
    const transferId = enc.decode(new Uint8Array(arrayBuffer, 0, 36)).trim();
    const fileIndex = headerView.getUint32(36);
    const offset = headerView.getUint32(40);
    const chunkData = arrayBuffer.slice(44);

    this._processIncomingChunk(transferId, fileIndex, offset, chunkData);
  }

  _handleWsChunkMeta(senderId, transferId, meta) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;

    if (meta.eof) {
      this._finalizeReceivedFile(tx, meta.fileIndex);
    } else {
      tx.currentFileIndex = meta.fileIndex;
    }
  }

  _handleIncomingChunk(transferId, chunkBuffer) {
    const tx = this.transfers.get(transferId);
    if (!tx || tx.status !== 'transferring') return;

    this._processIncomingChunk(transferId, tx.currentFileIndex, tx.currentFileBytesReceived, chunkBuffer);
  }

  _processIncomingChunk(transferId, fileIndex, offset, chunkData) {
    const tx = this.transfers.get(transferId);
    if (!tx || tx.status !== 'transferring') return;

    if (!tx.receivedChunks) tx.receivedChunks = [];
    tx.receivedChunks.push(chunkData);
    tx.currentFileBytesReceived += chunkData.byteLength;
    tx.bytesTransferred += chunkData.byteLength;

    const now = Date.now();
    const elapsedSec = (now - tx.lastSpeedSampleTime) / 1000;
    if (elapsedSec >= 0.5) {
      const deltaBytes = tx.bytesTransferred - tx.lastSpeedSampleBytes;
      tx.speed = deltaBytes / elapsedSec;
      tx.lastSpeedSampleTime = now;
      tx.lastSpeedSampleBytes = tx.bytesTransferred;
    }

    this.emit('transfer-progress', { ...tx });
  }

  _finalizeReceivedFile(tx, fileIndex) {
    const meta = (tx.files && tx.files[fileIndex]) || {};
    const mimeType = meta.type || 'application/octet-stream';
    const blob = new Blob(tx.receivedChunks || [], { type: mimeType });

    if (!tx.downloadedBlobs) tx.downloadedBlobs = [];
    tx.downloadedBlobs.push({
      blob,
      name: meta.name || `download-${fileIndex}`,
      size: blob.size,
      mimeType,
      webkitRelativePath: meta.webkitRelativePath || ''
    });

    tx.receivedChunks = [];
    tx.currentFileBytesReceived = 0;

    // Trigger auto-download in browser
    this._triggerBrowserDownload(blob, meta.name || `download-${fileIndex}`);

    // If last file, mark transfer completed
    if (fileIndex >= tx.files.length - 1 || tx.bytesTransferred >= tx.totalSize) {
      tx.status = 'completed';
      this.emit('transfer-completed', { ...tx });
      this._cleanupTransfer(tx.id);
    }
  }

  _triggerBrowserDownload(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
    } catch (err) {
      console.error('[TransferManager] Failed to trigger download:', err);
    }
  }

  _cleanupTransfer(transferId) {
    setTimeout(() => {
      // Retain transfer object in history without massive memory blobs
      const tx = this.transfers.get(transferId);
      if (tx) {
        delete tx.receivedChunks;
        delete tx.downloadedBlobs;
        delete tx.files;
      }
    }, 5000);
  }

  getTransfer(id) {
    return this.transfers.get(id);
  }

  getAllTransfers() {
    return Array.from(this.transfers.values());
  }
}
