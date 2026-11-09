'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { getConfig } = require('./config');
const { RoomManager } = require('./roomManager');
const { SignalingServer } = require('./signalingServer');
const { createDropRoutes } = require('./dropRoutes');

function createAppServer(customConfig = {}) {
  const config = getConfig(customConfig);
  const app = express();

  // Security & Privacy Headers Middleware
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Basic middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // RoomManager & HTTP Server
  const roomManager = new RoomManager({
    pairCodeTtlMs: config.pairCodeTtlMs,
  });

  const server = http.createServer(app);

  // SignalingServer on /ws
  const signalingServer = new SignalingServer(server, roomManager, config);

  // Mount API & Drop Routes
  const { router: dropRouter, drops, stop: stopDropRoutes } = createDropRoutes(config, signalingServer);
  app.use(dropRouter);

  // Dedicated legal & documentation routes
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));
  app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
  app.get('/security', (req, res) => res.sendFile(path.join(publicDir, 'security.html')));
  app.get('/faq', (req, res) => res.sendFile(path.join(publicDir, 'faq.html')));

  // Static assets from public/
  app.use(express.static(publicDir));

  // SPA fallback for non-API routes: if HTML is requested, return index.html if exists
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/d/') || req.path.startsWith('/ws') || req.path.startsWith('/sw-stream-download/')) {
      return next();
    }
    const indexPath = path.join(publicDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) next();
    });
  });

  function close() {
    if (stopDropRoutes) {
      stopDropRoutes();
    }
    return new Promise((resolve) => {
      signalingServer.close().then(() => {
        server.close(resolve);
      });
    });
  }

  return {
    app,
    server,
    config,
    roomManager,
    signalingServer,
    drops,
    close,
  };
}

function startServer(customConfig = {}) {
  const appServer = createAppServer(customConfig);
  const { server, config } = appServer;

  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => {
      if (err) return reject(err);
      console.log(`[ShareDrop] Server listening on ${config.host}:${config.port}`);
      console.log(`[ShareDrop] LAN URL: ${config.lanUrl}`);
      console.log(`[ShareDrop] Public URL: ${config.publicUrl}`);
      resolve(appServer);
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[ShareDrop] Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  createAppServer,
  startServer,
};
