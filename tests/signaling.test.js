const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const WebSocket = require('ws');
const { createAppServer } = require('../src/server/index');

function createWsClient(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages = [];
    const binaryMessages = [];
    const waiters = [];

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        binaryMessages.push(buf);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate({ isBinary: true, buffer: buf })) {
            const w = waiters.splice(i, 1)[0];
            w.resolve(buf);
          }
        }
        return;
      }
      const parsed = JSON.parse(data.toString());
      messages.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(parsed)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(parsed);
        }
      }
    });

    ws.waitFor = (predicate, timeoutMs = 4000) => {
      for (const msg of messages) {
        if (predicate(msg)) return Promise.resolve(msg);
      }
      for (const buf of binaryMessages) {
        if (predicate({ isBinary: true, buffer: buf })) return Promise.resolve(buf);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('Timeout waiting for WS message')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (val) => {
            clearTimeout(timer);
            res(val);
          }
        });
      });
    };

    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('WebSocket Signaling, Pairing & Binary Relay (signalingServer.js)', () => {
  let serverInstance;
  let wsUrl;

  beforeAll(async () => {
    serverInstance = createAppServer();
    await new Promise((resolve) => serverInstance.server.listen(0, '127.0.0.1', resolve));
    const port = serverInstance.server.address().port;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    if (serverInstance && serverInstance.close) {
      await serverInstance.close();
    } else if (serverInstance && serverInstance.server) {
      serverInstance.server.close();
    }
  });

  test('peers on same LAN auto-discover, exchange WebRTC signals, text beams, and binary relay chunks', async () => {
    const clientA = await createWsClient(wsUrl, { 'x-forwarded-for': '192.168.1.10' });
    const welcomeA = await clientA.waitFor((m) => m.type === 'welcome');
    expect(welcomeA.peer.id).toBeDefined();

    const clientB = await createWsClient(wsUrl, { 'x-forwarded-for': '192.168.1.11' });
    const welcomeB = await clientB.waitFor((m) => m.type === 'welcome');
    expect(welcomeB.peer.id).toBeDefined();

    // Send join-init from both
    clientA.send(JSON.stringify({ type: 'join-init', displayName: 'Sarthak Laptop' }));
    clientB.send(JSON.stringify({ type: 'join-init', displayName: 'Sarthak Phone' }));

    // Verify they see each other
    await clientA.waitFor((m) =>
      (m.type === 'peer-joined' && m.peer?.id === welcomeB.peer.id) ||
      (m.type === 'peers' && m.peers?.some((p) => p.id === welcomeB.peer.id))
    );

    // Exchange WebRTC SDP offer
    clientA.send(JSON.stringify({
      type: 'signal',
      targetId: welcomeB.peer.id,
      signal: { type: 'offer', sdp: 'v=0...mock-sdp' }
    }));

    const receivedSignal = await clientB.waitFor((m) => m.type === 'signal' && m.senderId === welcomeA.peer.id);
    expect(receivedSignal.signal.sdp).toBe('v=0...mock-sdp');

    // Exchange Instant Text Beam
    clientA.send(JSON.stringify({
      type: 'text-beam',
      targetId: welcomeB.peer.id,
      id: 'beam-101',
      text: 'https://sharedrop.sarthakml.in'
    }));

    const receivedBeam = await clientB.waitFor((m) => m.type === 'text-beam' && m.id === 'beam-101');
    expect(receivedBeam.text).toBe('https://sharedrop.sarthakml.in');

    // Exchange Binary WebSocket Relay Chunk ([36B targetId][36B transferId][payload])
    const targetHeader = Buffer.alloc(36, ' ');
    targetHeader.write(welcomeB.peer.id);
    const transferHeader = Buffer.alloc(36, ' ');
    transferHeader.write('tx-binary-test-001');
    const payload = Buffer.from('Hello PairDrop Binary Chunk Stream!');
    const frame = Buffer.concat([targetHeader, transferHeader, payload]);

    clientA.send(frame);

    const binaryFrame = await clientB.waitFor((m) => m.isBinary === true);
    const senderFromHeader = binaryFrame.subarray(0, 36).toString('utf8').trim();
    const txIdFromHeader = binaryFrame.subarray(36, 72).toString('utf8').trim();
    const receivedPayload = binaryFrame.subarray(72).toString('utf8');

    expect(senderFromHeader).toBe(welcomeA.peer.id);
    expect(txIdFromHeader).toBe('tx-binary-test-001');
    expect(receivedPayload).toBe('Hello PairDrop Binary Chunk Stream!');

    clientA.close();
    clientB.close();
  });

  test('enforces Anti-IDOR isolation between peers on different networks until paired via 6-digit code', async () => {
    const clientWan1 = await createWsClient(wsUrl, { 'x-forwarded-for': '203.0.113.50' });
    const welcome1 = await clientWan1.waitFor((m) => m.type === 'welcome');

    const clientWan2 = await createWsClient(wsUrl, { 'x-forwarded-for': '198.51.100.75' });
    const welcome2 = await clientWan2.waitFor((m) => m.type === 'welcome');

    // Attempt unauthorized signal across different WAN IPs -> should return error
    clientWan1.send(JSON.stringify({
      type: 'text-beam',
      targetId: welcome2.peer.id,
      id: 'unauth-beam',
      text: 'should-be-blocked'
    }));

    const errMsg = await clientWan1.waitFor((m) => m.type === 'error');
    expect(errMsg.code).toBeDefined();

    // Now pair via 6-digit code
    clientWan1.send(JSON.stringify({ type: 'create-pair-code' }));
    const codeCreated = await clientWan1.waitFor((m) => m.type === 'pair-code-created');
    expect(codeCreated.code).toMatch(/^\d{6}$/);

    clientWan2.send(JSON.stringify({ type: 'join-pair-code', code: codeCreated.code }));
    const pair1 = await clientWan1.waitFor((m) => m.type === 'pair-success');
    const pair2 = await clientWan2.waitFor((m) => m.type === 'pair-success');

    expect(pair1.pairSecret).toBe(pair2.pairSecret);

    // Now text-beam between Wan1 and Wan2 succeeds!
    clientWan1.send(JSON.stringify({
      type: 'text-beam',
      targetId: welcome2.peer.id,
      id: 'auth-beam',
      text: 'Paired across networks!'
    }));

    const beamSuccess = await clientWan2.waitFor((m) => m.type === 'text-beam' && m.id === 'auth-beam');
    expect(beamSuccess.text).toBe('Paired across networks!');

    clientWan1.close();
    clientWan2.close();
  });
});
