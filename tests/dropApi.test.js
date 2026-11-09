const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const crypto = require('crypto');
const { createAppServer } = require('../src/server/index');

describe('Ephemeral HTTP Drop & CLI Endpoints (dropRoutes.js)', () => {
  let serverInstance;
  let baseUrl;

  beforeAll(async () => {
    serverInstance = createAppServer();
    await new Promise((resolve) => serverInstance.server.listen(0, '127.0.0.1', resolve));
    const port = serverInstance.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (serverInstance && serverInstance.close) {
      await serverInstance.close();
    } else if (serverInstance && serverInstance.server) {
      serverInstance.server.close();
    }
  });

  test('GET /api/health and GET /api/config return structured telemetry', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.success).toBe(true);
    expect(health.data.status).toBe('ok');

    const cfgRes = await fetch(`${baseUrl}/api/config`);
    expect(cfgRes.status).toBe(200);
    const cfg = await cfgRes.json();
    expect(cfg.success).toBe(true);
    expect(cfg.data.publicUrl).toContain('sharedrop.sarthakml.in');
    expect(Array.isArray(cfg.data.iceServers)).toBe(true);
  });

  test('GET /api/qr generates SVG and DataURL QR codes', async () => {
    const svgRes = await fetch(`${baseUrl}/api/qr?text=https://sharedrop.sarthakml.in&format=svg`);
    expect(svgRes.status).toBe(200);
    const svgText = await svgRes.text();
    expect(svgText).toContain('<svg');

    const jsonRes = await fetch(`${baseUrl}/api/qr?text=https://sharedrop.sarthakml.in&format=dataurl`);
    expect(jsonRes.status).toBe(200);
    const jsonBody = await jsonRes.json();
    expect(jsonBody.success).toBe(true);
    expect(jsonBody.data.dataUrl).toStartWith('data:image/png;base64,');
  });

  test('POST /api/drop uploads a file, returns a 6-char code, and GET /d/:code downloads identical bytes', async () => {
    const payloadBytes = crypto.randomBytes(128 * 1024); // 128 KB binary test payload
    const expectedHash = crypto.createHash('sha256').update(payloadBytes).digest('hex');

    const form = new FormData();
    form.append('file', new Blob([payloadBytes], { type: 'application/octet-stream' }), 'quantum-weights.bin');
    form.append('senderName', 'ShareDrop-CLI-Test');

    const dropRes = await fetch(`${baseUrl}/api/drop`, {
      method: 'POST',
      body: form
    });
    expect(dropRes.status).toBe(200);
    const dropJson = await dropRes.json();
    expect(dropJson.success).toBe(true);
    expect(dropJson.data.code).toMatch(/^[A-Z0-9]{6}$/);

    const code = dropJson.data.code;

    // Inspect metadata
    const metaRes = await fetch(`${baseUrl}/api/drop/${code}/meta`);
    expect(metaRes.status).toBe(200);
    const metaJson = await metaRes.json();
    expect(metaJson.success).toBe(true);
    expect(metaJson.data.files[0].name).toBe('quantum-weights.bin');
    expect(metaJson.data.totalSize).toBe(payloadBytes.length);

    // Download via /d/:code
    const dlRes = await fetch(`${baseUrl}/d/${code}`);
    expect(dlRes.status).toBe(200);
    const downloadedBuffer = Buffer.from(await dlRes.arrayBuffer());
    const actualHash = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');

    expect(actualHash).toBe(expectedHash);
  });

  test('Security headers and legal documentation routes (/terms, /privacy, /security, /faq)', async () => {
    // Check security headers on root /
    const rootRes = await fetch(`${baseUrl}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(rootRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(rootRes.headers.get('X-Frame-Options')).toBe('DENY');
    expect(rootRes.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');

    // Check legal routes serve HTML
    for (const route of ['/terms', '/privacy', '/security', '/faq']) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('ShareDrop');
    }
  });
});
