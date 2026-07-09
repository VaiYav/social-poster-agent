# Module: `infrastructure/crypto`

## 1. What this module does

`infrastructure/crypto` provides the backend's encryption at-rest for sensitive data. Currently, the only concrete use is **AES-256-GCM encryption of Playwright `storageState` (cookies, localStorage)** before it is stored in PostgreSQL. Without this, a database leak would expose active social-media session cookies and allow account takeover.

Key responsibilities:

- Derive a 256-bit key from the `SESSION_ENCRYPTION_KEY` env var (64 hex characters).
- Encrypt arbitrary JSON-serializable data with a random 96-bit IV and 128-bit auth tag.
- Store ciphertext in `v1:{iv_hex}:{ciphertext_hex}:{authTag_hex}` format to enable future algorithm migration.
- Decrypt and authenticate data on read.
- Fail-fast in production if the key is missing or malformed.
- Operate in plaintext passthrough mode when the key is absent in development/test.

The module is intentionally small: it exposes a single `EncryptionService` with no key rotation, no multi-tenant key derivation, and no key-management API.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `packages/backend/src/infrastructure/crypto/encryption.service.ts` | AES-256-GCM implementation | `EncryptionService` — `isEnabled()`, `encrypt(data)`, `decrypt<T>(encryptedString)`, `isEncrypted(value)` |
| `packages/backend/src/infrastructure/crypto/crypto.module.ts` | Global NestJS module | `@Global()` module providing/exporting `EncryptionService` |

## 3. Architecture & data flow

```mermaid
flowchart LR
    subgraph Data
        BrowserStorageState[Playwright storageState string]
        Session[Prisma Session row storageState column]
        Postgres[(PostgreSQL)]
    end

    subgraph Crypto [infrastructure/crypto]
        CryptoModule[crypto.module.ts]
        EncryptionService[encryption.service.ts]
    end

    subgraph Callers
        SessionsService[modules/sessions/sessions.service.ts]
        PostingService[modules/posting/posting.service.ts]
        SessionController[modules/replies/replies.controller.ts]
        QuoteCard[modules/quote-cards/quote-card.service.ts]
    end

    BrowserStorageState -->|JSON.parse| EncryptionService
    EncryptionService -->|encrypt| Session
    Session -->|save| Postgres
    Postgres -->|load| Session
    Session -->|decrypt| EncryptionService
    EncryptionService -->|JSON.stringify| Callers
    CryptoModule -->|@Global| EncryptionService

    style EncryptionService fill:#bbf,stroke:#333
```

### 3.1 Lifecycle and configuration

- `CryptoModule` is `@Global()` (`crypto.module.ts:9`), so `EncryptionService` is available everywhere.
- `EncryptionService` reads `SESSION_ENCRYPTION_KEY` and `NODE_ENV` in the constructor (`encryption.service.ts:37-75`).
- If the key is a valid 64-hex-char string, it is converted to a 32-byte `Buffer` and `enabled` becomes `true`.
- If the key is present but the wrong length, or missing in production, it throws an error (`env.validation.ts` also validates production key length).
- If the key is missing in development/test, it logs a warning and runs in plaintext passthrough mode.

### 3.2 Typical call patterns

- **Encrypt on write**: `sessions.service.ts` calls `this.encryptionService.encrypt(JSON.parse(storageState))` after login and stores the result in `Session.storageState` (`sessions.service.ts:372, 483, 1086, 1170, 1202, 1221`).
- **Decrypt on read**: `decryptStorageState` checks for the `v1:` prefix; if present, decrypts and returns a JSON string; otherwise returns the raw string as-is (`sessions.service.ts:1242-1251`).
- **Direct consumer**: `posting.service.ts` decrypts via `sessionsService.decryptStorageState(session)` before passing `storageState` to the browser context (`posting.service.ts:155-157`).
- **Other consumers**: `replies.controller.ts`, `quote-card.service.ts`, `ab-variant.generator.ts`, `visual-concept.service.ts`, `proxy-rotation.service.ts`, `trending-scraper.service.ts`, `browsing-session.service.ts`, `engagement.service.ts`, `langfuse.service.ts`, and `replies-monitor.service.ts` also inject `EncryptionService` (some for `storageState`, some for other data).

### 3.3 Storage format

Ciphertext format is:

```
v1:{iv_hex}:{ciphertext_hex}:{authTag_hex}
```

- `iv_hex` = 24 hex chars (12 bytes)
- `ciphertext_hex` = variable length
- `authTag_hex` = 32 hex chars (16 bytes)

The `v1:` prefix is used to distinguish encrypted from legacy plaintext data. `isEncrypted` simply checks for the prefix.

## 4. Dependencies

**Downstream (called by this module):**

