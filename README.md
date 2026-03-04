# MoQ Test 3 — Raw MOQT (No Libraries)

Standalone video call app using a **raw MOQT implementation** (no @moq/lite). Connects to a moq-dev relay for real-time media streaming over QUIC.

## Prerequisites

- [Bun](https://bun.sh/) (or Node.js 20+)
- A running **moq-dev relay** (see below)

## Quick Start

```bash
bun install
bun dev
```

Opens on `http://localhost:3001`.

## Setting Up the Local Relay

The app needs a [moq-dev relay](https://github.com/moq-dev/moq) running locally on port **4443**.

### 1. Clone and build the relay

```bash
git clone https://github.com/moq-dev/moq.git
cd moq
```

Requires **Rust** toolchain and **just** command runner:

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install just (if needed)
cargo install just
```

### 2. Run the relay

```bash
just relay
```

This runs `cargo run --bin moq-relay -- dev/relay.toml` which:

- Starts the relay on **port 4443** (QUIC + HTTP on the same port)
- Auto-generates a **self-signed TLS certificate** for `localhost` (configured via `tls.generate = ["localhost"]` in `dev/relay.toml`)
- Serves the certificate fingerprint at `http://localhost:4443/certificate.sha256`

### 3. Certificates (automatic)

Chrome requires a certificate fingerprint to connect via WebTransport with self-signed certs. This is handled automatically:

- The relay generates a self-signed cert on startup and exposes its SHA-256 fingerprint at `http://localhost:4443/certificate.sha256`
- The app detects `localhost` and fetches the fingerprint automatically before connecting
- The fingerprint is passed to `WebTransport` via `serverCertificateHashes`

No manual certificate setup is needed for local development.

## Testing

1. Open two browser tabs to `http://localhost:3001`
2. Enter a room name (e.g., `test-room`) in the path field
3. Click **Publish** on the first tab — this publishes your camera/mic to the relay
4. Click **Subscribe** on the second tab — this subscribes to the published stream
5. Video and audio should stream in real-time between tabs

## Architecture

```
Browser (WebCodecs + WebTransport)
    |
    | QUIC (port 4443, self-signed cert + fingerprint)
    |
moq-dev relay (Rust, MOQT draft-14)
    |
    | QUIC
    |
Browser (WebCodecs + WebTransport)
```

## Stack

- SolidJS 1.9 + @solidjs/router
- Raw MOQT implementation (src/moq/) — no @moq/lite dependency
- WebCodecs for encoding/decoding video and audio
- MP4Box.js for CMAF container format
- RSBuild + Tailwind 4 + @pathscale/ui
