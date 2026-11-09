# Contributing to ShareDrop (`sharedrop.sarthakml.in`)

Thank you for your interest in contributing to ShareDrop! We welcome pull requests, bug reports, feature requests, and documentation improvements.

---

## 1. Development Principles & Code Standards

Before contributing, please review:
- [`ARCHITECTURE.md`](ARCHITECTURE.md): System wire protocol, room topology, and WebRTC streaming architecture.
- [`SECURITY.md`](SECURITY.md): Threat model, Anti-IDOR room isolation, and responsible disclosure guidelines.

### Core Standards
1. **Production-First Standard**: No dummy data arrays, placeholder handlers, or partial stubs. Every feature, modal, WebRTC DataChannel flow, and CLI command must work end-to-end.
2. **Anti-IDOR Security**: All signaling, text beams, and binary relay traffic must verify that both peers share an active room before forwarding.
3. **Flow-Controlled Chunking**: Keep WebRTC DataChannel chunk size at `65,536` bytes (`64 KB`) with `bufferedAmountLowThreshold = 524,288` (`512 KB`) for memory-bounded streaming.
4. **Theme & UX Consistency**: Follow the Warm Editorial Light/Dark theme (`#FAF8F5` canvas, `#18181B` deep ink, `#EA580C` terracotta, `#0D9488` teal). Ensure mobile touch targets remain `>= 48px`.

---

## 2. Local Environment Setup

ShareDrop runs on Node.js (v18+) or Bun (v1.1+).

```bash
# 1. Clone the repository
git clone https://github.com/sarvasva-dev/sharedrop-sarthakml.git
cd sharedrop-sarthakml

# 2. Install dependencies
bun install   # or npm install

# 3. Start local development server with hot-reload
bun run dev   # or npm run dev

# 4. Open http://localhost:3000 in your browser
```

---

## 3. Running Automated Tests

All pull requests must pass the automated test suite:

```bash
# Run unit & integration test suite with Bun
bun test

# Or run with Node
npm test
```

---

## 4. Submitting Pull Requests

1. **Create a Topic Branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Commit with Conventional Commits**:
   - `feat: add encrypted folder packaging`
   - `fix: resolve peer disconnect race condition`
   - `docs: update security whitepaper`
3. **Verify Tests**: Ensure `bun test` passes with 0 failures and 100% assertions green.
4. **Push & Open PR**:
   ```bash
   git push origin feat/your-feature-name
   ```
   Provide a clear summary of your changes, affected components, and manual testing steps.
