#!/bin/bash
# SPA production monitor — checks health, auth, orchestrator, and Camoufox.
# Usage: ./scripts/monitor.sh [--once]
#   --once: single check, exit 0 if healthy, 1 if not
#   without --once: loops every 60s, Ctrl-C to stop

set -eu

BASE_URL="https://spa-backend-production-4fa6.up.railway.app"
ADMIN_USER="admin"
ADMIN_PASS="44u3VoabEUK8Cqz9oBBEIKS"
INTERVAL=60
ONCE=false

[[ "${1:-}" == "--once" ]] && ONCE=true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

check() {
    local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "=== $ts ==="
    local errors=0

    # 1. Health endpoint (no auth)
    local health; health=$(curl -s -m 10 -w '\n%{http_code}' "$BASE_URL/api/v1/health" 2>&1 || echo "curl failed")
    local hcode; hcode=$(echo "$health" | tail -1)
    local hbody; hbody=$(echo "$health" | sed '$d')

    if [[ "$hcode" == "200" ]]; then
        local db; db=$(echo "$hbody" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('database','?'))" 2>/dev/null || echo "?")
        local rd; rd=$(echo "$hbody" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('redis','?'))" 2>/dev/null || echo "?")
        ok "Health 200 — db=$db redis=$rd"
    else
        fail "Health endpoint returned $hcode: $hbody"
        errors=$((errors + 1))
    fi

    # 2. Auth + orchestrator status
    local token; token=$(curl -s -m 10 -X POST "$BASE_URL/api/v1/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
        -c - 2>/dev/null | grep spa_token | awk '{print $NF}')

    if [[ -z "$token" ]]; then
        fail "Auth login failed"
        errors=$((errors + 1))
    else
        ok "Auth login OK"

        local orch; orch=$(curl -s -m 10 -H "Cookie: spa_token=$token" \
            "$BASE_URL/api/v1/orchestrator/status" 2>/dev/null || echo '{}')

        local enabled; enabled=$(echo "$orch" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('enabled','?'))" 2>/dev/null || echo "?")
        local running; running=$(echo "$orch" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('running','?'))" 2>/dev/null || echo "?")
        local cycle; cycle=$(echo "$orch" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('cycle','?'))" 2>/dev/null || echo "?")
        local hb; hb=$(echo "$orch" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('heartbeatAgeMs',0))" 2>/dev/null || echo 0)

        if [[ "$enabled" == "True" || "$enabled" == "true" ]]; then
            if [[ "$running" == "True" || "$running" == "true" ]]; then
                # heartbeat should be < 120000ms (2 min)
                if [[ "$hb" -lt 120000 ]]; then
                    ok "Orchestrator running — cycle=$cycle, heartbeat=${hb}ms ago"
                else
                    warn "Orchestrator running but heartbeat stale (${hb}ms ago)"
                fi
            else
                warn "Orchestrator enabled but not running"
            fi
        else
            warn "Orchestrator disabled (enabled=$enabled)"
        fi
    fi

    # 3. Recent errors in deploy logs (Camoufox / crashes)
    local err_count; err_count=$(railway logs -n 200 -f "@level:error" 2>&1 | grep -c "Camoufox is not installed" || true)
    if [[ "$err_count" -eq 0 ]]; then
        ok "No 'Camoufox not installed' errors in recent logs"
    else
        fail "$err_count 'Camoufox not installed' errors in recent logs"
        errors=$((errors + 1))
    fi

    # 4. Check for browser launch success in recent logs
    local launch_ok; launch_ok=$(railway logs -n 200 2>&1 | grep -c "Camoufox launched" || true)
    if [[ "$launch_ok" -gt 0 ]]; then
        ok "Camoufox launched successfully ($launch_ok times in recent logs)"
    else
        warn "No recent Camoufox launch in logs (may not have been needed yet)"
    fi

    echo "---"
    if [[ $errors -eq 0 ]]; then
        ok "All checks passed"
    else
        fail "$errors check(s) failed"
    fi

    return $errors
}

if $ONCE; then
    check
    exit $?
else
    echo "Monitoring SPA production at $BASE_URL (every ${INTERVAL}s, Ctrl-C to stop)"
    echo ""
    while true; do
        check || true
        echo ""
        sleep "$INTERVAL"
    done
fi
