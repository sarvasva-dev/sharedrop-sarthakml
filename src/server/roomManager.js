'use strict';

const crypto = require('crypto');

/**
 * Generates a random alphanumeric code of given length.
 * Excludes easily confusable characters (0, O, I, 1) by default or uses upper alphanumeric.
 */
function generateCode(length = 5) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Generates a 6-digit numeric pairing code.
 */
function generateNumericPairCode() {
  const num = crypto.randomInt(100000, 1000000);
  return String(num);
}

class RoomManager {
  constructor(options = {}) {
    this.pairCodeTtlMs = options.pairCodeTtlMs || 5 * 60 * 1000; // 5 min
    // peers: Map<peerId, PeerRecord>
    this.peers = new Map();
    // ipRooms: Map<ipRoomKey, Set<peerId>>
    this.ipRooms = new Map();
    // publicRooms: Map<roomCode, Set<peerId>>
    this.publicRooms = new Map();
    // pairedRooms: Map<pairSecret, Set<peerId>>
    this.pairedRooms = new Map();
    // pairCodes: Map<code, { hostPeerId, expiresAt }>
    this.pairCodes = new Map();
  }

  registerPeer(peerData) {
    if (!peerData || !peerData.id) {
      throw new Error('peerData must include an id');
    }
    const peerId = peerData.id;

    // Remove existing if any
    if (this.peers.has(peerId)) {
      this.removePeer(peerId);
    }

    const peer = {
      id: peerId,
      displayName: peerData.displayName || 'Anonymous Peer',
      deviceType: peerData.deviceType || 'desktop',
      os: peerData.os || 'Unknown',
      browser: peerData.browser || 'Browser',
      color: peerData.color || '#EA580C',
      ip: peerData.ip || '127.0.0.1',
      ipRoom: peerData.ipRoom || 'ip:lan-local',
      publicRoom: null,
      pairSecrets: new Set(),
      ws: peerData.ws || null,
      createdAt: Date.now(),
    };

    this.peers.set(peerId, peer);

    // Add to ipRoom
    if (!this.ipRooms.has(peer.ipRoom)) {
      this.ipRooms.set(peer.ipRoom, new Set());
    }
    this.ipRooms.get(peer.ipRoom).add(peerId);

    // If pairSecrets passed in
    if (Array.isArray(peerData.pairSecrets)) {
      this.attachPairSecrets(peerId, peerData.pairSecrets);
    }

    // If roomCode passed in
    if (peerData.roomCode) {
      this.joinPublicRoom(peerId, peerData.roomCode);
    }

    return peer;
  }

  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  updatePeerProfile(peerId, updates = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    if (typeof updates.displayName === 'string' && updates.displayName.trim()) {
      peer.displayName = updates.displayName.trim().slice(0, 48);
    }
    if (updates.deviceType) peer.deviceType = updates.deviceType;
    if (updates.os) peer.os = updates.os;
    if (updates.browser) peer.browser = updates.browser;
    if (updates.color) peer.color = updates.color;

    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    // Remove from ipRoom
    if (peer.ipRoom && this.ipRooms.has(peer.ipRoom)) {
      const set = this.ipRooms.get(peer.ipRoom);
      set.delete(peerId);
      if (set.size === 0) {
        this.ipRooms.delete(peer.ipRoom);
      }
    }

    // Remove from publicRoom
    if (peer.publicRoom && this.publicRooms.has(peer.publicRoom)) {
      const set = this.publicRooms.get(peer.publicRoom);
      set.delete(peerId);
      if (set.size === 0) {
        this.publicRooms.delete(peer.publicRoom);
      }
    }

    // Remove from pairedRooms
    for (const secret of peer.pairSecrets) {
      if (this.pairedRooms.has(secret)) {
        const set = this.pairedRooms.get(secret);
        set.delete(peerId);
        if (set.size === 0) {
          this.pairedRooms.delete(secret);
        }
      }
    }

    // Clean any pairCodes created by this peer
    for (const [code, info] of this.pairCodes.entries()) {
      if (info.hostPeerId === peerId) {
        this.pairCodes.delete(code);
      }
    }

    this.peers.delete(peerId);
    return peer;
  }

