# opencode-central-mem

Fork of [opencode-mem](https://opencode.ai) with central server sync across machines, memory grooming (AI dedup/merge/reconcile), WebSocket real-time sync, and cross-runtime support (Bun + Node.js).

## Install

```sh
# macOS (Intel)
opencode plugin /path/to/client && opencode

# macOS (Apple Silicon)
opencode plugin /path/to/client && opencode

# Linux
opencode plugin /path/to/client && opencode

# Windows
opencode plugin C:\path\to\client && opencode
```

Configure `~/.config/opencode/opencode-mem.jsonc` with your central server URL and token.

## Server

```sh
git clone https://github.com/skyne/opencode-central-mem
cd opencode-central-mem/server
AUTH_TOKEN=your-token PORT=3737 npx tsx src/index.ts
```

Or deploy via Docker / systemd.
