#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(dirname "$0")/../server"
AUTH_TOKEN="${AUTH_TOKEN:-$(openssl rand -hex 32)}"

echo "=== Deploying Central Memory Server ==="
echo "Auth token: $AUTH_TOKEN"
echo ""

# Build and deploy
docker compose -f "$(dirname "$0")/../docker-compose.yml" build server

# Save the auth token to a .env file
cat > "$(dirname "$0")/../.env" <<EOF
AUTH_TOKEN=$AUTH_TOKEN
EOF

echo ""
echo "=== Deploying to ailab ==="
echo "Run the following on ailab:"
echo ""
echo "  mkdir -p ~/opencode-central-mem"
echo "  cd ~/opencode-central-mem"
echo ""
echo "Then copy these files to ailab:"
echo "  server/         (entire directory)"
echo "  docker-compose.yml"
echo "  .env"
echo ""
echo "Via SCP:"
echo "  scp -r server docker-compose.yml .env ailab:~/opencode-central-mem/"
echo ""
echo "Then SSH into ailab and run:"
echo "  cd ~/opencode-central-mem && docker compose up -d"
echo ""
echo "The server will be available at http://ailab:3737"
echo "Auth token: $AUTH_TOKEN"
echo ""
echo "Add this to your opencode.jsonc:"
echo ""
echo '  "plugin": [["opencode-central-mem", {'
echo "    \"sync\": {"
echo "      \"url\": \"http://ailab:3737\","
echo "      \"token\": \"$AUTH_TOKEN\","
echo "      \"offline\": false"
echo "    }"
echo "  }]]"
echo ""
