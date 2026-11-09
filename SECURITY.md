# Security Policy — ShareDrop (`sharedrop.sarthakml.in`)

## 1. Security Architecture & Threat Model

ShareDrop is designed with a **Zero-Knowledge, Zero-Retention Security Architecture**.
The platform operates under the principle that user files, clipboard contents, and communication metadata should never be stored, logged, or inspectable by server infrastructure.

### Cryptographic Guarantees
- **Peer-to-Peer Encryption (WebRTC DTLS-SRTP)**: All direct browser-to-browser transfers use Datagram Transport Layer Security (DTLS 1.2 / 1.3) with ephemeral 256-bit AES-GCM cipher suites. Encryption keys are negotiated directly between peer browsers via standard Diffie-Hellman key exchange; the signaling server never possesses or inspects decryption keys.
- **Strict Anti-IDOR Room Isolation**: The signaling server validates that both `senderId` and `targetId` are mutually verified members of the same room (`ipRoom`, `pairedRoom`, or `publicRoom`) before routing WebRTC SDP offers, ICE candidates, text beams, or binary relay chunks. Unauthorized cross-room signal injection is immediately dropped.
- **Ephemeral Relay Memory Bounding**: Fallback HTTP and WebSocket relay transfers are stored in temporary memory with an automatic 15-minute Time-To-Live (TTL) expiration sweep and optional one-time burn-after-reading.
- **Token-Bucket Rate Limiting**: All WebSocket connections and pair code redemption endpoints enforce per-socket and per-IP rate limits to prevent brute-force attacks on 6-digit codes and signaling denial-of-service.

---

## 2. Supported Versions

| Version | Supported | Security Updates |
| :--- | :--- | :--- |
| `1.x.x` | :white_check_mark: | Active support & continuous patches |
| `< 1.0.0` | :x: | End of Life (upgrade required) |

---

## 3. Reporting a Vulnerability

We welcome responsible, coordinated vulnerability disclosures from security researchers and the open-source community.

### Disclosure Protocol
- **Primary Security Email**: `security@sarthakml.in`
- **Maintainer Direct Email**: `ss8971132@gmail.com`
- **Maintainer Profile**: [Sarthak Srivastava](https://sarthakml.in) · [@sarvasva-dev](https://github.com/sarvasva-dev)

**Please do NOT open public GitHub issues for sensitive security vulnerabilities.**

### What to Include
When reporting a security vulnerability, please provide:
1. Detailed description of the vulnerability, including attack vector and potential impact.
2. Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
3. Any relevant network traces, HTTP headers, or WebSocket frame dumps.
4. Suggested mitigation or remediation if available.

### Response Commitment & SLA
- **Initial Acknowledgment**: Within **24 to 48 hours**.
- **Triage & Severity Assessment**: Within **3 business days**.
- **Remediation & Patch Deployment**: Targeted within **7 business days** depending on complexity.
- **Public Disclosure**: Coordinated after the fix is verified and deployed to production on `sharedrop.sarthakml.in`.

We credit all contributing researchers in our release notes and Hall of Fame.
