'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');

function createDropRoutes(config, signalingServer) {
  const router = express.Router();
  const uploadDir = config.uploadDir;
  fs.mkdirSync(uploadDir, { recursive: true });

  // In-memory registry of ephemeral drops
  // drops: Map<code, { code, files: [...], totalSize, senderName, senderIp, createdAt, expiresAt }>
  const drops = new Map();

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      const randomName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      cb(null, randomName);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.maxRelayBytes || 250 * 1024 * 1024,
    },
  });

  function cleanupExpiredDrops() {
    const now = Date.now();
    for (const [code, drop] of drops.entries()) {
      if (drop.expiresAt <= now) {
        for (const f of drop.files) {
          try {
            if (f.path && fs.existsSync(f.path)) {
              fs.unlinkSync(f.path);
            }
          } catch (_err) {
            // Ignore file deletion error
          }
        }
        drops.delete(code);
      }
    }
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(cleanupExpiredDrops, 60 * 1000).unref();

  function stop() {
    clearInterval(cleanupTimer);
  }

  function generateDropCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  // GET /api/health
  router.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
      },
    });
  });

  // GET /api/config
  router.get('/api/config', (_req, res) => {
    res.json({
      success: true,
      data: {
        publicUrl: config.publicUrl,
        lanUrl: config.lanUrl,
        iceServers: config.iceServers,
        maxRelayBytes: config.maxRelayBytes,
        dropTtlMs: config.dropTtlMs,
      },
    });
  });

  // GET /api/qr
  router.get('/api/qr', async (req, res) => {
    try {
      const text = req.query.text || config.publicUrl;
      const format = (req.query.format || 'png').toLowerCase();

      if (format === 'svg') {
        const svg = await qrcode.toString(text, {
          type: 'svg',
          margin: 1,
          color: {
            dark: '#18181B',
            light: '#FAF8F5',
          },
        });
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.send(svg);
      }

      if (format === 'dataurl') {
        const dataUrl = await qrcode.toDataURL(text, {
          margin: 1,
          color: {
            dark: '#18181B',
            light: '#FAF8F5',
          },
        });
        return res.json({
          success: true,
          data: {
            dataUrl,
            text,
          },
        });
      }

      // Default PNG stream
      res.setHeader('Content-Type', 'image/png');
      qrcode.toFileStream(res, text, {
        margin: 1,
        color: {
          dark: '#18181B',
          light: '#FAF8F5',
        },
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: {
          code: 'QR_GENERATION_FAILED',
          message: err.message,
        },
      });
    }
  });

  // POST /api/drop
  // Handles single ('file') or multiple ('files')
  router.post('/api/drop', upload.any(), async (req, res) => {
    try {
      cleanupExpiredDrops();

      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_FILES_UPLOADED',
            message: 'No files were uploaded in request',
          },
        });
      }

      let code = generateDropCode();
      while (drops.has(code)) {
        code = generateDropCode();
      }

      const senderName = req.body.senderName || 'Anonymous';
      const senderIp = req.ip || '127.0.0.1';
      const expiresAt = Date.now() + config.dropTtlMs;

      const fileEntries = files.map((f) => ({
        name: f.originalname,
        size: f.size,
        type: f.mimetype,
        path: f.path,
        filename: f.filename,
      }));

      const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);

      const downloadUrl = `/d/${code}`;
      const fullDownloadUrl = `${config.publicUrl}${downloadUrl}`;

      const qrDataUrl = await qrcode.toDataURL(fullDownloadUrl, {
        margin: 1,
        color: {
          dark: '#18181B',
          light: '#FAF8F5',
        },
      });

      const drop = {
        code,
        files: fileEntries,
        totalSize,
        senderName,
        senderIp,
        downloadUrl,
        qrDataUrl,
        createdAt: Date.now(),
        expiresAt,
      };

      drops.set(code, drop);

      // Broadcast drop-available to connected peers if signalingServer is available
      if (signalingServer && typeof signalingServer.broadcastDropAvailable === 'function') {
        signalingServer.broadcastDropAvailable({
          code,
          files: fileEntries.map((f) => ({ name: f.name, size: f.size, type: f.type })),
          totalSize,
          downloadUrl,
          expiresAt,
          sender: { displayName: senderName },
        });
      }

      res.json({
        success: true,
        data: {
          code,
          downloadUrl,
          qrDataUrl,
          totalSize,
          files: fileEntries.map((f) => ({ name: f.name, size: f.size, type: f.type })),
          expiresAt,
        },
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: {
          code: 'DROP_UPLOAD_FAILED',
          message: err.message,
        },
      });
    }
  });

  // GET /api/drop/:code/meta
  router.get('/api/drop/:code/meta', (req, res) => {
    cleanupExpiredDrops();
    const code = (req.params.code || '').trim().toUpperCase();
    const drop = drops.get(code);

    if (!drop || drop.expiresAt <= Date.now()) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'DROP_NOT_FOUND',
          message: 'Drop code not found or expired',
        },
      });
    }

    res.json({
      success: true,
      data: {
        code: drop.code,
        files: drop.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        totalSize: drop.totalSize,
        senderName: drop.senderName,
        downloadUrl: drop.downloadUrl,
        expiresAt: drop.expiresAt,
      },
    });
  });

  // GET /d/:code - Direct file download
  router.get('/d/:code', (req, res) => {
    cleanupExpiredDrops();
    const code = (req.params.code || '').trim().toUpperCase();
    const drop = drops.get(code);

    if (!drop || drop.expiresAt <= Date.now()) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'DROP_NOT_FOUND',
          message: 'Drop code not found or expired',
        },
      });
    }

    if (drop.files.length === 1) {
      const file = drop.files[0];
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      if (file.type) res.setHeader('Content-Type', file.type);
      res.setHeader('Content-Length', file.size);

      const stream = fs.createReadStream(file.path);
      stream.on('error', (_err) => {
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: { code: 'FILE_STREAM_ERROR', message: 'Could not read file' },
          });
        }
      });
      return stream.pipe(res);
    }

    // Multiple files: if multiple, stream the first one or stream tar/zip (here if multiple, stream single or respond with metadata)
    const firstFile = drop.files[0];
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(firstFile.name)}"`);
    if (firstFile.type) res.setHeader('Content-Type', firstFile.type);
    res.setHeader('Content-Length', firstFile.size);
    const stream = fs.createReadStream(firstFile.path);
    return stream.pipe(res);
  });

  return { router, drops, stop };
}

module.exports = {
  createDropRoutes,
};
