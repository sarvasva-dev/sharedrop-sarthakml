# ShareDrop (`sharedrop.sarthakml.in`) — System Architecture & Wire Protocol

## 1. Overview
ShareDrop is a PairDrop-inspired cross-platform P2P file, folder, clipboard, and terminal sharing web application hosted at `https://sharedrop.sarthakml.in`.

## 2. Directory Structure
```text
├── ARCHITECTURE.md                  # System architecture & wire protocol spec
├── LICENSE                          # MIT Open Source License
├── SECURITY.md                      # Security policy & cryptographic whitepaper
├── CONTRIBUTING.md                  # Contribution guidelines
├── bin/
│   └── sharedrop.js                 # Terminal CLI (send, receive, status, room)
├── scripts/
│   └── deploy-tunnel.sh             # Cloudflare Tunnel helper for sharedrop.sarthakml.in
├── src/server/
│   ├── config.js                    # Env vars, ICE servers, TTL & size limits
│   ├── identity.js                  # Proxy-aware IP grouping, deterministic names, UA parsing
│   ├── roomManager.js               # IP rooms, 6-digit pairing + pairSecret, 5-char public rooms
│   ├── signalingServer.js           # WebSocket (/ws) signaling, text beam, binary WS relay
│   ├── dropRoutes.js                # REST endpoints (/api/config, /api/qr, /api/drop, /d/:code)
│   └── index.js                     # Express + WS HTTP server bootstrap & graceful lifecycle
├── public/
│   ├── index.html                   # App shell (Radar stage, Modals, Bottom Dock, Transfer Drawer)
│   ├── manifest.webmanifest         # PWA manifest with Web Share Target API
│   ├── sw.js                        # Service Worker (offline shell + share-target receiver)
│   ├── icons/icon.svg               # ShareDrop vector brand icon
│   ├── css/styles.css               # Editorial warm light/dark design system & radar animations
│   └── js/
│       ├── network.js               # Reconnecting WebSocket client & signaling dispatcher
│       ├── webrtc.js                # RTCPeerConnection + 64KB chunked DataChannel + WS fallback
│       ├── ui.js                    # Radar DOM renderer, modals, audio chimes, notifications
│       └── app.js                   # Main controller wiring UI, Network, WebRTC, and PWA share target
└── tests/
    ├── roomManager.test.js          # Room, pairing, and secret persistence unit tests
    ├── signaling.test.js            # Multi-peer WebSocket signaling & Anti-IDOR integration tests
    └── dropApi.test.js              # Ephemeral HTTP drop & CLI upload/download E2E tests
```

## 3. WebSocket Wire Protocol (`/ws`)

### Client -> Server JSON Messages
- `{"type": "join-init", "displayName": "optional custom name", "pairSecrets": ["hex..."], "roomCode": "ABCDE"}`
- `{"type": "update-profile", "displayName": "New Name"}`
- `{"type": "create-pair-code"}` -> Server returns `{"type": "pair-code-created", "code": "123456", "expiresAt": 1700000000000}`
- `{"type": "join-pair-code", "code": "123456"}` -> Binds both peers with a new `pairSecret` and notifies both with `{"type": "pair-success", "pairSecret": "...", "peer": {...}}`
- `{"type": "create-room"}` -> Creates a 5-char public room and returns `{"type": "room-joined", "roomCode": "K7M9P", "peers": [...]}`
- `{"type": "join-room", "roomCode": "K7M9P"}` -> Joins the 5-char public room
- `{"type": "leave-room"}` -> Leaves current public room
- `{"type": "signal", "targetId": "peer-uuid", "signal": {...}}` -> WebRTC SDP `offer`/`answer` or `ice-candidate`
- `{"type": "file-offer", "targetId": "peer-uuid", "transferId": "tx-1", "files": [{"name": "a.png", "size": 1024, "type": "image/png"}], "totalSize": 1024, "mode": "webrtc|ws-relay"}`
- `{"type": "file-response", "targetId": "peer-uuid", "transferId": "tx-1", "accepted": true}`
- `{"type": "transfer-cancel", "targetId": "peer-uuid", "transferId": "tx-1", "reason": "user-cancelled"}`
- `{"type": "text-beam", "targetId": "peer-uuid", "id": "txt-1", "text": "https://sarthakml.in"}`
- `{"type": "ws-chunk-meta", "targetId": "peer-uuid", "transferId": "tx-1", "fileIndex": 0, "offset": 0, "size": 65536, "eof": false}`
- `{"type": "ws-chunk-ack", "targetId": "peer-uuid", "transferId": "tx-1", "offset": 65536}`
- Binary Frame (`Buffer`/`ArrayBuffer`): `[36-byte ASCII targetPeerId][36-byte ASCII transferId][raw chunk bytes]` routed directly to `targetPeerId` when in WebSocket Relay fallback mode.

### Server -> Client JSON Messages
- `{"type": "welcome", "peer": {...}, "iceServers": [...], "lanUrl": "...", "publicUrl": "https://sharedrop.sarthakml.in", "peers": [...]}`
- `{"type": "peers", "peers": [...]}`
- `{"type": "peer-joined", "peer": {...}, "sharedVia": "lan|paired|room"}`
- `{"type": "peer-left", "peerId": "..."}`
- `{"type": "peer-updated", "peer": {...}}`
- `{"type": "pair-code-created", "code": "123456", "expiresAt": ...}`
- `{"type": "pair-success", "pairSecret": "...", "peer": {...}}`
- `{"type": "room-joined", "roomCode": "ABCDE", "peers": [...]}`
- `{"type": "room-left"}`
- `{"type": "signal", "senderId": "...", "sender": {...}, "signal": {...}}`
- `{"type": "file-offer", "senderId": "...", "sender": {...}, "transferId": "...", "files": [...], "totalSize": ..., "mode": "..."}`
- `{"type": "file-response", "senderId": "...", "transferId": "...", "accepted": true}`
- `{"type": "transfer-cancel", "senderId": "...", "transferId": "...", "reason": "..."}`
- `{"type": "text-beam", "senderId": "...", "sender": {...}, "id": "...", "text": "...", "timestamp": ...}`
- `{"type": "drop-available", "drop": {"code": "X9K2M4", "files": [...], "totalSize": ..., "downloadUrl": "/d/X9K2M4", "expiresAt": ..., "sender": {...}}}`
- `{"type": "error", "code": "...", "message": "..."}`
