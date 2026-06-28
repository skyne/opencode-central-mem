#!/usr/bin/env bash
set -euo pipefail

# CLI tool for managing the central memory server
# Usage: ./scripts/central-mem.sh <command> [options]

SERVER="${CENTRAL_MEM_URL:-http://localhost:3737}"
TOKEN="${CENTRAL_MEM_TOKEN:-}"

usage() {
  cat <<EOF
Central Memory CLI — Manage your central memory server

Usage: central-mem.sh <command> [options]

Commands:
  health                    Check server health
  add <content> [tags..]    Add a memory (comma-separated tags)
  search <query>            Search memories by keyword
  list [limit]              List recent memories
  get <id>                  Get memory by ID
  update <id> <field=value> Update a memory field (tags=tag1,tag2)
  delete <id>               Delete a memory
  stats                     Show memory statistics
  export [scope]            Export all memories (optionally by scope)
  import <file>             Import memories from JSON file
  watch                     Watch for changes (tail -f on new memories)

Options:
  --server <url>    Server URL (default: \$CENTRAL_MEM_URL or http://localhost:3737)
  --token <token>   Auth token (default: \$CENTRAL_MEM_TOKEN)

Examples:
  central-mem.sh search "deployment configuration"
  central-mem.sh add "Remember to use Bun for the server" "bun,server,tip"
  central-mem.sh stats --server http://ailab:3737 --token mytoken
EOF
  exit 1
}

[ $# -eq 0 ] && usage

CMD="$1"
shift

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) break ;;
  esac
done

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" "$SERVER$path" -H "Authorization: Bearer $TOKEN")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}"
}

case "$CMD" in
  health)
    api GET /health
    ;;
  add)
    [ $# -lt 1 ] && echo "Usage: central-mem.sh add <content> [tags]" && exit 1
    content="$1"; tags="${2:-general}"
    api POST /memories "{\"content\":$(echo "$content" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))'),\"tags\":$(echo "$tags" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip().split(\",\")))'),\"scope\":\"project\"}"
    ;;
  search)
    [ $# -lt 1 ] && echo "Usage: central-mem.sh search <query>" && exit 1
    query="$1"
    api GET "/memories/search?q=$(echo "$query" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))' | tr -d '"' | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')&limit=10" | python3 -m json.tool 2>/dev/null || api GET "/memories/search?q=$query&limit=10"
    ;;
  list)
    limit="${1:-10}"
    api GET "/memories/search?limit=$limit" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d['results'][:${limit}]:
    print(f\"  [{r['id'][:8]}] {r['content'][:80]}\")
print(f\"\n{d['total'] if 'total' in d else len(d['results'])} memories\")
" 2>/dev/null || api GET "/memories/search?limit=$limit"
    ;;
  get)
    [ $# -lt 1 ] && echo "Usage: central-mem.sh get <id>" && exit 1
    api GET "/memories/$1" | python3 -m json.tool 2>/dev/null || api GET "/memories/$1"
    ;;
  update)
    [ $# -lt 2 ] && echo "Usage: central-mem.sh update <id> <field=value>" && exit 1
    id="$1"; field="${2%%=*}"; value="${2#*=}"
    case "$field" in
      tags) api PUT "/memories/$id" "{\"tags\":$(echo "$value" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip().split(\",\")))')}" ;;
      content) api PUT "/memories/$id" "{\"content\":$(echo "$value" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))')}" ;;
      *) echo "Unknown field: $field (supported: tags, content)" && exit 1 ;;
    esac
    ;;
  delete)
    [ $# -lt 1 ] && echo "Usage: central-mem.sh delete <id>" && exit 1
    api DELETE "/memories/$1"
    ;;
  stats)
    api GET /memories/stats | python3 -m json.tool 2>/dev/null || api GET /memories/stats
    ;;
  export)
    scope="${1:-}"
    if [ -n "$scope" ]; then
      api GET "/memories/export/$scope" | python3 -m json.tool
    else
      api GET /memories/export | python3 -m json.tool
    fi
    ;;
  import)
    [ $# -lt 1 ] && echo "Usage: central-mem.sh import <file>" && exit 1
    file="$1"
    if [ ! -f "$file" ]; then echo "File not found: $file"; exit 1; fi
    data=""
    if python3 -c "import json;d=json.load(open('$file'));print('count' in d or 'memories' in d)" 2>/dev/null | grep -q true; then
      data=$(cat "$file")
    else
      data="{\"memories\":$(cat "$file")}"
    fi
    api POST /memories/import "$data"
    ;;
  watch)
    echo "Watching for new memories... (Ctrl+C to stop)"
    while true; do
      api GET "/memories/search?limit=5" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d['results']:
    print(f\"[{r['updated_at']}] {r['content'][:100]}\")
" 2>/dev/null || true
      sleep 5
    done
    ;;
  *)
    usage
    ;;
esac
