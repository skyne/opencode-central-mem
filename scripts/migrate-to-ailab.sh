#!/usr/bin/env bash
set -euo pipefail

# Migration script: export local server DB → transfer to ailab → import
# Run this when you've been running the server locally and want to move to ailab.

LOCAL_DB="./server/data/memories.db"
AILAB_HOST="ailab"
AILAB_DIR="~/opencode-central-mem"
AUTH_TOKEN="${AUTH_TOKEN:-}"
DEFAULT_TOKEN="${DEFAULT_TOKEN:-migration-token}"

if [ ! -f "$LOCAL_DB" ]; then
  echo "❌ No local database found at $LOCAL_DB"
  echo "   Have you been running the server locally?"
  exit 1
fi

echo "=== Step 1: Export local memories ==="
AUTH_TOKEN=$DEFAULT_TOKEN bun run --cwd server src/index.ts &
SERVER_PID=$!
sleep 2

curl -s "http://localhost:3737/memories/export" \
  -H "Authorization: Bearer $DEFAULT_TOKEN" \
  -o /tmp/memories-export.json

kill $SERVER_PID 2>/dev/null || true

COUNT=$(python3 -c "import json;d=json.load(open('/tmp/memories-export.json'));print(d['count'])")
echo "Exported $COUNT memories"

if [ "$COUNT" -eq 0 ]; then
  echo "❌ No memories to migrate"
  exit 0
fi

echo ""
echo "=== Step 2: Check if ailab is reachable ==="
if ssh -o ConnectTimeout=5 "$AILAB_HOST" "echo connected" 2>/dev/null; then
  echo "✅ ailab is reachable"
else
  echo "⚠️  ailab is not reachable. The export is saved at /tmp/memories-export.json"
  echo "   Copy it manually later and run:"
  echo "     curl -X POST http://ailab:3737/memories/import \\"
  echo "       -H 'Authorization: Bearer <token>' \\"
  echo "       -H 'Content-Type: application/json' \\"
  echo "       -d @/tmp/memories-export.json"
  exit 0
fi

echo ""
echo "=== Step 3: Transfer export to ailab ==="
scp /tmp/memories-export.json "$AILAB_HOST:$AILAB_DIR/import.json"

echo ""
echo "=== Step 4: Import on ailab ==="
AILAB_TOKEN=$(ssh "$AILAB_HOST" "grep AUTH_TOKEN $AILAB_DIR/.env 2>/dev/null | cut -d= -f2" || echo "")
if [ -n "$AILAB_TOKEN" ]; then
  ssh "$AILAB_HOST" "curl -s -X POST http://localhost:3737/memories/import \
    -H 'Authorization: Bearer $AILAB_TOKEN' \
    -H 'Content-Type: application/json' \
    -d @$AILAB_DIR/import.json"
  echo ""
  echo "✅ Migration complete!"
else
  echo "⚠️  Could not read AUTH_TOKEN from ailab. Import manually:"
  echo "   ssh $AILAB_HOST"
  echo "   curl -X POST http://localhost:3737/memories/import \\"
  echo "     -H 'Authorization: Bearer <token>' \\"
  echo "     -H 'Content-Type: application/json' \\"
  echo "     -d @$AILAB_DIR/import.json"
fi

rm -f /tmp/memories-export.json