- `node:crypto` — `createCipheriv`, `createDecipheriv`, `randomBytes`, `getAuthTag`, `setAuthTag`.
- `@nestjs/config` `ConfigService` — `SESSION_ENCRYPTION_KEY`, `NODE_ENV`.
- `@nestjs/common` — `Injectable`, `Logger`, `Module`, `Global`.

**Upstream (callers of this module):**

| Consumer | Usage |
|----------|-------|
| `modules/sessions/sessions.service.ts` | Encrypt new storageState; decrypt before browser use |
| `modules/posting/posting.service.ts` | Decrypt via `sessionsService.decryptStorageState` |
| `modules/replies/replies.controller.ts` | Likely decrypt storageState for manual session operations |
| `modules/quote-cards/quote-card.service.ts` | Possibly encrypt/decrypt image/config data |
| `modules/content-enhancements/ab-variant.generator.ts` | Possibly encrypt/decrypt generated data |
| `modules/content-enhancements/visual-concept.service.ts` | Possibly encrypt/decrypt visual concept data |
| `infrastructure/proxy/proxy-rotation.service.ts` | Possibly encrypt/decrypt proxy credentials |
| `modules/trending/trending-scraper.service.ts` | Possibly encrypt/decrypt session/cookie data |
| `modules/engagement/browsing-session.service.ts` | Possibly encrypt/decrypt browsing session state |
| `modules/engagement/engagement.service.ts` | Possibly encrypt/decrypt engagement data |
| `modules/replies/replies-monitor.service.ts` | Possibly encrypt/decrypt session state |
| `infrastructure/langfuse/langfuse.service.ts` | Possibly encrypt/decrypt credentials |

## 5. Environment variables

| Variable | Default | Purpose | Where validated |
|----------|---------|---------|-----------------|
| `SESSION_ENCRYPTION_KEY` | `''` | 64-character hex string (32 bytes) for AES-256-GCM | `env.validation.ts:163`, `encryption.service.ts:38-75` |
| `NODE_ENV` | `'development'` | Production fail-fast gate | `encryption.service.ts:39` |

## 6. Findings

### 6.1 Bugs / correctness

#### B1 — `encryption.service.ts` and `env.validation.ts` validate the key differently

`env.validation.ts:244` validates production key length with `/^[a-f0-9]{64}$/i`. `encryption.service.ts:41` checks `keyHex.length === KEY_LENGTH * 2` (64). The validation is duplicated, but `encryption.service.ts` does not reject non-hex characters (it calls `Buffer.from(keyHex, 'hex')`). If `keyHex` contains `0x` prefix or non-hex chars, `Buffer.from(..., 'hex')` may silently produce a shorter key or zero bytes. It does not throw on invalid hex, only returns a Buffer with zero bytes for odd-length or invalid hex? Actually, Node's `Buffer.from('invalid', 'hex')` returns an empty Buffer for non-hex chars. Then `createCipheriv` with 0-length key throws. But the check `keyHex.length === 64` is not enough to guarantee a 32-byte key.

**Fix**: Use a single validation function shared by `env.validation.ts` and `encryption.service.ts` that checks `/^[a-f0-9]{64}$/i`.

#### B2 — Plaintext `storageState` is stored as `Json` in the Prisma schema

`schema.prisma:114` defines `storageState Json`. The encrypted value is a string (with `v1:` prefix) and is stored as a JSON string inside the `Json` field. This is technically valid but the comment says `// Playwright storageState (cookies, localStorage)` implying plaintext JSON. Passthrough mode returns `JSON.stringify(data)` as a string, which is also stored as a JSON string. The schema type is misleading.

**Fix**: Change the schema comment to `// encrypted Playwright storageState (string with v1: prefix)` or add a `String?` column `@db.Text` to store the encrypted string.

#### B3 — Persistent browser profiles store plaintext cookies outside DB

`browser.factory.ts:163-170` warns that `CAMOUFOX_PROFILE_DIR` under `/tmp` stores Facebook/Threads cookies in plaintext. The DB encryption only covers the `storageState` column; Camoufox's persistent profile directory stores cookies in a separate directory. If the production volume is not restricted/encrypted, this is a security gap.

**Fix**: Document production requirement to set `CAMOUFOX_PROFILE_DIR` to a restricted, encrypted volume. Consider using a private temp directory with `chmod` 700.

#### B4 — `EncryptionService` is `@Global()` and has no port

Like `PrismaService` and `DiscordNotificationService`, `EncryptionService` is a concrete global. It is injected directly by many modules. There is no `ICryptoPort` or `IEncryptionPort` in `domain/ports/`.

**Fix**: Add `ICryptoPort` and bind `EncryptionService` to it. Consumers should inject `ICryptoPort`.

#### B5 — `isEncrypted` is too naive

