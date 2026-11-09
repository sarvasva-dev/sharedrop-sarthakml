'use strict';

const crypto = require('crypto');

const ADJECTIVES = [
  'Amber',
  'Cobalt',
  'Crimson',
  'Solar',
  'Velvet',
  'Sage',
  'Quartz',
  'Onyx',
  'Copper',
  'Indigo',
  'Beryl',
  'Cedar',
  'Saffron',
  'Topaz',
  'Ivory',
  'Garnet',
  'Ochre',
  'Coral',
  'russet'.replace(/^r/, 'R'),
  'Jade',
  'Sienna',
  'Agate',
  'Bronze',
  'Cinder',
  'Dune',
  'Flint',
  'Linen',
  'Maple',
  'Moss',
  'Slate',
  'Terra',
  'Umber',
];

const ANIMALS = [
  'Falcon',
  'Lynx',
  'Otter',
  'Heron',
  'Fox',
  'Panther',
  'Badger',
  'Raven',
  'Condor',
  'Orca',
  'Ibex',
  'Kestrel',
  'Mantis',
  'Viper',
  'Gazelle',
  'Finch',
  'Osprey',
  'Puma',
  'Crane',
  'Bison',
  'Coyote',
  'Ferret',
  'Gecko',
  'Hawk',
  'Jaguar',
  'Koala',
  'Lemur',
  'Marten',
  'Narwhal',
  'Pelican',
  'Swift',
  'Wren',
];

const AVATAR_COLORS = [
  '#EA580C', // Signal Terracotta
  '#0D9488', // P2P Verified Teal
  '#D97706', // Warm Amber
  '#2563EB', // Cobalt Ink
  '#DC2626', // Editorial Crimson
  '#059669', // Sage Emerald
  '#7C3AED', // Deep Indigo
  '#B45309', // Copper Ochre
  '#0284C7', // Cerulean
  '#BE123C', // Garnet Rose
  '#4F46E5', // Ultramarine
  '#15803D', // Cedar Green
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return '127.0.0.1';
  let cleaned = rawIp.trim();
  if (cleaned.includes(',')) {
    cleaned = cleaned.split(',')[0].trim();
  }
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.slice(7);
  }
  if (cleaned === '::1' || cleaned === '0:0:0:0:0:0:0:1') {
    return '127.0.0.1';
  }
  // Strip IPv6 zone index (e.g. fe80::1%eth0)
  const zoneIdx = cleaned.indexOf('%');
  if (zoneIdx !== -1) {
    cleaned = cleaned.slice(0, zoneIdx);
  }
  return cleaned;
}

function extractClientIp(req) {
  if (!req) return '127.0.0.1';
  if (typeof req === 'string') return normalizeIp(req);

  const headers = req.headers || {};
  const cfIp = headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string' && cfIp.trim()) {
    return normalizeIp(cfIp);
  }

  const xRealIp = headers['x-real-ip'];
  if (xRealIp && typeof xRealIp === 'string' && xRealIp.trim()) {
    return normalizeIp(xRealIp);
  }

  const xForwardedFor = headers['x-forwarded-for'];
  if (xForwardedFor && typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    return normalizeIp(xForwardedFor.split(',')[0]);
  }

  const socketAddr =
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    req.ip ||
    '127.0.0.1';

  return normalizeIp(socketAddr);
}

function isPrivateOrLoopbackIp(rawIp) {
  const ip = normalizeIp(rawIp).toLowerCase();
  if (
    !ip ||
    ip === 'localhost' ||
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '0.0.0.0' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('fc00:') ||
    ip.startsWith('fd00:') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80:')
  ) {
    return true;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
    return true;
  }

  return false;
}

function getIpRoomKey(rawIp) {
  const ip = normalizeIp(rawIp);
  if (isPrivateOrLoopbackIp(ip)) {
    return 'ip:lan-local';
  }
  const digest = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  return `ip:${digest}`;
}

