# opencode-central-mem

Fork of [opencode-mem](https://opencode.ai) with central server sync across machines, memory grooming (AI dedup/merge/reconcile), WebSocket real-time sync, cross-runtime (Bun + Node.js), and a web dashboard.

This plugin also bundles the client for [opencode-agent-hub](https://github.com/skyne/opencode-agent-hub) — agent-to-agent task delegation and capability routing. You can use one, the other, or both.

## Install Plugin (every peer machine running opencode)

```sh
# macOS / Linux
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz | tar xz && opencode plugin ./package

# Windows
curl -LO https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-plugin.tar.gz; tar xzf opencode-central-mem-plugin.tar.gz; opencode plugin ./package
```

Then configure `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "sync": { "url": "http://your-server:3737", "token": "your-token" },  // memory sync (optional)
  "hub":  { "url": "ws://your-server:3738", "token": "your-token" }    // agent hub (optional)
}
```

Use either or both — omit the sections you don't need.

## Deploy Central Server

```sh
# Bare metal (macOS / Linux)
curl -sL https://github.com/skyne/opencode-central-mem/releases/latest/download/opencode-central-mem-server.tar.gz | tar xz && npm install && AUTH_TOKEN=your-token npx tsx src/index.ts

# Docker
docker build -t central-mem-server server/ && docker run -d -p 3737:3737 -e AUTH_TOKEN=your-token -v mem-data:/app/data central-mem-server
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
