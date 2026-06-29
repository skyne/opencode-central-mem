#!/bin/bash
set -euo pipefail

SERVER="ailab"
REMOTE_DIR="~/opencode-central-mem"
AUTH_TOKEN="${AUTH_TOKEN:-ailab-prod-20260628}"

echo "=== Deploying central-mem-server to $SERVER ==="

tar czf - server/ | ssh "$SERVER" "tar xzf - -C $REMOTE_DIR"
echo "  Files copied"

ssh "$SERVER" "cd $REMOTE_DIR/server && npm install 2>&1 | tail -1"
echo "  Dependencies installed"

ssh "$SERVER" "sudo systemctl restart central-mem"
echo "  Service restarted"

sleep 2
ssh "$SERVER" "curl -s http://localhost:3737/health"
echo ""
echo "=== Deploy complete ==="
TS_IP=$(ssh "$SERVER" "tailscale ip -4" 2>/dev/null || echo "unknown")
echo "Dashboard: http://$TS_IP:3737 (Tailscale)"