function parseUserAgent(uaString) {
  const ua = typeof uaString === 'string' ? uaString : '';
  const lower = ua.toLowerCase();

  if (
    !ua ||
    lower.includes('sharedrop-cli') ||
    lower.includes('curl/') ||
    lower.includes('wget/') ||
    lower.includes('httpie') ||
    lower.includes('python-requests') ||
    lower.includes('go-http-client') ||
    (lower.includes('node') && !lower.includes('mozilla')) ||
    (lower.includes('bun/') && !lower.includes('mozilla'))
  ) {
    return {
      deviceType: 'cli',
      os: 'CLI',
      browser: 'curl/CLI',
    };
  }

  let os = 'Browser';
  if (/iphone|ipad|ipod|ios/i.test(ua)) {
    os = 'iOS';
  } else if (/android/i.test(ua)) {
    os = 'Android';
  } else if (/macintosh|mac os x|macos/i.test(ua)) {
    os = 'macOS';
  } else if (/windows/i.test(ua)) {
    os = 'Windows';
  } else if (/linux|x11|cros|ubuntu|fedora|debian/i.test(ua)) {
    os = 'Linux';
  }

  let deviceType = 'desktop';
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) {
    deviceType = 'tablet';
  } else if (/iphone|ipod|windows phone|mobile|blackberry|iemobile|opera mini/i.test(ua)) {
    deviceType = 'mobile';
  }

  let browser = 'Browser';
  if (/edg\/|edge\/|edgios\/|edga\//i.test(ua)) {
    browser = 'Edge';
  } else if (/brave/i.test(ua)) {
    browser = 'Brave';
  } else if (/opr\/|opera/i.test(ua)) {
    browser = 'Chrome';
  } else if (/chrome\/|crios\/|chromium\//i.test(ua)) {
    browser = 'Chrome';
  } else if (/firefox\/|fxios\//i.test(ua)) {
    browser = 'Firefox';
  } else if (/safari\//i.test(ua)) {
    browser = 'Safari';
  }

  return { deviceType, os, browser };
}

function generatePeerIdentity(seedIp, userAgent, existingId) {
  let resolvedIp = seedIp;
  let resolvedUa = userAgent;
  let resolvedExistingId = existingId;
  let customDisplayName = null;

  if (seedIp && typeof seedIp === 'object' && !Array.isArray(seedIp)) {
    resolvedIp = seedIp.ip || seedIp.seedIp || '127.0.0.1';
    resolvedUa = seedIp.userAgent || seedIp.ua || '';
    resolvedExistingId = seedIp.existingId || seedIp.id || null;
    customDisplayName = seedIp.displayName || null;
  }

  const hasValidExistingId =
    typeof resolvedExistingId === 'string' && UUID_REGEX.test(resolvedExistingId.trim());
  const id = hasValidExistingId ? resolvedExistingId.trim() : crypto.randomUUID();

  const seedMaterial = `${id}:${normalizeIp(resolvedIp || '127.0.0.1')}:${resolvedUa || ''}`;
  const hash = crypto.createHash('sha256').update(seedMaterial).digest();

  const adjIndex = hash[0] % ADJECTIVES.length;
  const animalIndex = hash[1] % ANIMALS.length;
  const colorIndex = hash[2] % AVATAR_COLORS.length;

  const defaultDisplayName = `${ADJECTIVES[adjIndex]} ${ANIMALS[animalIndex]}`;
  const displayName =
    typeof customDisplayName === 'string' && customDisplayName.trim()
      ? customDisplayName.trim().slice(0, 48)
      : defaultDisplayName;

  const color = AVATAR_COLORS[colorIndex];
  const { deviceType, os, browser } = parseUserAgent(resolvedUa);
  const ip = normalizeIp(resolvedIp || '127.0.0.1');
  const ipRoom = getIpRoomKey(ip);

  return {
    id,
    ip,
    ipRoom,
    displayName,
    deviceType,
    os,
    browser,
    color,
  };
}

module.exports = {
  ADJECTIVES,
  ANIMALS,
  AVATAR_COLORS,
  normalizeIp,
  extractClientIp,
  isPrivateOrLoopbackIp,
  getIpRoomKey,
  parseUserAgent,
  generatePeerIdentity,
};
