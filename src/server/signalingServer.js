'use strict';

const WebSocket = require('ws');
const { extractClientIp, generatePeerIdentity } = require('./identity');

const HEADER_FIELD_LEN = 36;
const BINARY_HEADER_LEN = HEADER_FIELD_LEN * 2; // 72 bytes

function sendJson(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    return false;
  }
}

function sendBinary(ws, buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(buffer);
    return true;
  } catch (err) {
    return false;
  }
}

function sanitizePeer(peer, sharedVia = 'lan') {
  if (!peer) return null;
  return {
    id: peer.id,
    displayName: peer.displayName,
    deviceType: peer.deviceType,
    os: peer.os,
    browser: peer.browser,
    color: peer.color,
    sharedVia,
    roomCode: peer.publicRoom || undefined,
  };
}

class SignalingServer {
  constructor(server, roomManager, config) {
    this.server = server;
    this.roomManager = roomManager;
    this.config = config;

    this.wss = new WebSocket.Server({
      server: this.server,
      path: '/ws',
      maxPayload: this.config.maxRelayBytes || 250 * 1024 * 1024,
    });

    this.setupWss();
  }

  setupWss() {
    this.wss.on('connection', (ws, req) => {
      const clientIp = extractClientIp(req);
      const userAgent = req.headers['user-agent'] || '';

      const initialIdentity = generatePeerIdentity(clientIp, userAgent);
      const peer = this.roomManager.registerPeer({
        ...initialIdentity,
        ws,
      });

      const peerId = peer.id;
      ws.peerId = peerId;

      // Send initial welcome message
      const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
      sendJson(ws, {
        type: 'welcome',
        peer: sanitizePeer(peer),
        iceServers: this.config.iceServers || [],
        lanUrl: this.config.lanUrl,
        publicUrl: this.config.publicUrl,
        peers: visiblePeers,
      });

      // Notify other visible peers that this peer joined
      this.broadcastPeerJoin(peerId);

      ws.on('message', (data, isBinary) => {
        if (isBinary || Buffer.isBuffer(data) && data.length >= BINARY_HEADER_LEN && !isJsonBuffer(data)) {
          this.handleBinaryMessage(peerId, data);
        } else {
          this.handleJsonMessage(peerId, data.toString());
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(peerId);
      });

      ws.on('error', (_err) => {
        this.handleDisconnect(peerId);
      });
    });
  }

  broadcastPeerJoin(peerId) {
    const peer = this.roomManager.getPeer(peerId);
    if (!peer) return;

    const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
    for (const visible of visiblePeers) {
      const otherPeer = this.roomManager.getPeer(visible.id);
      if (otherPeer && otherPeer.ws) {
        sendJson(otherPeer.ws, {
          type: 'peer-joined',
          peer: sanitizePeer(peer, visible.sharedVia),
          sharedVia: visible.sharedVia,
        });
      }
    }
  }

  handleDisconnect(peerId) {
    const peer = this.roomManager.getPeer(peerId);
    if (!peer) return;

    // Get peers that can see this peer before removing
    const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);

    this.roomManager.removePeer(peerId);

    // Notify connected visible peers that this peer left
    for (const visible of visiblePeers) {
      const otherPeer = this.roomManager.getPeer(visible.id);
      if (otherPeer && otherPeer.ws) {
        sendJson(otherPeer.ws, {
          type: 'peer-left',
          peerId,
        });
      }
    }
  }

  broadcastProfileUpdate(peerId) {
    const peer = this.roomManager.getPeer(peerId);
    if (!peer) return;

    const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
    for (const visible of visiblePeers) {
      const otherPeer = this.roomManager.getPeer(visible.id);
      if (otherPeer && otherPeer.ws) {
        sendJson(otherPeer.ws, {
          type: 'peer-updated',
          peer: sanitizePeer(peer, visible.sharedVia),
        });
      }
    }
  }

  handleJsonMessage(peerId, rawText) {
    const sender = this.roomManager.getPeer(peerId);
    if (!sender) return;

    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      sendJson(sender.ws, {
        type: 'error',
        code: 'INVALID_JSON',
        message: 'Message could not be parsed as JSON',
      });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      sendJson(sender.ws, {
        type: 'error',
        code: 'MISSING_TYPE',
        message: 'Message type is required',
      });
      return;
    }

