# ShareDrop Wire Protocol Specification

**Status:** Informational / Standard  
**Author:** Sarthak Srivastava (`https://sarthakml.in`)  
**Date:** November 2026  
**Standards References:** RFC 8831 (WebRTC Data Channels), RFC 8829 (JSEP), RFC 5389 (STUN), RFC 8446 (TLS 1.3)

---

## Abstract

This document defines the application-layer signaling, Anti-IDOR authentication, and dual-transport data framing protocol for **ShareDrop**, a zero-signup peer-to-peer file transfer engine. The protocol specifies the WebSocket signaling handshake (`/ws`), deterministic local area network discovery, 6-digit cross-network cryptographic pairing, and memory-bounded binary streaming across WebRTC DataChannels and WebSocket fallback relays.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in **RFC 2119**.

---

## 1. Network Topology & Discovery Architecture

ShareDrop operates on a hybrid topology combining lightweight real-time signaling with direct end-to-end peer data transport:

```
                  ┌─────────────────────────────────────────┐
                  │        Signaling Hub (WebSocket)        │
                  │ - RFC 1918 LAN Aggregation             │
                  │ - Anti-IDOR Forwarding Barrier          │
                  │ - 6-Digit Pair Code State Machine       │
                  └──────────────┬───────────────────┬──────┘
                                 │                   │
                 SDP / ICE       │                   │ SDP / ICE
                 Signaling       │                   │ Signaling
                                 ▼                   ▼
                          ┌─────────────┐     ┌─────────────┐
                          │ Peer Node A │     │ Peer Node B │
                          └──────┬──────┘     └──────┬──────┘
                                 │                   │
                                 │◄─────────────────►│
                                   WebRTC DataChannel
                                 (DTLS AES-256-GCM / 64KB)
```

### 1.1 Discovery Domains
Peers discover and establish connectivity through three mutually isolated discovery domains:

1. **Local Area Network (LAN) Discovery:**  
   The signaling server inspects the source IPv4/IPv6 address of incoming connections. Local RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1/8`) are normalized into a shared `ip:lan-local` discovery pool. Public IPs are normalized to their `/24` (IPv4) or `/48` (IPv6) subnet prefixes.

2. **Cross-Network 6-Digit Pairing:**  
   Peers on disparate networks (e.g., cellular LTE/5G and corporate Wi-Fi) exchange a 6-digit numeric token (`100000..999999`) with a 5-minute Time-To-Live (TTL). Upon redemption, both peers receive a 256-bit cryptographically secure `pairSecret`. Both peers persist this secret in client-side storage (`localStorage`) and automatically join a shared room derived from `paired:sha256(pairSecret)`.

3. **Public Temporary Rooms:**  
   Peers may join an explicit 5-character alphanumeric room identifier (`[A-Z0-9]{5}`).

---

## 2. Anti-IDOR Mutual Membership Invariant

Insecure signaling systems often allow arbitrary clients to inject messages to any known UUID. ShareDrop eliminates Insecure Direct Object References (IDOR) by enforcing a strict mathematical invariant at the signaling gateway:

$$\forall (p_{\text{sender}}, p_{\text{target}}), \quad \text{AllowForward}(p_{\text{sender}} \to p_{\text{target}}) \iff \text{Rooms}(p_{\text{sender}}) \cap \text{Rooms}(p_{\text{target}}) \neq \emptyset$$

If two peers do not share at least one active room (`ipRoom`, `publicRoom`, or `pairedRoom`), the signaling server **MUST** drop the packet immediately and emit an `UNAUTHORIZED_TARGET` error frame to the sender.

---

## 3. Signaling Message Specifications (`/ws`)

All control messages exchanged over the WebSocket connection (`/ws`) are serialized as UTF-8 encoded JSON objects.

### 3.1 Session Initialization (`join-init`)
Sent by the client immediately upon establishing the WebSocket connection.

```json
{
  "type": "join-init",
  "displayName": "Pixel-8",
  "pairSecrets": ["9f83c18b..."],
  "roomCode": "TEAM1"
}
```

**Server Response (`welcome`):**
```json
{
  "type": "welcome",
  "peer": {
    "id": "c1f7b9e0-8b1e-4c3e-9f0a-1a2b3c4d5e6f",
    "displayName": "Pixel-8",
    "deviceType": "mobile",
    "os": "Android",
    "browser": "Chrome"
  },
  "peers": [...]
}
```

### 3.2 Ephemeral Pair Code Exchange
- **Request (`create-pair-code`):** Generates a random 6-digit code.
  - Server returns: `{"type": "pair-code-created", "code": "482910", "expiresAt": 1794226800000}`
- **Join (`join-pair-code`):**
  - Payload: `{"type": "join-pair-code", "code": "482910"}`
  - Rate limiting: Maximum 5 failed attempts per client IP per minute.
  - Server response on match (`pair-success`):
    ```json
    {
      "type": "pair-success",
      "pairSecret": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "peer": { "id": "...", "displayName": "MacBook Pro" }
    }
    ```

### 3.3 WebRTC Signaling (`signal`)
Relays SDP offers, answers, and ICE candidates between authorized peers:

```json
{
  "type": "signal",
  "targetId": "c1f7b9e0-8b1e-4c3e-9f0a-1a2b3c4d5e6f",
  "signal": {
    "type": "offer",
    "sdp": "v=0\r\no=- 461173... IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n..."
  }
}
```

---

## 4. Binary Relay Transport Framing (Fallback Mode)

When network conditions (such as Symmetric NAT or restrictive corporate packet filters) prevent direct ICE candidate pair binding, the protocol falls back to binary WebSocket relay streaming.

### 4.1 Packet Frame Layout
Relay chunks MUST be transmitted as single unfragmented binary frames formatted as follows:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|               Target Peer UUID (36 octets, ASCII)             |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|              Transfer Session UUID (36 octets, ASCII)         |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|              Raw Binary Chunk Payload (Up to 64 KB)           |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **Octets 0x00 .. 0x23 (36 bytes):** Canonical UUID string of the target peer.
- **Octets 0x24 .. 0x47 (36 bytes):** Canonical UUID string identifying the transfer session.
- **Octets 0x48 .. End:** Raw slice data (maximum 65,536 octets).

The relay server parses the 36-byte target prefix, validates the Anti-IDOR mutual room membership, and forwards the trailing slice payload without parsing or buffering the payload bytes to disk.

---

## 5. Streaming Flow Control & Backpressure

To achieve deterministic memory consumption during multi-gigabyte file transfers, transmitters **MUST** enforce backpressure pacing:

```text
Transmitter State Machine:
1. Slice payload into 65,536-byte (64 KB) chunks.
2. Dispatch chunk across RTCDataChannel.
3. If channel.bufferedAmount > HIGH_WATERMARK (2,097,152 bytes / 2 MB):
     HALT transmission.
     Wait for bufferedamountlow event (LOW_WATERMARK = 524,288 bytes / 512 KB).
4. Resume dispatching subsequent slices until EOF.
```

This ensures the transmitter's heap memory footprint remains constant ($O(1)$) regardless of whether transferring a 2 MB photo or a 50 GB dataset.

---

## 6. Cryptographic Security Standards

1. **Transport Encryption:** All WebRTC peer connections mandate **DTLS 1.2 or 1.3** utilizing `TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384` or `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`.
2. **Ephemeral TTL Enforcement:** Unclaimed HTTP fallback drops and pairing codes are purged from memory by scheduled sweeps every 60 seconds with strict 15-minute / 5-minute TTL expirations.
3. **Hardened HTTP Headers:** All HTTP endpoints enforce `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`.
