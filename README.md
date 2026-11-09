# ShareDrop

[![Build Status](https://img.shields.io/badge/build-passing-0D9488.svg?style=flat-square)](https://sharedrop.sarthakml.in)
[![Protocol](https://img.shields.io/badge/protocol-RFC%208831%20WebRTC-EA580C.svg?style=flat-square)](docs/PROTOCOL.md)
[![Encryption](https://img.shields.io/badge/security-DTLS%201.3%20%2F%20AES--256--GCM-18181B.svg?style=flat-square)](https://sharedrop.sarthakml.in/security)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

A production-grade, zero-configuration peer-to-peer file transfer engine engineered for direct browser-to-browser streaming over WebRTC DataChannels, dual-transport WebSocket relay fallback, and headless Unix CLI tooling.

- **Live Production Service:** [https://sharedrop.sarthakml.in](https://sharedrop.sarthakml.in)
- **Wire Protocol Specification:** [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- **Manual Page:** [`man/sharedrop.1`](man/sharedrop.1)

---

## Architectural Invariants

1. **Zero Server Storage ($O(1)$ Memory Footprint):**  
   Files never buffer to disk on the signaling server. The streaming pipeline partitions payloads into fixed 64 KB slices, paced by kernel backpressure control (`bufferedAmountLowThreshold: 512 KB`). Memory consumption remains constant regardless of file size.

2. **Anti-IDOR Room Isolation:**  
   Signaling endpoints enforce strict mutual discovery invariants. Control frames (`signal`, `file-offer`, `text-beam`, `ws-chunk`) are rejected unless the sender and target concurrently share an active discovery domain (`ipRoom`, `publicRoom`, or `pairedRoom`).

3. **Deterministic Local Network Aggregation:**  
   Inspects incoming socket transport addresses. Private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1/8`) are aggregated into a zero-configuration local discovery domain without broadcasting raw client IPs.

4. **Resilient Dual-Transport Fallback:**  
   - **Primary:** Direct peer-to-peer WebRTC `RTCDataChannel` encrypted via DTLS 1.2/1.3 (AES-256-GCM).  
   - **Secondary Fallback:** Binary WebSocket tagged frame relay (`[36B Target UUID][36B Transfer UUID][Payload]`) when carrier CGNATs or symmetric NATs prevent ICE candidate pair binding.

5. **Cross-Network Cryptographic Pairing:**  
   Peers on separate physical networks exchange a 5-minute ephemeral 6-digit numeric token to negotiate a persistent 256-bit `pairSecret`, stored strictly in client-side storage (`localStorage`) for permanent mutual recognition.

---

## System Topology

```text
                           ┌─────────────────────────────────────────┐
                           │        sharedrop.sarthakml.in           │
                           │   (Caddy Auto-HTTPS / Cloudflare / Net) │
                           └────────────────────┬────────────────────┘
                                                │
                             ┌──────────────────┴──────────────────┐
                             │    Express + WS Gateway (Port 3000) │
                             │  - Identity & RFC1918 IP Pools      │
                             │  - Anti-IDOR Forwarding Barrier     │
                             │  - Ephemeral Drop TTL Sweep (60s)   │
                             └─────────┬─────────────────┬─────────┘
                                       │                 │
                     ┌─────────────────┴────┐       ┌────┴─────────────────┐
                     │   WebRTC DataChannel │       │ WebSocket Relay      │
                     │   (Direct P2P Stream)│       │ Fallback (Symmetric) │
                     │   64 KB stream chunks│       │ 72-byte tagged frame │
                     └──────────────────────┘       └──────────────────────┘
```

---

## Quickstart

### Prerequisites
- Node.js `>= 18.0.0` or Bun `>= 1.1.0`
- Modern browser supporting WebRTC (`RTCDataChannel`)

### Using `make` (Recommended)
```bash
# Clone the repository
git clone https://github.com/sarvasva-dev/sharedrop-sarthakml.git
cd sharedrop-sarthakml

# Run the test suite
make test

# Start the development server (http://localhost:3000)
make dev

# Run streaming throughput & memory benchmark
make bench
```

### Using Docker & Compose
```bash
# Launch the multi-stage container stack with automatic Caddy TLS
docker-compose up -d --build

# Inspect daemon logs
docker-compose logs -f
```

---

## Terminal CLI (`sharedrop`)

ShareDrop includes a standalone command-line client with zero external runtime dependencies.

```bash
# View usage synopsis
./bin/sharedrop.js --help

# Or link globally to $PATH
npm link
man ./man/sharedrop.1
```

### Usage Examples

```bash
# 1. Stream a file or directory tarball to an ephemeral drop with terminal QR
sharedrop send ./dist-v1.0.tar.gz

# 2. Beam directly to an ad-hoc 5-character public room
sharedrop send ./kernel.img --room TEAM1 --name "Server-Rack-02"

# 3. Beam a raw text string or clipboard URL
sharedrop send "https://sarthakml.in/keys/id_ed25519.pub" --room TEAM1

# 4. Download a drop by 6-character code into a target directory
sharedrop receive 7HJNYW -o ~/Downloads

# 5. Scripted JSON output for CI/CD pipelines
sharedrop send ./build.zip --json
```

---

## Benchmarks & Performance Verification

ShareDrop enforces memory-bounded streaming via `perf_hooks` and backpressure control:

```text
====================================================================
 ShareDrop Engine — Memory-Bounded Streaming Benchmark
====================================================================
 Payload Size   : 64.00 MB (67,108,864 bytes)
 Chunk Size     : 65,536 bytes (64 KB)
 Backpressure   : Low: 512 KB | High: 2,048 KB
--------------------------------------------------------------------
 Chunks Sent    : 1,024
 Stream Time    : 50.77 ms
 Throughput     : 1,260.69 MB/s (Local Memory Loopback)
 Pauses (Flow)  : 42 backpressure yields
 SHA-256 Digest : ad0a27747c371cca...48a899b7f94953d1
--------------------------------------------------------------------
 Initial Heap   : 5.49 MB (RSS: 57.12 MB)
 Final Heap     : 5.10 MB (RSS: 58.99 MB)
 Memory Delta   : Heap: -0.40 MB | RSS: +1.88 MB
====================================================================
 STATUS: PASS — Strict memory boundedness confirmed (< 15 MB variance).
```

Execute locally:
```bash
make bench
# or
node benchmarks/throughput.js
```

---

## Test Suite

```bash
# Execute unit, integration, and E2E HTTP drop tests
make test
# or
bun test
```

### Test Coverage Matrix
- `tests/roomManager.test.js`: RFC 1918 LAN pooling, Anti-IDOR isolation, 6-digit pair secret issuance, 5-char room lifecycle.
- `tests/dropApi.test.js`: Ephemeral `/api/drop` upload, `/d/:code` streaming download with exact bit-for-bit SHA-256 match, security headers, `/terms`, `/privacy`, `/security`, `/faq`.
- `tests/signaling.test.js`: Multi-peer WebSocket handshakes, SDP/ICE signaling, text beams, and binary relay framing.

---

## Production Deployment

### 1. Cloudflare Tunnel
```bash
# Launch ephemeral tunnel
bash scripts/deploy-tunnel.sh --quick

# Production tunnel with token
TUNNEL_TOKEN="your-token" bash scripts/deploy-tunnel.sh
```

### 2. Standalone VPS with Systemd
```ini
# /etc/systemd/system/sharedrop.service
[Unit]
Description=ShareDrop P2P Signaling Server
After=network.target

[Service]
Type=simple
User=sharedrop
WorkingDirectory=/opt/sharedrop
ExecStart=/usr/bin/node src/server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=PUBLIC_URL=https://sharedrop.sarthakml.in

[Install]
WantedBy=multi-user.target
```

---

## Security & Trust Governance

- **Terms of Service:** [`https://sharedrop.sarthakml.in/terms`](https://sharedrop.sarthakml.in/terms)
- **Privacy Policy:** [`https://sharedrop.sarthakml.in/privacy`](https://sharedrop.sarthakml.in/privacy)
- **Security Whitepaper:** [`https://sharedrop.sarthakml.in/security`](https://sharedrop.sarthakml.in/security)
- **FAQ:** [`https://sharedrop.sarthakml.in/faq`](https://sharedrop.sarthakml.in/faq)
- **Vulnerability Disclosure:** [`SECURITY.md`](SECURITY.md)

---

## License

ShareDrop is open-source software released under the [MIT License](LICENSE).  
Copyright &copy; 2026 Sarthak Srivastava (`https://sarthakml.in`).