`isEncrypted` checks `value.startsWith('v1:')`. Any plaintext string starting with `v1:` (e.g., a user-generated content or a path) would be treated as encrypted and fail `decrypt`. This is unlikely for `storageState`, but is a latent bug.

**Fix**: Use a more robust prefix or check length/structure (`v1:hex:hex:hex` with expected part count and lengths).

#### B6 — No key rotation or versioning beyond `v1:`

The `v1:` prefix exists for future migration, but there is no key-rotation mechanism. If `SESSION_ENCRYPTION_KEY` is rotated, all existing encrypted rows become unreadable unless the old key is kept.

**Fix**: Add a `keyId` to the ciphertext or support a `SESSION_ENCRYPTION_KEY_OLD` fallback. Document key rotation procedure.

### 6.2 Performance

#### P1 — `JSON.parse`/`JSON.stringify` on every encrypt/decrypt

`encrypt` stringifies the input, then returns a colon-delimited string. `decrypt` parses it back to a JavaScript object. `sessions.service.ts` then does `JSON.parse`/`JSON.stringify` round-trips. This is acceptable for small `storageState` objects but unnecessary for the passthrough path.

**Fix**: Provide an `encryptString(plainText: string)` and `decryptString()` that bypass `JSON` and avoid double round-tripping. `sessions.service.ts` currently calls `JSON.parse(storageState)` before encrypt and `JSON.stringify(decrypted)` after decrypt — it could pass the raw string through.

### 6.3 Architecture / anti-patterns

#### A1 — `@Global()` module

`CryptoModule` is global (`crypto.module.ts:9`). This hides the dependency and makes it harder to reason about which modules depend on encryption.

**Fix**: Remove `@Global()` and import `CryptoModule` in `SessionsModule`, `RepliesModule`, `QuoteCardModule`, etc.

#### A2 — No domain port

`EncryptionService` is concrete. Other infrastructure adapters (`LlmService`, `BrowserFactory`, `PromptRegistry`) use domain ports. A `ICryptoPort` would align the architecture.

**Fix**: Create `domain/ports/crypto.port.ts` with `encrypt(plain: string): string` and `decrypt(cipher: string): string` and bind `EncryptionService` in `CryptoModule`.

#### A3 — `EncryptionService` does too much and too little

It handles both encryption and configuration parsing. It also has no abstraction for key derivation or HSM/KMS integration. For a production service, the key management is manual (env var).

**Fix**: Extract env parsing into a `CryptoConfig` class or `ConfigService` validation. Provide a `KeyProvider` interface for future KMS support.

### 6.4 TypeScript / type safety

#### T1 — `encrypt` returns `string` but may return plaintext JSON

When `enabled` is false, `encrypt` returns `JSON.stringify(data)` (a string). Callers then cast this to `Prisma.InputJsonValue`. This is a type mismatch but is intentional. The return type should be documented.

**Fix**: Return a union type or add a `mode` indicator to the return value.

#### T2 — `decrypt` casts `JSON.parse` to `T`

`decrypt<T = unknown>(...): T` does `JSON.parse(...) as T`. No runtime validation. If the ciphertext was tampered with (but auth tag passed) or if the original data was not JSON, the cast is wrong.

**Fix**: Use a Zod schema or runtime validation in callers for complex types.

### 6.5 Security / reliability

#### S1 — Plaintext passthrough in dev/test

`encrypt` returns `JSON.stringify(data)` when disabled. If a developer accidentally copies the dev DB to prod or runs tests with production data, the data remains in plaintext. Also, `decrypt` in passthrough mode `JSON.parse` the plaintext string, which is correct for data written by `encrypt` in passthrough mode, but legacy plaintext objects in `Json` column may not be strings.

**Fix**: In production, fail-fast is correct. In dev/test, still require the key for any environment that handles real credentials.

#### S2 — `SESSION_ENCRYPTION_KEY` is read from `ConfigService` but not from `process.env` directly

`env.validation.ts` validates it. Good. But `ConfigService.get('SESSION_ENCRYPTION_KEY', '')` is used. If `ConfigModule` is not loaded, `ConfigService` defaults. The `EncryptionService` constructor runs after `ConfigModule` is loaded, so it's safe. But if the key is not 64 hex, `Buffer.from` may fail silently.

**Fix**: Use the same regex validation in `EncryptionService` that `env.validation.ts` uses.

#### S3 — No key isolation per tenant/account

All accounts share the same `SESSION_ENCRYPTION_KEY`. If a key is compromised, all account sessions are compromised. There is no per-account key derivation.

**Fix**: For a single-tenant app this is acceptable. If multi-tenant, derive keys per account (e.g., `HKDF(key, accountId)`).

#### S4 — Auth tag is concatenated but not additionally authenticated

