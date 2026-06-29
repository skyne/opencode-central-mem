# opencode-central-mem

Fork of [opencode-mem](https://opencode.ai) with central server sync across machines, memory grooming (AI dedup/merge/reconcile), WebSocket real-time sync, cross-runtime (Bun + Node.js), and a web dashboard.

## Install Plugin (every peer machine running opencode)

```sh
# macOS (Intel / Apple Silicon)
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz | tar xz && opencode plugin ./package

# Linux
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz | tar xz && opencode plugin ./package

# Windows (PowerShell)
curl -LO https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz; tar xzf opencode-central-mem-plugin.tar.gz; opencode plugin ./package
```

Then configure `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{ "sync": { "url": "http://your-server:3737", "token": "your-token" } }
```

## Deploy Central Server

```sh
# Bare metal (macOS / Linux)
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-server.tar.gz | tar xz && cd server && npm install && AUTH_TOKEN=your-token npx tsx src/index.ts

# Docker
docker run -d -p 3737:3737 -e AUTH_TOKEN=your-token -v mem-data:/app/data ghcr.io/skyne/opencode-central-mem
```

## Quick Start

```sh
# 1. Install plugin
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz | tar xz && opencode plugin ./package

# 2. Start server
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-server.tar.gz | tar xz && cd server && npm install && AUTH_TOKEN=dev npx tsx src/index.ts

# 3. Open opencode — memories auto-sync
opencode
```
