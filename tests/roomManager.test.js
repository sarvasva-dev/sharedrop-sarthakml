const { describe, test, expect } = require('bun:test');
const { RoomManager } = require('../src/server/roomManager');
const { extractClientIp, getIpRoomKey, parseUserAgent, generatePeerIdentity } = require('../src/server/identity');

describe('Identity & Network Grouping (identity.js)', () => {
  test('extracts real client IP from proxy headers and strips ::ffff:', () => {
    const reqCf = {
      headers: { 'cf-connecting-ip': '203.0.113.42', 'x-forwarded-for': '10.0.0.1' },
      socket: { remoteAddress: '::ffff:127.0.0.1' }
    };
    expect(extractClientIp(reqCf)).toBe('203.0.113.42');

    const reqXff = {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' },
      socket: { remoteAddress: '::ffff:127.0.0.1' }
    };
    expect(extractClientIp(reqXff)).toBe('198.51.100.7');

    const reqLan = {
      headers: {},
      socket: { remoteAddress: '::ffff:192.168.1.25' }
    };
    expect(extractClientIp(reqLan)).toBe('192.168.1.25');
  });

  test('groups all RFC1918 LAN and loopback IPs into ip:lan-local', () => {
    expect(getIpRoomKey('127.0.0.1')).toBe('ip:lan-local');
    expect(getIpRoomKey('::1')).toBe('ip:lan-local');
    expect(getIpRoomKey('192.168.1.10')).toBe('ip:lan-local');
    expect(getIpRoomKey('10.0.0.55')).toBe('ip:lan-local');
    expect(getIpRoomKey('172.16.5.4')).toBe('ip:lan-local');

    const pubRoomA = getIpRoomKey('203.0.113.10');
    const pubRoomB = getIpRoomKey('203.0.113.11');
    expect(pubRoomA).toStartWith('ip:');
    expect(pubRoomA).not.toBe('ip:lan-local');
    expect(pubRoomA).not.toBe(pubRoomB);
  });

  test('parses User-Agent and generates warm editorial peer identity', () => {
    const ua = parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36');
    expect(ua.deviceType).toBe('mobile');
    expect(ua.os).toBe('Android');

    const peer = generatePeerIdentity('192.168.1.10', 'curl/8.5.0');
    expect(peer.id).toBeDefined();
    expect(peer.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(peer.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('RoomManager Topology & Anti-IDOR (roomManager.js)', () => {
  test('auto-discovers peers in the same IP room and isolates different IP rooms', () => {
    const rm = new RoomManager();
    const peerA = generatePeerIdentity('192.168.1.5', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    const peerB = generatePeerIdentity('192.168.1.9', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)');
    const peerExternal = generatePeerIdentity('203.0.113.99', 'Mozilla/5.0 (X11; Linux x86_64)');

    rm.registerPeer({ ...peerA, ip: '192.168.1.5', ipRoom: getIpRoomKey('192.168.1.5'), ws: {} });
    rm.registerPeer({ ...peerB, ip: '192.168.1.9', ipRoom: getIpRoomKey('192.168.1.9'), ws: {} });
    rm.registerPeer({ ...peerExternal, ip: '203.0.113.99', ipRoom: getIpRoomKey('203.0.113.99'), ws: {} });

    expect(rm.arePeersConnected(peerA.id, peerB.id)).toBe(true);
    expect(rm.arePeersConnected(peerA.id, peerExternal.id)).toBe(false);

    const visibleToA = rm.getVisiblePeersFor(peerA.id);
    expect(visibleToA.length).toBe(1);
    expect(visibleToA[0].id).toBe(peerB.id);
    expect(visibleToA[0].sharedVia).toBe('lan');
  });

  test('supports 6-digit pairing across different networks with persistent pairSecret', () => {
    const rm = new RoomManager();
    const peerA = generatePeerIdentity('203.0.113.1', 'Mozilla/5.0');
    const peerB = generatePeerIdentity('198.51.100.2', 'Mozilla/5.0');

    rm.registerPeer({ ...peerA, ip: '203.0.113.1', ipRoom: getIpRoomKey('203.0.113.1'), ws: {} });
    rm.registerPeer({ ...peerB, ip: '198.51.100.2', ipRoom: getIpRoomKey('198.51.100.2'), ws: {} });

    expect(rm.arePeersConnected(peerA.id, peerB.id)).toBe(false);

    const { code } = rm.createPairCode(peerA.id);
    expect(code).toMatch(/^\d{6}$/);

    const result = rm.redeemPairCode(peerB.id, code);
    expect(result.success).toBe(true);
    expect(result.pairSecret).toBeDefined();
    expect(result.pairSecret.length).toBeGreaterThanOrEqual(32);

    // Now they are connected via paired room!
    expect(rm.arePeersConnected(peerA.id, peerB.id)).toBe(true);

    // Code is one-time use only
    const replay = rm.redeemPairCode(peerB.id, code);
    expect(replay.success).toBe(false);
  });

  test('supports 5-character public rooms and leaves cleanly', () => {
    const rm = new RoomManager();
    const peerA = generatePeerIdentity('203.0.113.10', 'Mozilla/5.0');
    const peerB = generatePeerIdentity('198.51.100.20', 'Mozilla/5.0');

    rm.registerPeer({ ...peerA, ip: '203.0.113.10', ipRoom: getIpRoomKey('203.0.113.10'), ws: {} });
    rm.registerPeer({ ...peerB, ip: '198.51.100.20', ipRoom: getIpRoomKey('198.51.100.20'), ws: {} });

    const roomCode = rm.createPublicRoom(peerA.id);
    expect(roomCode).toMatch(/^[A-Z0-9]{5}$/);

    rm.joinPublicRoom(peerB.id, roomCode);
    expect(rm.arePeersConnected(peerA.id, peerB.id)).toBe(true);

    rm.leavePublicRoom(peerB.id);
    expect(rm.arePeersConnected(peerA.id, peerB.id)).toBe(false);
  });
});