    switch (msg.type) {
      case 'join-init': {
        if (typeof msg.displayName === 'string' && msg.displayName.trim()) {
          this.roomManager.updatePeerProfile(peerId, { displayName: msg.displayName });
        }
        if (Array.isArray(msg.pairSecrets) && msg.pairSecrets.length > 0) {
          this.roomManager.attachPairSecrets(peerId, msg.pairSecrets);
        }
        if (typeof msg.roomCode === 'string' && msg.roomCode.trim()) {
          this.roomManager.joinPublicRoom(peerId, msg.roomCode);
        }

        const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
        sendJson(sender.ws, {
          type: 'peers',
          peers: visiblePeers,
        });

        this.broadcastPeerJoin(peerId);
        break;
      }

      case 'update-profile': {
        if (typeof msg.displayName === 'string' && msg.displayName.trim()) {
          this.roomManager.updatePeerProfile(peerId, { displayName: msg.displayName });
          sendJson(sender.ws, {
            type: 'peer-updated',
            peer: sanitizePeer(sender),
          });
          this.broadcastProfileUpdate(peerId);
        }
        break;
      }

      case 'create-pair-code': {
        try {
          const { code, expiresAt } = this.roomManager.createPairCode(peerId);
          sendJson(sender.ws, {
            type: 'pair-code-created',
            code,
            expiresAt,
          });
        } catch (err) {
          sendJson(sender.ws, {
            type: 'error',
            code: 'PAIR_CODE_ERROR',
            message: err.message,
          });
        }
        break;
      }

      case 'join-pair-code': {
        const result = this.roomManager.redeemPairCode(peerId, msg.code);
        if (!result.success) {
          sendJson(sender.ws, {
            type: 'error',
            code: 'INVALID_PAIR_CODE',
            message: result.error || 'Failed to redeem pair code',
          });
          return;
        }

        const { pairSecret, hostPeer, clientPeer } = result;

        // Notify both peers of pairing success
        if (hostPeer && hostPeer.ws) {
          sendJson(hostPeer.ws, {
            type: 'pair-success',
            pairSecret,
            peer: sanitizePeer(clientPeer, 'paired'),
          });
        }

        sendJson(sender.ws, {
          type: 'pair-success',
          pairSecret,
          peer: sanitizePeer(hostPeer, 'paired'),
        });
        break;
      }

      case 'create-room': {
        const roomCode = this.roomManager.createPublicRoom(peerId);
        const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
        sendJson(sender.ws, {
          type: 'room-joined',
          roomCode,
          peers: visiblePeers,
        });
        this.broadcastPeerJoin(peerId);
        break;
      }

      case 'join-room': {
        const success = this.roomManager.joinPublicRoom(peerId, msg.roomCode);
        if (success) {
          const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
          sendJson(sender.ws, {
            type: 'room-joined',
            roomCode: sender.publicRoom,
            peers: visiblePeers,
          });
          this.broadcastPeerJoin(peerId);
        } else {
          sendJson(sender.ws, {
            type: 'error',
            code: 'INVALID_ROOM',
            message: 'Failed to join room',
          });
        }
        break;
      }

      case 'leave-room': {
        const oldRoom = this.roomManager.leavePublicRoom(peerId);
        if (oldRoom) {
          const visiblePeers = this.roomManager.getVisiblePeersFor(peerId);
          sendJson(sender.ws, {
            type: 'room-left',
            peers: visiblePeers,
          });
          // Notify old room peers
          for (const other of this.roomManager.getPeersInRoom(oldRoom)) {
            if (other.ws) {
              sendJson(other.ws, {
                type: 'peer-left',
                peerId,
              });
            }
          }
        }
        break;
      }

      // Targeted P2P signaling messages (Anti-IDOR protected)
      case 'signal':
      case 'file-offer':
      case 'file-response':
      case 'transfer-cancel':
      case 'text-beam':
      case 'ws-chunk-meta':
      case 'ws-chunk-ack': {
        const targetId = msg.targetId;
        if (!targetId) {
          sendJson(sender.ws, {
            type: 'error',
            code: 'MISSING_TARGET',
            message: 'targetId is required',
          });
          return;
        }

        // Anti-IDOR Check: sender and targetId must currently share at least one active room
        if (!this.roomManager.arePeersConnected(peerId, targetId)) {
          sendJson(sender.ws, {
            type: 'error',
            code: 'FORBIDDEN_PEER_ACCESS',
            message: 'Peers do not share a network or paired room',
          });
          return;
        }

        const targetPeer = this.roomManager.getPeer(targetId);
        if (!targetPeer || !targetPeer.ws) {
          sendJson(sender.ws, {
            type: 'error',
            code: 'PEER_OFFLINE',
            message: 'Target peer is no longer connected',
          });
          return;
        }

        // Forward message to target with sender info injected
        const forwarded = { ...msg };
        delete forwarded.targetId;
        forwarded.senderId = peerId;
        forwarded.sender = sanitizePeer(sender);

        if (msg.type === 'text-beam' && !forwarded.timestamp) {
          forwarded.timestamp = Date.now();
        }

        sendJson(targetPeer.ws, forwarded);
        break;
      }

      default: {
        sendJson(sender.ws, {
          type: 'error',
          code: 'UNKNOWN_MESSAGE_TYPE',
          message: `Unknown message type: ${msg.type}`,
        });
        break;
      }
    }
  }

  handleBinaryMessage(peerId, rawBuffer) {
    const sender = this.roomManager.getPeer(peerId);
    if (!sender) return;

    const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
    if (buf.length < BINARY_HEADER_LEN) {
      sendJson(sender.ws, {
        type: 'error',
        code: 'INVALID_BINARY_FRAME',
        message: 'Binary frame is smaller than the required 72-byte header',
      });
      return;
    }

    const targetId = buf.subarray(0, HEADER_FIELD_LEN).toString('utf8').trim();
    const transferId = buf.subarray(HEADER_FIELD_LEN, BINARY_HEADER_LEN).toString('utf8').trim();
    const payload = buf.subarray(BINARY_HEADER_LEN);

    if (!targetId || !transferId) {
      sendJson(sender.ws, {
        type: 'error',
        code: 'INVALID_BINARY_HEADER',
        message: 'Target ID or Transfer ID in binary header is missing',
      });
      return;
    }

    // Anti-IDOR Check
    if (!this.roomManager.arePeersConnected(peerId, targetId)) {
      sendJson(sender.ws, {
        type: 'error',
        code: 'FORBIDDEN_PEER_ACCESS',
        message: 'Peers do not share a network or paired room',
      });
      return;
    }

    const targetPeer = this.roomManager.getPeer(targetId);
    if (!targetPeer || !targetPeer.ws) {
      sendJson(sender.ws, {
        type: 'error',
        code: 'PEER_OFFLINE',
        message: 'Target peer is no longer connected',
      });
      return;
    }

    // Rewrite header: replace targetId with senderId (36 bytes padded)
    const senderHeader = Buffer.alloc(HEADER_FIELD_LEN, ' ');
    senderHeader.write(peerId, 0, 'utf8');

    const txHeader = Buffer.alloc(HEADER_FIELD_LEN, ' ');
    txHeader.write(transferId, 0, 'utf8');

    const outboundFrame = Buffer.concat([senderHeader, txHeader, payload]);
    sendBinary(targetPeer.ws, outboundFrame);
  }

  broadcastDropAvailable(drop) {
    for (const peer of this.roomManager.peers.values()) {
      if (peer.ws) {
        sendJson(peer.ws, {
          type: 'drop-available',
          drop,
        });
      }
    }
  }

  close() {
    return new Promise((resolve) => {
      this.wss.close(resolve);
    });
  }
}

function isJsonBuffer(buf) {
  if (buf.length === 0) return false;
  const firstByte = buf[0];
  // '{' is 123
  return firstByte === 123;
}

module.exports = {
  SignalingServer,
};
