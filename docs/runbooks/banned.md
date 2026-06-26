# Runbook: Account Banned

**Scenario:** Social platform has banned or shadow-banned the account.  
**Trigger:** Health monitor (F21) detects 5+ consecutive posting failures.  
**Impact:** All posts to this network will fail. Account needs cooldown or replacement.

## Symptoms

- Health monitor alert: "Account {id} ({network}) appears BANNED — N consecutive failures"
- Posts failing with login-related errors (not rate limit)
- Session status = BANNED (set by health monitor)
- SSE event: `health_alert` with severity=critical

## Steps

### 1. Confirm the ban

Check the platform directly:
- **X**: Log in manually — check for "Account suspended" message
- **Threads**: Log in via Instagram — check for restrictions
- **Facebook**: Log in — check for "Your account is restricted"

### 2. Pause posting for this network

```bash
# Deactivate the account (stops new posts from being queued)
curl -X PATCH http://localhost:3100/api/v1/accounts/{accountId} \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
```

### 3. Review failed posts

```bash
curl "http://localhost:3100/api/v1/posts?status=FAILED&network=X"
```

Check `errorMessage` fields for ban confirmation messages.

### 4. Attempt appeal (if platform allows)

- **X**: https://help.twitter.com/forms/general?subtopic=suspended
- **Facebook**: https://www.facebook.com/help/contact/260749603972907
- **Threads**: Appeal via Instagram help

### 5. Cooldown period (7-14 days)

If not permanently banned:
1. Keep account deactivated
2. After cooldown, re-activate with warm-up mode (F20):
   ```bash
   curl -X PATCH http://localhost:3100/api/v1/accounts/{accountId} \
     -H "Content-Type: application/json" \
     -d '{"active": true, "warmupEnabled": true}'
   ```

### 6. Replace account (if permanently banned)

1. Create new account on the platform
2. Update env vars with new credentials
3. Seed new account:
   ```bash
   curl -X POST http://localhost:3100/api/v1/accounts/seed
   ```
4. Enable warm-up mode for the new account

## Prevention

- Always use warm-up mode (F20) for new accounts
- Respect rate limits (1 post/day per network)
- Use human-like delays (10-30s between actions)
- Don't post duplicate content (SimHash dedup — B5)
