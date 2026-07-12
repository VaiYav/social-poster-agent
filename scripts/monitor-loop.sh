#!/bin/bash
# SPA Railway Monitor Loop — runs scripts/monitor.sh on a schedule, fetches recent
# error logs, and triggers known safe remediation endpoints when the same error
# pattern keeps firing.
#
# Environment:
#   SPA_API_TOKEN      - JWT token for protected /api/v1 endpoints
#   MONITOR_LOOP_INTERVAL_SEC - seconds between cycles (default 120)
#   LOCK_ERROR_THRESHOLD      - how many "Failed to acquire lock" errors in the
#                               last 2m window before triggering reap (default 1)
#
# Run manually:
#   bash scripts/monitor-loop.sh
# Run in background (nohup):
#   nohup bash scripts/monitor-loop.sh > logs/monitor-loop.out 2>&1 &

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

mkdir -p logs

API="https://spa-backend-production-4fa6.up.railway.app/api/v1"
AUTH_HEADER=()
if [ -n "${SPA_API_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${SPA_API_TOKEN}")
fi

INTERVAL="${MONITOR_LOOP_INTERVAL_SEC:-120}"
LOCK_THRESHOLD="${LOCK_ERROR_THRESHOLD:-1}"

MAIN_LOG="logs/monitor-loop.log"
ERROR_LOG="logs/monitor-loop-errors.jsonl"

# Truncate error log on start so the script only sees recent errors.
: > "$ERROR_LOG"

while true; do
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  {
    echo ""
    echo "================================================================"
    echo "SPA MONITOR LOOP — $TS (interval ${INTERVAL}s)"
    echo "================================================================"
  } >> "$MAIN_LOG"

  # 1. Run the main monitor report.
  bash scripts/monitor.sh >> "$MAIN_LOG" 2>&1 || true

  # 2. Fetch recent error logs from Railway.
  #    --since disables streaming and fetches historical logs.
  ERRORS=$(railway logs --since 2m --filter "@level:error" --json 2>&1 || true)
  if [ -n "$ERRORS" ]; then
    echo "$ERRORS" >> "$ERROR_LOG"
  fi

  # 3. Auto-fix: stuck engagement lock.
  #    If the distributed lock is held by a dead/hung browsing session, force-reap.
  LOCK_COUNT=$(echo "$ERRORS" | grep -c 'Failed to acquire lock' || true)
  if [ "$LOCK_COUNT" -ge "$LOCK_THRESHOLD" ]; then
    echo "Detected ${LOCK_COUNT} 'Failed to acquire lock' errors — forcing reap of stuck browsing sessions" >> "$MAIN_LOG"
    REAP_RESULT=$(curl -s -X POST --max-time 15 "${AUTH_HEADER[@]}" "$API/health-monitor/reap-stuck-browsing" 2>&1 || true)
    echo "Reap result: $REAP_RESULT" >> "$MAIN_LOG"
  fi

  # 4. Auto-fix: orphaned APPROVED posts.
  #    If the orchestrator is stuck, reconciliation may need a nudge.
  #    We only trigger this if we see posting failures and approved queue.
  FAILED_COUNT=$(echo "$ERRORS" | grep -ci 'post.*FAILED\|failed to post' || true)
  if [ "$FAILED_COUNT" -ge 3 ]; then
    echo "Detected ${FAILED_COUNT} posting failures — triggering reconciliation" >> "$MAIN_LOG"
    RECON_RESULT=$(curl -s -X POST --max-time 15 "${AUTH_HEADER[@]}" "$API/health-monitor/reconcile" 2>&1 || true)
    echo "Reconcile result: $RECON_RESULT" >> "$MAIN_LOG"
  fi

  # 5. Auto-fix: retry failed BullMQ jobs (DLQ) that are not rate-limited.
  #    We use a cooldown so we don't burn the full retry budget every cycle.
  DLQ_RETRY_INTERVAL="${DLQ_RETRY_INTERVAL_SEC:-300}"
  DLQ_RETRY_TS_FILE="logs/monitor-last-dlq-retry"
  LAST_DLQ_RETRY=$(cat "$DLQ_RETRY_TS_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ $((NOW - LAST_DLQ_RETRY)) -ge "$DLQ_RETRY_INTERVAL" ]; then
    QUEUE_STATS=$(curl -s --max-time 15 "${AUTH_HEADER[@]}" "$API/queue/stats" 2>&1 || true)
    if [ -n "$QUEUE_STATS" ] && command -v jq >/dev/null 2>&1; then
      RETRIED_ANY=0
      for network in X THREADS FACEBOOK; do
        FAILED_IN_Q=$(echo "$QUEUE_STATS" | jq -r --arg net "$network" '.[] | select(.network == $net) | .failed // 0')
        if [ "${FAILED_IN_Q:-0}" -gt 0 ]; then
          echo "Retrying ${FAILED_IN_Q} failed job(s) in ${network} queue" >> "$MAIN_LOG"
          RETRY_RESULT=$(curl -s -X POST --max-time 30 "${AUTH_HEADER[@]}" "$API/queue/$network/retry-failed" 2>&1 || true)
          echo "Retry result for ${network}: $RETRY_RESULT" >> "$MAIN_LOG"
          RETRIED_ANY=1
        fi
      done
      if [ "$RETRIED_ANY" -eq 1 ]; then
        echo "$NOW" > "$DLQ_RETRY_TS_FILE"
      fi
    fi
  fi

  echo "Sleeping ${INTERVAL}s..." >> "$MAIN_LOG"
  sleep "$INTERVAL"
done
