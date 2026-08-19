# Runbook: Session Expired

**Scenario:** Browser session cookies expired — auto-login needed.  
**Trigger:** Health monitor (F21) reports session status=EXPIRED.  
**Impact:** Posts to this network will fail until session is refreshed.

## Symptoms

- Health monitor alert: "Session for {network} is EXPIRED — auto-login will be needed"
- Posts failing with "Session expired" or "Not logged in" errors
- `GET /api/v1/sessions` shows status=EXPIRED

## Steps

### 1. Check which sessions are expired

```bash
curl http://localhost:3100/api/v1/sessions
```

### 2. Trigger auto-login

```bash
# Refresh session for specific network
curl -X POST http://localhost:3100/api/v1/sessions/refresh/X
curl -X POST http://localhost:3100/api/v1/sessions/refresh/THREADS
curl -X POST http://localhost:3100/api/v1/sessions/refresh/FACEBOOK
```

Auto-login uses credentials from env vars:
- `X_USERNAME` / `X_PASSWORD`
- `THREADS_USERNAME` / `THREADS_PASSWORD`
- `FACEBOOK_USERNAME` / `FACEBOOK_PASSWORD`

### 3. If auto-login fails (2FA, captcha)

See [login runbook](./login.md) §3 for manual login steps.

### 4. Verify session is active

```bash
curl http://localhost:3100/api/v1/sessions
```

Status should be `ACTIVE`.

### 5. Run health check to clear alert

```bash
curl -X POST http://localhost:3100/api/v1/health-monitor/check
```

### 6. Resume posting

```bash
curl -X POST http://localhost:3100/api/v1/posting/batch/all-approved
```

## Session Lifecycle

```
NEW → ACTIVE → EXPIRED → (auto-login) → ACTIVE
                    ↓
                BANNED (if 5+ failures)
```

## Prevention

- Sessions auto-refresh when `getOrCreateSession` is called
- Health monitor (F21) checks session health hourly
- Warm-up mode (F20) keeps new sessions active with browse-only activity
- Session storage state saved to DB — survives restarts
