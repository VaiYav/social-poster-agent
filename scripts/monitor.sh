#!/bin/bash
# SPA Railway Monitor — fetches recent logs + API health, summarizes agent state.
# Run in a loop: while true; do bash scripts/monitor.sh; sleep 720; done

API="https://spa-backend-production-4fa6.up.railway.app/api/v1"
TS=$(date '+%Y-%m-%d %H:%M:%S')

# Optional JWT token for protected endpoints (set SPA_API_TOKEN in your environment).
AUTH_HEADER=()
if [ -n "$SPA_API_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${SPA_API_TOKEN}")
fi

echo "================================================================"
echo "SPA MONITOR — $TS"
echo "================================================================"

# 1. Railway logs — last 15 minutes
echo ""
echo "--- RAILWAY LOGS (last 15m) ---"
railway logs --latest --since 15m -n 500 2>&1 | grep -v "Mounting volume" | tail -200

# 2. Key events extraction
echo ""
echo "--- KEY EVENTS ---"
LOGS=$(railway logs --latest --since 15m -n 500 2>&1 | grep -v "Mounting volume")

# Errors & warnings
echo "$LOGS" | grep -i "ERROR\|FATAL\|crash\|exception\|ECONNREFUSED\|unhandledRejection" | grep -v "DEBUG" | tail -10
echo ""
echo "--- WARNINGS ---"
echo "$LOGS" | grep -i "WARN" | grep -v "DEBUG" | tail -15

# Orchestrator decisions
echo ""
echo "--- ORCHESTRATOR DECISIONS ---"
echo "$LOGS" | grep "Decision:" | tail -10

# Orchestrator cycles
echo ""
echo "--- CYCLES ---"
echo "$LOGS" | grep "Cycle .* ended" | tail -5

# Post events (enqueued, posted, failed)
echo ""
echo "--- POST EVENTS ---"
echo "$LOGS" | grep -i "Enqueued posting\|POSTED\|post.*FAILED\|post.*APPROVED\|reaped\|reconciliation" | tail -15

# Browser events
echo ""
echo "--- BROWSER EVENTS ---"
echo "$LOGS" | grep -i "Camoufox launched\|Context created\|Context pool\|scroll_feed\|Browsing session\|verifyPosted\|SelectorHealth" | tail -10

# LLM events
echo ""
echo "--- LLM EVENTS ---"
echo "$LOGS" | grep -i "LLM success\|LLM fallback\|LLM error\|circuit breaker\|provider" | tail -10

# Engagement events
echo ""
echo "--- ENGAGEMENT EVENTS ---"
echo "$LOGS" | grep -i "browsing session\|like\|comment\|follow\|reply\|repost\|engagement" | grep -v DEBUG | tail -10

# 3. API endpoints (may 502 during browser ops)
echo ""
echo "--- API HEALTH ---"
HEALTH=$(curl -s --max-time 10 "$API/health" 2>&1)
echo "Health: $HEALTH"

ORCH=$(curl -s --max-time 15 "${AUTH_HEADER[@]}" "$API/orchestrator/status" 2>&1)
echo "Orchestrator: $ORCH"

QUEUE=$(curl -s --max-time 15 "${AUTH_HEADER[@]}" "$API/queue/stats" 2>&1)
echo "Queue: $QUEUE"

DASH=$(curl -s --max-time 15 "${AUTH_HEADER[@]}" "$API/health-monitor/dashboard" 2>&1)
echo "Dashboard: $DASH"

echo ""
echo "================================================================"
echo "MONITOR CYCLE COMPLETE — $TS"
echo "================================================================"