  attachPairSecrets(peerId, secrets = []) {
    const peer = this.peers.get(peerId);
    if (!peer || !Array.isArray(secrets)) return;

    for (const secret of secrets) {
      if (typeof secret !== 'string' || secret.length < 16) continue;
      peer.pairSecrets.add(secret);
      if (!this.pairedRooms.has(secret)) {
        this.pairedRooms.set(secret, new Set());
      }
      this.pairedRooms.get(secret).add(peerId);
    }
  }

  createPairCode(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`);
    }

    this.cleanupExpiredPairCodes();

    // Check if peer already has a valid code
    for (const [existingCode, info] of this.pairCodes.entries()) {
      if (info.hostPeerId === peerId && info.expiresAt > Date.now()) {
        return { code: existingCode, expiresAt: info.expiresAt };
      }
    }

    let code = generateNumericPairCode();
    while (this.pairCodes.has(code)) {
      code = generateNumericPairCode();
    }

    const expiresAt = Date.now() + this.pairCodeTtlMs;
    this.pairCodes.set(code, {
      hostPeerId: peerId,
      expiresAt,
    });

    return { code, expiresAt };
  }

  redeemPairCode(clientPeerId, code) {
    this.cleanupExpiredPairCodes();

    if (!code || typeof code !== 'string') {
      return { success: false, error: 'Invalid pair code' };
    }

    const cleanCode = code.trim();
    const entry = this.pairCodes.get(cleanCode);
    if (!entry) {
      return { success: false, error: 'Pair code not found or expired' };
    }

    if (entry.expiresAt <= Date.now()) {
      this.pairCodes.delete(cleanCode);
      return { success: false, error: 'Pair code expired' };
    }

    const hostPeerId = entry.hostPeerId;
    if (hostPeerId === clientPeerId) {
      return { success: false, error: 'Cannot pair with yourself' };
    }

    const hostPeer = this.peers.get(hostPeerId);
    const clientPeer = this.peers.get(clientPeerId);

    if (!hostPeer || !clientPeer) {
      this.pairCodes.delete(cleanCode);
      return { success: false, error: 'Peer no longer connected' };
    }

    // Code is one-time use
    this.pairCodes.delete(cleanCode);

    // Generate 32-byte (64 hex char) pairSecret
    const pairSecret = crypto.randomBytes(32).toString('hex');

    // Attach pairSecret to both peers
    hostPeer.pairSecrets.add(pairSecret);
    clientPeer.pairSecrets.add(pairSecret);

    if (!this.pairedRooms.has(pairSecret)) {
      this.pairedRooms.set(pairSecret, new Set());
    }
    this.pairedRooms.get(pairSecret).add(hostPeerId);
    this.pairedRooms.get(pairSecret).add(clientPeerId);

    return {
      success: true,
      pairSecret,
      hostPeerId,
      clientPeerId,
      hostPeer,
      clientPeer,
    };
  }

  createPublicRoom(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`);
    }

    // Leave any existing public room
    if (peer.publicRoom) {
      this.leavePublicRoom(peerId);
    }

    let roomCode = generateCode(5);
    while (this.publicRooms.has(roomCode)) {
      roomCode = generateCode(5);
    }

    this.publicRooms.set(roomCode, new Set([peerId]));
    peer.publicRoom = roomCode;

    return roomCode;
  }

  joinPublicRoom(peerId, rawRoomCode) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    if (!rawRoomCode || typeof rawRoomCode !== 'string') return false;
    const roomCode = rawRoomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!roomCode) return false;

    // Leave previous room if different
    if (peer.publicRoom && peer.publicRoom !== roomCode) {
      this.leavePublicRoom(peerId);
    }

    if (!this.publicRooms.has(roomCode)) {
      this.publicRooms.set(roomCode, new Set());
    }

    this.publicRooms.get(roomCode).add(peerId);
    peer.publicRoom = roomCode;
    return true;
  }

  leavePublicRoom(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.publicRoom) return null;

    const roomCode = peer.publicRoom;
    peer.publicRoom = null;

    if (this.publicRooms.has(roomCode)) {
      const set = this.publicRooms.get(roomCode);
      set.delete(peerId);
      if (set.size === 0) {
        this.publicRooms.delete(roomCode);
      }
    }

    return roomCode;
  }

  arePeersConnected(peerIdA, peerIdB) {
    if (!peerIdA || !peerIdB || peerIdA === peerIdB) return false;

    const peerA = this.peers.get(peerIdA);
    const peerB = this.peers.get(peerIdB);
    if (!peerA || !peerB) return false;

    // 1. Same IP Room?
    if (peerA.ipRoom && peerA.ipRoom === peerB.ipRoom) {
      return true;
    }

    // 2. Same Public Room?
    if (peerA.publicRoom && peerA.publicRoom === peerB.publicRoom) {
      return true;
    }

    // 3. Share any pairSecret?
    for (const secret of peerA.pairSecrets) {
      if (peerB.pairSecrets.has(secret)) {
        return true;
      }
    }

    return false;
  }

  getVisiblePeersFor(peerId) {
    const self = this.peers.get(peerId);
    if (!self) return [];

    const visibleMap = new Map();

    const sanitize = (peer, sharedVia) => ({
      id: peer.id,
      displayName: peer.displayName,
      deviceType: peer.deviceType,
      os: peer.os,
      browser: peer.browser,
      color: peer.color,
      sharedVia,
      roomCode: peer.publicRoom || undefined,
    });

    // 1. IP Room peers (LAN)
    if (self.ipRoom && this.ipRooms.has(self.ipRoom)) {
      for (const otherId of this.ipRooms.get(self.ipRoom)) {
        if (otherId !== peerId) {
          const p = this.peers.get(otherId);
          if (p) {
            visibleMap.set(otherId, sanitize(p, 'lan'));
          }
        }
      }
    }

    // 2. Paired peers
    for (const secret of self.pairSecrets) {
      const set = this.pairedRooms.get(secret);
      if (set) {
        for (const otherId of set) {
          if (otherId !== peerId) {
            const p = this.peers.get(otherId);
            if (p) {
              const existing = visibleMap.get(otherId);
              // Prioritize paired or keep existing with paired flag
              visibleMap.set(otherId, sanitize(p, existing ? existing.sharedVia : 'paired'));
            }
          }
        }
      }
    }

    // 3. Public Room peers
    if (self.publicRoom && this.publicRooms.has(self.publicRoom)) {
      for (const otherId of this.publicRooms.get(self.publicRoom)) {
        if (otherId !== peerId) {
          const p = this.peers.get(otherId);
          if (p) {
            const existing = visibleMap.get(otherId);
            visibleMap.set(otherId, sanitize(p, existing ? existing.sharedVia : 'room'));
          }
        }
      }
    }

    return Array.from(visibleMap.values());
  }

  getPeersInRoom(roomCode) {
    if (!roomCode || !this.publicRooms.has(roomCode)) return [];
    const result = [];
    for (const peerId of this.publicRooms.get(roomCode)) {
      const p = this.peers.get(peerId);
      if (p) result.push(p);
    }
    return result;
  }

  cleanupExpiredPairCodes() {
    const now = Date.now();
    for (const [code, info] of this.pairCodes.entries()) {
      if (info.expiresAt <= now) {
        this.pairCodes.delete(code);
      }
    }
  }
}

module.exports = {
  RoomManager,
  generateCode,
  generateNumericPairCode,
};
