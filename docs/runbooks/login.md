# Runbook: Manual Login

**Scenario:** Session expired or new account needs initial login.  
**Trigger:** Session status = EXPIRED, or new account seeded.  
**Impact:** Posts cannot be sent until session is active.

## Symptoms

- Posts stuck in APPROVED status (not transitioning to POSTING)
- Health monitor alert: "Session for {network} is EXPIRED"
- `GET /api/v1/sessions` shows status=EXPIRED

## Steps

### 1. Check session status

```bash
curl http://localhost:3100/api/v1/sessions
```

Look for `status: "EXPIRED"` on the affected network.

### 2. Trigger auto-login

The SessionsService auto-login will attempt to log in using credentials from env vars (`X_USERNAME`, `X_PASSWORD`, etc.).

```bash
curl -X POST http://localhost:3100/api/v1/sessions/refresh/X
```

If auto-login succeeds, session status → ACTIVE.

### 3. Manual login (if auto-login fails)

If auto-login fails (e.g., 2FA required, captcha):

1. Start the browser in headed mode:
   ```bash
   HEADED=true pnpm --filter backend start:dev
   ```

2. Open the SPA UI: http://localhost:3101

3. Go to Sessions page → click "Manual Login" for the affected network

4. A browser window opens — log in manually (solve captcha, 2FA)

5. After login, click "Save Session" — storage state is saved to DB

### 4. Verify

```bash
curl http://localhost:3100/api/v1/sessions
```

Session status should be `ACTIVE`.

### 5. Resume posting

```bash
curl -X POST http://localhost:3100/api/v1/posting/batch/all-approved
```

## Prevention

- Enable session warm-up (F20) for new accounts
- Health monitor (F21) alerts on EXPIRED sessions
- Auto-login runs automatically when getOrCreateSession is called