The format `v1:iv:ciphertext:authTag` is fine. The auth tag is set with `decipher.setAuthTag`. If any component is tampered, GCM decryption fails. Good. But there is no AAD (additional authenticated data) binding the ciphertext to a context (e.g., account ID). This is acceptable for storage at rest but not for tokens.

**Fix**: Not needed for current use case. If used for tokens or network messages, add AAD.

## 7. New feature / improvement ideas

1. **Add `ICryptoPort` and remove `@Global()`** for hexagonal alignment.
2. **Single key validation helper** shared between `env.validation.ts` and `EncryptionService`.
3. **Key rotation support** with `v1:{keyId}:{iv}:{ciphertext}:{authTag}` or `SESSION_ENCRYPTION_KEY_OLD` fallback.
4. **String-in/string-out encryption methods** to avoid `JSON` double-round-trips in `SessionsService`.
5. **Store encrypted `storageState` in a `String`/`@db.Text` column** instead of `Json`.
6. **Production profile directory security** — enforce `CAMOUFOX_PROFILE_DIR` not under `/tmp` and with restricted permissions.
7. **KMS/HSM key provider interface** for future enterprise deployments.
8. **Per-account key derivation** for multi-tenant scenarios.
9. **Audit log** for `encrypt`/`decrypt` operations in production (without logging plaintext).
10. **Better `isEncrypted` check** using part count and hex validation.

## 8. Cross-references

| File / module | Why it matters |
|---------------|----------------|
| `packages/backend/src/infrastructure/crypto/encryption.service.ts` | AES-256-GCM implementation |
| `packages/backend/src/infrastructure/crypto/crypto.module.ts` | Global module wiring |
| `packages/backend/src/modules/sessions/sessions.service.ts:372, 483, 1086, 1170, 1202, 1221, 1242-1251` | Encrypt/decrypt storageState |
| `packages/backend/src/modules/posting/posting.service.ts:155-157` | Decrypt storageState before browser use |
| `packages/backend/src/infrastructure/browser/browser.factory.ts:163-170` | Warning about plaintext persistent profile dir |
| `packages/backend/src/infrastructure/config/env.validation.ts:163, 244-248` | `SESSION_ENCRYPTION_KEY` validation |
| `packages/backend/prisma/schema.prisma:114` | `Session.storageState` typed as `Json` |
| `packages/backend/src/infrastructure/notifications/discord-notification.service.ts` | Also uses `ConfigService` for alerting |
| `packages/backend/src/dry-run/live-run.cli.ts` | Uses `EncryptionService` in CLI? |
| `packages/backend/src/dry-run/dry-run.runner.ts` | Uses `EncryptionService` |

## 9. Overall assessment

| Dimension | Health (1-5) | Notes |
|-----------|--------------|-------|
| Correctness | 4 | AES-256-GCM usage is correct; key validation and plaintext passthrough are the main issues. |
| Performance | 4 | Negligible overhead for small data; unnecessary JSON round-trips. |
| Architecture | 2 | No port, global module, and key management is primitive. |
| Type safety | 3 | `as T` casts and passthrough return types. |
| Security / reliability | 3 | Good encryption, but plaintext profile dir, no key rotation, and no HSM/KMS integration. |

**Top 5 risks:**

1. **Key validation is not strict enough** — non-hex keys can create empty/zero buffers.
2. **Plaintext cookies in persistent profile directory** — DB encryption is bypassed by Camoufox profile on `/tmp`.
3. **No key rotation** — rotating the key breaks all existing sessions.
4. **No domain port / `@Global()`** — inconsistent with hexagonal architecture.
5. **Naive `isEncrypted` check** — `v1:` prefix collision possible.

## 10. Recommended next actions (prioritized)

| Rank | Action | Effort | Module(s) |
|------|--------|--------|-----------|
| 1 | Enforce 64-hex key validation in `EncryptionService` constructor (share regex with `env.validation.ts`) | XS | `infrastructure/crypto` |
| 2 | Update `Session.storageState` schema comment or migrate to `String?` `@db.Text` | XS | `prisma/schema` |
| 3 | Document and enforce `CAMOUFOX_PROFILE_DIR` security in production (not `/tmp`) | S | `infrastructure/browser`, `docs` |
| 4 | Add `ICryptoPort` and bind `EncryptionService` | S | `domain/ports`, `infrastructure/crypto` |
| 5 | Add string-in/string-out encryption methods to avoid JSON round-trips | XS | `infrastructure/crypto`, `modules/sessions` |
| 6 | Improve `isEncrypted` with part count and hex validation | XS | `infrastructure/crypto` |
| 7 | Add key rotation mechanism (key ID or `SESSION_ENCRYPTION_KEY_OLD`) | M | `infrastructure/crypto` |
| 8 | Remove `@Global()` from `CryptoModule` and import in consumers | M | `infrastructure/crypto`, `modules/*` |
