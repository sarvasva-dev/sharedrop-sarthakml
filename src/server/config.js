'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ip = require('ip');

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

function parseIceServers() {
  let servers = [...DEFAULT_ICE_SERVERS];
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        servers = parsed;
      }
    } catch (_err) {
      // Fallback to default STUN servers if JSON is malformed
    }
  }

  if (process.env.TURN_URL) {
    const turnEntry = { urls: process.env.TURN_URL };
    if (process.env.TURN_USERNAME) {
      turnEntry.username = process.env.TURN_USERNAME;
    }
    if (process.env.TURN_CREDENTIAL) {
      turnEntry.credential = process.env.TURN_CREDENTIAL;
    }
    servers.push(turnEntry);
  }

  return servers;
}

function getLanIp() {
  try {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
      const netList = interfaces[name] || [];
      for (const net of netList) {
        const isV4 = net.family === 'IPv4' || net.family === 4;
        if (!isV4 || net.internal || !net.address) continue;
        candidates.push({ name, address: net.address });
      }
    }

    const preferred = candidates.find(
      (c) =>
        c.address.startsWith('192.168.') ||
        c.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(c.address)
    );
    if (preferred) return preferred.address;
    if (candidates.length > 0) return candidates[0].address;

    const fallback = ip.address();
    if (fallback && typeof fallback === 'string') return fallback;
  } catch (_err) {
    // Ignore interface detection errors and fallback to loopback
  }
  return '127.0.0.1';
}

function getLanUrl(port) {
  const resolvedPort = Number(port || process.env.PORT || 3000);
  const lanIp = getLanIp();
  return `http://${lanIp}:${resolvedPort}`;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://sharedrop.sarthakml.in').replace(/\/+$/, '');
const ICE_SERVERS = parseIceServers();
const MAX_RELAY_BYTES = Number(process.env.MAX_RELAY_BYTES || 250 * 1024 * 1024);
const DROP_TTL_MS = Number(process.env.DROP_TTL_MS || 15 * 60 * 1000);
const PAIR_CODE_TTL_MS = Number(process.env.PAIR_CODE_TTL_MS || 5 * 60 * 1000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'sharedrop-uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function getConfig(overrides = {}) {
  const port = Number(overrides.port ?? overrides.PORT ?? process.env.PORT ?? PORT);
  const host = overrides.host ?? overrides.HOST ?? process.env.HOST ?? HOST;
  const publicUrl = (
    overrides.publicUrl ??
    overrides.PUBLIC_URL ??
    process.env.PUBLIC_URL ??
    PUBLIC_URL
  ).replace(/\/+$/, '');
  const iceServers = overrides.iceServers ?? overrides.ICE_SERVERS ?? parseIceServers();
  const maxRelayBytes = Number(
    overrides.maxRelayBytes ?? overrides.MAX_RELAY_BYTES ?? process.env.MAX_RELAY_BYTES ?? MAX_RELAY_BYTES
  );
  const dropTtlMs = Number(
    overrides.dropTtlMs ?? overrides.DROP_TTL_MS ?? process.env.DROP_TTL_MS ?? DROP_TTL_MS
  );
  const pairCodeTtlMs = Number(
    overrides.pairCodeTtlMs ??
      overrides.PAIR_CODE_TTL_MS ??
      process.env.PAIR_CODE_TTL_MS ??
      PAIR_CODE_TTL_MS
  );
  const uploadDir =
    overrides.uploadDir ?? overrides.UPLOAD_DIR ?? process.env.UPLOAD_DIR ?? UPLOAD_DIR;

  fs.mkdirSync(uploadDir, { recursive: true });

  const lanIp = getLanIp();
  const lanUrl = getLanUrl(port);

  return {
    PORT: port,
    HOST: host,
    PUBLIC_URL: publicUrl,
    ICE_SERVERS: iceServers,
    MAX_RELAY_BYTES: maxRelayBytes,
    DROP_TTL_MS: dropTtlMs,
    PAIR_CODE_TTL_MS: pairCodeTtlMs,
    UPLOAD_DIR: uploadDir,
    port,
    host,
    publicUrl,
    lanIp,
    lanUrl,
    iceServers,
    maxRelayBytes,
    dropTtlMs,
    pairCodeTtlMs,
    uploadDir,
  };
}

module.exports = {
  PORT,
  HOST,
  PUBLIC_URL,
  ICE_SERVERS,
  MAX_RELAY_BYTES,
  DROP_TTL_MS,
  PAIR_CODE_TTL_MS,
  UPLOAD_DIR,
  getLanIp,
  getLanUrl,
  parseIceServers,
  getConfig,
};
