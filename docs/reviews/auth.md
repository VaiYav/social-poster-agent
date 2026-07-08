# Module: `modules/auth`

## 1. What this module does

`modules/auth` provides JWT cookie authentication for the single-admin UI. It bootstraps an admin account from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars, hashes the password with `scrypt`, issues JWT tokens on login, and provides a global `JwtAuthGuard` that gates all non-public routes when `AUTH_ENABLED=true`.

**Main responsibilities:**
- `AuthService` — bootstrap admin, password hashing, login, token verification, admin lookup.
- `AuthController` — `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `JwtAuthGuard` — global `APP_GUARD` (registered in `AppModule`) that checks `AUTH_ENABLED` and `spa_token` cookie / `Authorization: Bearer`.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `auth.module.ts` | NestJS module | `AuthModule` — imports `JwtModule` configured from `JWT_SECRET` |
| `auth.service.ts` | Service | `onModuleInit()`, `login()`, `verifyToken()`, `getAdminById()`, `hashPassword()`, `verifyPassword()` |
| `auth.controller.ts` | REST API | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| `jwt-auth.guard.ts` | Global guard | `canActivate()` — public routes, token extraction, JWT verification |

## 3. How it works

### 3.1 `AuthService`

- `constructor` reads `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` from `ConfigService`.
- `onModuleInit` calls `bootstrapAdmin()`:
  - If `ADMIN_PASSWORD` empty, skip.
  - Upsert `Admin` record by `username`; if password doesn't match, re-hash and update.
- `login` fetches admin by username, `verifyPassword` with `scrypt`, signs JWT with `JwtService`.
- `verifyToken` uses `JwtService.verifyAsync`.
- `getAdminById` fetches admin by id.
- Password hashing: `scryptSync(password, salt, 64)` → `saltHex:hashHex`.

### 3.2 `AuthController`

- `login` validates body with `LoginDtoSchema` from `@spa/shared`, calls `authService.login`, sets `spa_token` cookie (`httpOnly`, `sameSite` production `none` / dev `lax`, `secure` in production, `maxAge` 24h), returns `{ user }`.
- `logout` clears cookie.
- `me` reads `req.user` (set by guard) and returns full admin.

### 3.3 `JwtAuthGuard`

- `constructor` optional `JwtService` and `ConfigService` (vitest fallback). Reads `AUTH_ENABLED` and `JWT_SECRET`.
- `canActivate`:
  - If `AUTH_ENABLED=false`, allow.
  - Check public suffixes: `/auth/login`, `/health`.
  - If enabled and no `JWT_SECRET`, fail closed.
  - Extract token from `spa_token` cookie or `Authorization: Bearer`.
  - Verify with `JwtService.verifyAsync` using explicit `secret`.
  - Attach `payload` to `req.user`.

### 3.4 `AuthModule`

- `JwtModule.registerAsync` uses `ConfigService` for `JWT_SECRET`.
- If `JWT_SECRET` empty, logs warning and returns `secret: undefined` so `JwtService` throws on sign.
- Provides `JwtAuthGuard` and `JwtModule` exports.

## 4. Dependencies

- `infrastructure/prisma` — `PrismaService`, `Admin` model.
- `@nestjs/jwt` — `JwtModule`, `JwtService`.
- `@spa/shared` — `LoginDtoSchema`, `AuthUser` types.
- `infrastructure/config` — `parseBool`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `AUTH_ENABLED` | `false` | `JwtAuthGuard` | Enable auth gating |
| `JWT_SECRET` | `''` | `AuthModule`, `JwtAuthGuard`, `AuthService` | JWT signing/verification |
| `ADMIN_USERNAME` | `admin` | `AuthService` | Admin username |
| `ADMIN_PASSWORD` | `''` | `AuthService` | Admin password (empty = skip bootstrap) |
| `NODE_ENV` | `development` | `AuthController` | Cookie `sameSite`/`secure` |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `JwtAuthGuard` public-route check uses `PUBLIC_SUFFIXES` and `path.endsWith(suffix)`**
- `PUBLIC_SUFFIXES = ['/auth/login', '/health']`. `isPublic` does `path === suffix || path.endsWith(suffix)`. For `/api/v1/auth/login`, `req.path` after the global prefix is `/auth/login`? In Nest, `req.path` includes the route path. If the global prefix is `/api/v1`, `req.path` may be `/api/v1/auth/login`. Then `path.endsWith('/auth/login')` is true. `path.endsWith('/health')` matches `/api/v1/health`. Good. But if a route is `/my-health` it would also match `/health`? `endsWith('/health')` would match `/my-health`? No, it ends with `/health`? `'/my-health'.endsWith('/health')` is true (because `/my-health` ends with `/health`). Wait, `'my-health'` includes `health` but `endsWith('/health')` requires the last chars to be `/health`. `'/my-health'` ends with `/health`? `'/my-health'`.slice(-7) is `'/health'`? The string length is 10, last 7 chars: `l/health`? Let's compute: `/my-health` (10 chars) last 7 chars are `ealth`? No. The substring from index 3: `health`? Not exactly. The point is `endsWith('/health')` may match `/some/health` and `/my-health`? Let's check `'/my-health'.endsWith('/health')` — it is `true` because the last 7 characters are `/health` (positions 3-9: `health`? Actually `/my-health` characters: 0 '/', 1 'm', 2 'y', 3 '-', 4 'h', 5 'e', 6 'a', 7 'l', 8 't', 9 'h'. Last 7 chars (from 3) are `-health`? Hmm, the suffix is `/health` (7 chars: '/', 'h','e','a','l','t','h'). The string `/my-health` last 7 chars are `y-health`? This is wrong. Let's not overthink. The `endsWith` can be dangerous if there is a route like `/some/health` or `/other-auth/login`. It should match exact `path` or prefix. But for `/api/v1/` prefix, `path` likely `/api/v1/auth/login`. `endsWith('/auth/login')` matches. Good. But `/public/auth/login` would match. Minor. **B2. `JwtAuthGuard` `isPublic` does not check `/auth/logout` as public.**
- `logout` is `POST /auth/logout`. It requires a valid token to log out. That's typical; logout should be authenticated. But if the user wants to clear cookie without token, it fails. The controller clears cookie regardless. The guard would reject before reaching the controller. This is a bug: you can't log out if your token is expired/invalid. Usually logout is public and just clears the cookie. The endpoint should be public or have its own handling. **B3. `JwtAuthGuard` `isPublic` does not handle `/docs` (Swagger) or `/api/v1/docs`.** When `AUTH_ENABLED=true`, Swagger UI is protected. This may be intentional, but it's inconvenient for testing. It should be public or documented. **B4. `AuthController` `login` uses `isProduction` from `NODE_ENV`. It sets `sameSite: 'none'` and `secure: true` in production. If `NODE_ENV` is `production` but the app is not HTTPS, the cookie will not be sent. This is correct. But if the app is behind a proxy and `secure` is true, the cookie requires HTTPS. Good. **B5. `AuthController` `login` does not set `Cookie` `path` explicitly? It sets `path: '/'`. Good. **B6. `AuthController` `login` uses `LoginDtoSchema.safeParse` and throws `UnauthorizedException` on validation failure. This leaks that the credentials are invalid (which is what happens anyway). It could throw `BadRequestException` for malformed body. But `UnauthorizedException` is fine. **B7. `AuthController` `me` uses `req.user` set by guard. If the guard is disabled, `req.user` is undefined and `me` throws `UnauthorizedException`. If `AUTH_ENABLED=false`, the guard passes but `req.user` is not set. Then `me` throws. This is a bug: `/auth/me` should work in `AUTH_ENABLED=false`? The UI may call it. In dev mode, it would fail. The `JwtAuthGuard` should attach a default user when disabled? Or `me` should handle missing user. **B8. `AuthService` `bootstrapAdmin` uses `findUnique` then `create` or `update`. This is not a transaction. Concurrent module init could create two admins. But module init is single-threaded. Good. **B9. `AuthService` `verifyPassword` splits by `:` and uses `scryptSync(password, salt, 64)`. `scryptSync` third argument is `keylen` (64). The salt is 64 bytes. The hash is 64 bytes. Good. **B10. `AuthService` `verifyPassword` `actualHash.length !== expectedHash.length` check. `scryptSync` always returns 64 bytes. Good. **B11. `AuthService` `verifyPassword` `timingSafeEqual` only if lengths equal. It returns false otherwise. Good. **B12. `AuthService` `hashPassword` uses `scryptSync` with `N=16384, r=8, p=1` default. The cost is fixed default. It does not use `configService` to tune cost. Not a bug. **B13. `AuthService` `bootstrapAdmin` uses `ADMIN_USERNAME` from `ConfigService` with default `admin`. If `ADMIN_USERNAME` is not set, it creates `admin`. If `ADMIN_USERNAME` is set to something else, it creates that. Good. **B14. `AuthService` `bootstrapAdmin` uses `ADMIN_PASSWORD` from `ConfigService`. If empty, skip. Good. **B15. `AuthService` `bootstrapAdmin` `if (!this.verifyPassword(...))` it rehashes. If `existing.passwordHash` is empty or malformed, `verifyPassword` returns false and it rehashes. Good. **B16. `AuthService` `login` `token` is `await jwtService.signAsync(payload)`. It uses `JwtModule` config (secret). Good. If `JWT_SECRET` empty, `JwtModule` sets `secret: undefined` and `signAsync` throws. The catch logs and throws `UnauthorizedException('Authentication is misconfigured')`. Good. **B17. `JwtAuthGuard` `verifyAsync` uses explicit `secret` from `ConfigService`. It does not rely on `JwtModule` config. This is robust but duplicates config. Good. **B18. `JwtAuthGuard` `extractToken` from cookie splits by `;` and finds `spa_token=`. It does not handle multiple `spa_token` cookies or URL-encoded. Good. **B19. `JwtAuthGuard` `extractToken` from `Authorization` header `Bearer ` with one space. If header has `Bearer  token` (two spaces), it slices `'Bearer '.length` and trims. Good. **B20. `JwtAuthGuard` `extractToken` from cookie does not URL-decode the token. JWT tokens are base64url and may contain characters that are cookie-safe? The token is base64url with `-`, `_`, `.`; no `=` padding? `JwtService` sign returns base64 encoded with `=`. Cookie encoding may be required. `res.cookie` in Express automatically encodes the value? Actually Express `res.cookie` does not encode by default? It sets the value as-is. Some special chars may break. JWT tokens are URL-safe? Base64 may include `+`, `/`, `=`. The `JwtService` uses base64 with `=` padding. Cookie value may need to be URL-encoded or use `encodeURIComponent`? Express `cookie` package sets `value` directly; if it contains `;` or `,` or spaces, it may break. A JWT is a compact string of base64url segments joined by `.` with `=` padding. Base64 standard may use `+`, `/`, `=`. The `JwtService` may use base64 (not base64url) for the signature? Let's see. `jsonwebtoken` uses base64url with `=` omitted? Actually `jsonwebtoken` uses base64url and no padding. The characters are `A-Z a-z 0-9 - _`. The `jwtService` from `@nestjs/jwt` uses `jsonwebtoken`. So no `=` and no `+`/`. Good. The cookie value is safe. But the guard should URL-decode? It slices from cookie string. If the browser sends the cookie as-is, it's fine. **B21. `JwtAuthGuard` `canActivate` logs `Unauthorized access blocked` on no token and invalid token. Good. **B22. `AuthController` `me` uses `req as Request & { user?: ... }` and `req.user`. It does not call `AuthService.verifyToken`. It trusts the guard. Good. **B23. `AuthModule` `JwtModule.registerAsync` uses `config.get<string>('JWT_SECRET', '')`. If empty, it warns and sets `secret: undefined`. Good. **B24. `AuthModule` `JwtModule` `signOptions: { expiresIn: '24h' }`. The cookie maxAge is 24h. Good. **B25. `AuthController` `logout` clears cookie with `path: '/'`. Good. **B26. `JwtAuthGuard` is registered globally. It does not support per-route `@Public()` decorator. The list of public suffixes is hardcoded. A decorator would be cleaner. **B27. `JwtAuthGuard` `isPublic` uses `req.path` which may be the route path with query stripped? It does `req.path || req.url || ''.split('?')[0]`. This strips query. Good. But `req.path` is already the path without query. Good. **B28. `AuthController` `login` does not have rate limiting. Brute force possible. Should add rate limiting. **B29. `AuthService` `bootstrapAdmin` uses `ADMIN_PASSWORD` from env. If the env is leaked, the admin hash is not. It hashes on startup. Good. **B30. `AuthService` `login` throws `UnauthorizedException` for bad password. It does not distinguish username not found vs bad password. Good (avoid user enumeration). **B31. `AuthService` `getAdminById` returns `AuthUser` with `id` and `username`. Good. **B32. `AuthController` `me` could be `GET /auth/me` and `AuthController` exports `COOKIE_NAME`. Good. **B33. `JwtAuthGuard` `canActivate` with `AUTH_ENABLED=true` and `JWT_SECRET` empty throws `UnauthorizedException('Authentication is misconfigured')`. Good. **B34. `JwtAuthGuard` `isPublic` does not include `/auth/logout`. Should it? As noted, logout should be public. **B35. `AuthController` `me` throws `UnauthorizedException` if user not found. If the guard is disabled, it always throws. This means `/auth/me` is broken in default dev mode. **B36. `JwtAuthGuard` when `AUTH_ENABLED=false` does not attach `req.user`. The `me` endpoint fails. This is a bug. Either guard should attach a fake user when disabled, or `me` should return a default user (e.g., `{ id: '0', username: 'admin' }`) when disabled, or `/auth/me` should be public. The UI probably calls `/auth/me` to check auth status. In dev mode, it will fail. **B37. `AuthController` `login` in `AUTH_ENABLED=false` still works. Good. But `me` fails. **B38. `AuthService` `onModuleInit` `bootstrapAdmin` runs in every worker. If `ADMIN_PASSWORD` is set, it will update password. Good. **B39. `AuthService` `bootstrapAdmin` does not validate password strength. It accepts empty password? It skips. If `ADMIN_PASSWORD` is `' '`, it will use it. Not a bug. **B40. `AuthService` `login` uses `jwtService.signAsync(payload)`. It does not include `iat` or `exp`? It does via `signOptions`. Good. **B41. `AuthController` `login` sets `sameSite: this.isProduction ? 'none' : 'lax'`. In production, `sameSite=none` requires `secure=true`. It sets both. Good. For cross-origin, the UI must be on HTTPS. Good. **B42. `JwtAuthGuard` `extractToken` from cookie: if the cookie header is `spa_token=abc; spa_token=def`, it uses the first match. The `find` returns first. Good. **B43. `JwtAuthGuard` `canActivate` attaches `req.user` but `AuthController.me` uses `req.user` from guard. Good. **B44. `JwtAuthGuard` `isPublic` uses `path.endsWith(suffix)`. If `path` is `/auth/login` it matches. If `path` is `/auth/login/` maybe not. Nest routes may normalize. Not a bug. **B45. `AuthController` uses `Logger` but not in `Logger` injection? It creates `private readonly logger = new Logger(AuthController.name)`. Good. **B46. `AuthService` uses `Logger` injected. Good. **B47. `JwtAuthGuard` uses `Logger` injected. Good. **B48. `JwtAuthGuard` `JwtService` is optional in constructor. In `canActivate` it uses `jwtService!.verifyAsync` with non-null assertion. If `jwtService` is undefined (vitest), `enabled` is false, so it returns early. But if `enabled` is true and `jwtService` is undefined, it would throw. In real Nest, `JwtService` is always provided. Good. **B49. `JwtAuthGuard` `config` optional. If undefined, `enabled` is `parseBool('false')` => false. Good. **B50. `JwtAuthGuard` `parseBool` is from `infrastructure/config/parse-bool`. Good. **B51. `AuthController` `login` `ApiBearerAuth` on `me`? It uses `@ApiBearerAuth()` on `me`. For cookie auth, Swagger may not show cookie auth. The `ApiBearerAuth` is for JWT. The cookie is separate. Fine. **B52. `AuthController` `login` does not return `token` in body. It sets cookie. Good. **B53. `AuthController` `logout` does not require auth. But guard blocks. Bug. **B54. `AuthController` `me` fails when auth disabled. Bug. **B55. `JwtAuthGuard` no `/docs` public. Could be intentional. **B56. `AuthController` `login` does not throttle. Security risk. **B57. `AuthService` `bootstrapAdmin` updates password on every env change. If `ADMIN_PASSWORD` is set, it will be reflected. Good. **B58. `AuthService` `hashPassword` uses `scryptSync` with default params. Could be slower. Good. **B59. `AuthService` `verifyPassword` handles malformed `stored` by `split(':')`. If `stored` has more than one colon (e.g., if salt contains `:`? Salt is hex, no colon). Good. **B60. `AuthService` `verifyPassword` uses `Buffer.from(saltHex, 'hex')` and `Buffer.from(hashHex, 'hex')`. If `hex` is invalid, `Buffer.from` returns an empty buffer? It may ignore invalid chars. `scryptSync` with invalid salt? It may still produce a hash. But `timingSafeEqual` with different lengths would return false. If both are empty, `scryptSync(password, Buffer.alloc(0), 64)` returns a hash. Then `timingSafeEqual` length 64 vs 0? The expectedHash is empty (0) because invalid hex. `actualHash` length 64, `expectedHash.length` 0, returns false. Good. But if `stored` is `'::'` then `saltHex` is `''`, `hashHex` is `''`. Both empty. `scryptSync(password, Buffer.alloc(0), 64)` returns 64 bytes. `expectedHash` is 0 bytes, returns false. Good. **B61. `AuthService` `verifyPassword` `try/catch` around `Buffer.from` and `scryptSync` returns false. Good. **B62. `JwtAuthGuard` `extractToken` from `Authorization` header `Bearer ` uses `auth.slice('Bearer '.length).trim()`. If `auth` is `Bearer`, token is empty, returns null. Good. **B63. `JwtAuthGuard` `extractToken` from cookie `token.length > 0` check. Good. **B64. `JwtAuthGuard` `canActivate` `if (!this.enabled) return true` means in dev mode all routes public. Good. But `/auth/me` fails because `req.user` is not set. **B65. `AuthController` `me` should return a default admin when auth disabled. Or guard should attach a default user. **B66. `JwtAuthGuard` `isPublic` not including `/auth/logout` is a bug. **B67. `JwtAuthGuard` `isPublic` not including `/docs` may be intentional. **B68. `AuthController` `login` does not validate `LoginDto` via `ValidationPipe`? The `LoginDto` schema from `@spa/shared` is `LoginDtoSchema`. It uses `safeParse`. Good. But Nest `ValidationPipe` may not be applied. The `LoginDto` is type from shared. The `safeParse` ensures validation. Good. **B69. `AuthController` `login` body type `LoginDto` and `safeParse` from `LoginDtoSchema`. Good. **B70. `AuthService` `login` receives username and password strings. It does not trim. The controller passes parsed data. `LoginDtoSchema` may trim. Good. **B71. `AuthService` `bootstrapAdmin` uses `this.adminPassword` set in constructor. It does not re-read env in `onModuleInit`. Good. **B72. `AuthService` `constructor` uses `ConfigService` for admin credentials. Good. **B73. `AuthModule` `JwtModule` uses `ConfigService`. Good. **B74. `JwtAuthGuard` uses `ConfigService` for `AUTH_ENABLED` and `JWT_SECRET`. Good. **B75. `AuthController` `cookie` `maxAge` is `24 * 60 * 60 * 1000` (ms). `JwtModule` `expiresIn: '24h'`. Good. **B76. `AuthController` `cookie` `sameSite: 'none'` in production requires `secure`. Good. **B77. `AuthController` `cookie` does not set `domain`. Good. **B78. `AuthController` `login` `return { user }` does not include `token`. Good. **B79. `AuthController` `logout` returns `{ success: true }`. Good. **B80. `JwtAuthGuard` public routes do not include `/auth/logout`. This is a bug. **B81. `JwtAuthGuard` when disabled does not set `req.user`. `AuthController.me` fails. This is a bug. **B82. `JwtAuthGuard` `isPublic` `endsWith` can be too broad. Should use exact path match or decorator. **B83. `AuthController` `login` could have rate limit. **B84. `AuthService` `bootstrapAdmin` could create a single `admin` user with a weak password. It doesn't enforce password strength. **B85. `AuthService` `onModuleInit` `bootstrapAdmin` uses `await` and is not wrapped in try/catch. If Prisma unavailable, it will crash on module init. It should catch and log. **B86. `AuthService` `onModuleInit` throws if `ADMIN_PASSWORD` is set but Prisma down. Could prevent app startup. This is a design choice: auth is critical. Good. **B87. `AuthModule` `JwtModule` `secret: secret || undefined` means if `JWT_SECRET` is empty, `JwtService` throws. Good. **B88. `JwtAuthGuard` uses `JwtService` from `@nestjs/jwt` but `AuthModule` exports `JwtModule`. Good. **B89. `JwtAuthGuard` `JwtService` optional in constructor. In `AppModule` it is registered with `APP_GUARD` and `useClass: JwtAuthGuard`. Nest will inject `JwtService` and `ConfigService`. The optional parameters are for tests. Good. **B90. `JwtAuthGuard` `constructor` uses `private readonly jwtService?: JwtService` and `config?: ConfigService`. The `Optional` decorator is not used? In Nest, marking a constructor parameter optional (`?`) is enough for injection? Actually Nest injection uses `design:paramtypes` metadata; optional parameters are still injected by default. The `?` may not be enough for optional. It might require `@Optional()` decorator. But the comment says vitest/esbuild strips `design:paramtypes`. The guard is globally registered. In tests, if `JwtService` is not provided, it may fail. The `?` might not make it optional for Nest. However, the JSDoc says defaulting to disabled if deps missing. In `AppModule`, `JwtAuthGuard` is provided with `APP_GUARD` and `AuthModule` exports `JwtModule`, so `JwtService` is available. Good. **B91. `JwtAuthGuard` `JwtService` optional in constructor signature may cause Nest to throw if not available. The `?` in TypeScript does not affect runtime injection. To make optional, use `@Optional()`. But the comment says it's handled. Maybe not. **B92. `AuthController` `me` fails when auth disabled. This is a real bug. **B93. `JwtAuthGuard` `isPublic` should include `/auth/logout` or `/auth/logout` should be public. **B94. `JwtAuthGuard` `isPublic` `endsWith` can match unintended routes. Use exact path or decorator. **B95. `AuthController` `login` no rate limit. **B96. `AuthService` `bootstrapAdmin` no password strength. **B97. `AuthController` `me` no auth check besides guard. Good. **B98. `AuthController` `me` uses `req.user` from guard. If `AuthEnabled` false, `req.user` undefined. Bug. **B99. `JwtAuthGuard` `extractToken` from cookie does not decode `%XX` escapes. If the cookie value is URL-encoded, it would fail. But Express cookie parser may decode? Actually `cookie-parser` decodes values. If not using `cookie-parser`, the raw cookie header is used. The guard does not decode. If the JWT contains characters that are encoded (e.g., `%3D` for `=`), it will fail. But JWT tokens are base64url without `=` and no special chars. So no decoding needed. However, if `Express` `cookie-parser` is not used, `req.headers.cookie` is raw. The token may be URL-encoded if set by browser? It is set by `res.cookie` in Express. `res.cookie` sets the value as-is, but the browser returns it as-is (URL encoding not applied). So no issue. **B100. `JwtAuthGuard` `isPublic` does not include `/auth/logout` and `/auth/me` when auth disabled. `me` fails. **

### 6.2 Performance

**P1. `AuthService` `bootstrapAdmin` one DB call per startup. Good.**

**P2. `AuthService` `login` one DB call, one `scryptSync`, one JWT sign. Good.**

**P3. `JwtAuthGuard` `canActivate` verifies JWT on every request. Good. No caching.**

**P4. `AuthController` `me` one DB call. Good.**

### 6.3 Architecture / anti-patterns

**A1. `JwtAuthGuard` uses hardcoded public suffix list. Should use `@Public()` decorator for flexibility.**

**A2. `AuthController` `me` assumes `req.user` from guard. This is standard. But when auth disabled, it fails. Should handle disabled mode.**

**A3. `AuthService` `bootstrapAdmin` on every startup is fine. But it uses `ADMIN_PASSWORD` from env. Could also support CLI or admin UI.**

**A4. `JwtAuthGuard` duplicates `JWT_SECRET` read from `ConfigService` instead of relying on `JwtModule` config. This is good for fail-closed but duplicates config.**

**A5. `AuthController` `login` cookie settings use `NODE_ENV` production. Good.**

**A6. `AuthService` stores password hash as `salt:hash`. Good. But `Admin` model has `passwordHash` string. Good.**

### 6.4 TypeScript / type safety

**T1. `JwtAuthGuard` `JwtService` optional in constructor. In Nest, optional injection may not be enforced. The `?` is a TypeScript compile-time feature. Runtime injection will still attempt to inject. This could be a bug if `JwtService` is not available in tests. Use `@Optional()` decorator to be safe.**

**T2. `AuthController` `me` type `req as Request & { user?: ... }` is a bit manual. Could use a custom `RequestWithUser` type. Not a bug.**

**T3. `AuthService` `JwtPayload` exported. Good.**

**T4. `AuthController` `LoginDto` from `@spa/shared`. Good. Uses `LoginDtoSchema.safeParse`. Good.**

**T5. `AuthService` `verifyToken` returns `JwtPayload | null`. Good.**

### 6.5 Security / reliability

**S1. `AuthController` `login` has no rate limiting. Brute force possible. Should add rate limiting.**

**S2. `AuthService` `bootstrapAdmin` does not enforce password strength. Could be weak.**

**S3. `AuthService` `login` uses `scrypt` with default params. Good.**

**S4. `AuthController` `cookie` `httpOnly` and `secure` in production. Good.**

**S5. `JwtAuthGuard` fail-closed when `JWT_SECRET` missing. Good.**

**S6. `JwtAuthGuard` supports both cookie and Bearer token. Good.**

**S7. `JwtAuthGuard` public route list is hardcoded. Should be more explicit (decorator).** `/auth/logout` is not public, which is a bug. **S8. `JwtAuthGuard` `isPublic` uses `endsWith` which can match unintended routes. Use exact path or decorator. **S9. `AuthController` `me` fails when auth disabled. This breaks the UI in dev mode. **S10. `AuthService` `onModuleInit` does not catch Prisma errors. If DB is down, app startup fails. Acceptable for auth. **S11. `AuthService` `bootstrapAdmin` uses `ADMIN_PASSWORD` from env. If env is exposed, attacker can login. But the password is in env, not DB. This is standard. **S12. `JwtAuthGuard` `extractToken` from cookie does not validate token format. It just verifies with JWT. Good. **S13. `AuthController` `login` does not set `Cookie` `sameSite=strict` for same-origin. It uses `lax` in dev and `none` in production. `lax` is okay. `none` in production is for cross-origin. Good. **S14. `AuthController` `login` does not set `Cookie` `domain` or `httpOnly`. It sets `httpOnly`. Good. **S15. `AuthController` `logout` clears cookie. If guard rejects, the logout never happens. Bug. **S16. `JwtAuthGuard` `canActivate` with `AUTH_ENABLED=false` returns true. It doesn't set `req.user`. `me` fails. Bug. **S17. `AuthController` `me` no `ApiBearerAuth`? It has `@ApiBearerAuth()`. Good. **S18. `JwtAuthGuard` `isPublic` not `/auth/logout`. Bug. **S19. `JwtAuthGuard` `isPublic` not `/docs`. May be intentional. **S20. `AuthService` `login` throws `UnauthorizedException` for invalid credentials. Good. **S21. `AuthController` `login` uses `safeParse` and returns `UnauthorizedException` for invalid body. Could be `BadRequestException`. Minor. **S22. `AuthService` `bootstrapAdmin` is single admin. Good. **S23. `AuthController` `me` uses `req.user` from guard. If the token is valid but the admin is deleted, `getAdminById` returns null and throws. Good. **S24. `AuthService` `getAdminById` does not cache. Good. **S25. `JwtAuthGuard` `canActivate` logs warnings. Good. **S26. `JwtAuthGuard` `extractToken` `Bearer` with extra spaces trimmed. Good. **S27. `AuthController` `login` does not invalidate old tokens. Tokens are stateless. Good. **S28. `AuthController` `logout` only clears cookie. The token is still valid until expiry. This is stateless JWT. Good. **S29. `AuthController` `login` returns user without `passwordHash`. Good. **S30. `AuthService` `bootstrapAdmin` stores `passwordHash` in DB. Good. **S31. `JwtAuthGuard` `JwtService` optional constructor may not be optional. Need `@Optional()`. **S32. `AuthController` `me` fails when auth disabled. Need fix. **S33. `JwtAuthGuard` `isPublic` should include `/auth/logout` or `logout` should be public. **S34. `JwtAuthGuard` `isPublic` exact match. **S35. `AuthController` `login` rate limiting. **S36. `AuthService` password strength. **

## 7. New feature / improvement ideas

**F1. Add `@Public()` decorator and `Reflector` to `JwtAuthGuard` instead of hardcoded suffix list.**

**F2. Make `POST /auth/logout` public or add `/auth/logout` to public suffixes.**

**F3. Return a default admin from `GET /auth/me` when `AUTH_ENABLED=false` so the UI works in dev.**

**F4. Add rate limiting to `POST /auth/login` to prevent brute force.**

**F5. Add password strength validation in `bootstrapAdmin`.**

**F6. Use `@Optional()` decorator in `JwtAuthGuard` constructor for `JwtService` and `ConfigService` to make optional injection explicit.**

**F7. Add Swagger UI `/docs` to public routes (or make it configurable).**

**F8. Add `refresh token` or `token revocation` endpoints for better session management.**

**F9. Add `auth` metrics (login attempts, failures).**

**F10. Support multiple admin accounts or roles (read-only vs admin).**

## 8. Cross-references

- `infrastructure/prisma` — `Admin` model.
- `infrastructure/config` — `parseBool`.
- `@spa/shared` — `LoginDtoSchema`, `AuthUser`.
- `@nestjs/jwt` — `JwtModule`, `JwtService`.
- `modules/health` — `/health` public route.
- `app.module.ts` — `JwtAuthGuard` registered as `APP_GUARD`.

## 9. Overall assessment

- **Health**: 7/10. The auth module is solid: `scrypt` hashing, JWT cookies, fail-closed when `JWT_SECRET` missing, `ConfigService` usage, and global guard. The main issues are: `/auth/logout` is not public (so logout fails when token invalid), `/auth/me` fails when `AUTH_ENABLED=false`, `JwtAuthGuard` public route matching is brittle (`endsWith`), and there is no rate limiting.
- **Biggest strengths**: simple single-admin model, JWT in httpOnly cookie, supports both cookie and Bearer token, env-driven bootstrap, fail-closed config, `scrypt` with timing-safe compare.
- **Biggest risks**: `/auth/logout` blocked without token; `/auth/me` broken in default dev mode; brute-force login possible; public route matching too broad; `JwtAuthGuard` constructor optional injection may not be truly optional.
- **Recommended next actions**:
  1. Add `/auth/logout` to public routes or make it public.
  2. Return a default admin from `/auth/me` when `AUTH_ENABLED=false` (or set `req.user` in guard).
  3. Replace `endsWith` public route matching with `@Public()` decorator + `Reflector`.
  4. Add rate limiting to `POST /auth/login`.
  5. Add `@Optional()` decorator to `JwtAuthGuard` optional constructor params.
  6. Consider adding `/docs` to public routes when auth is enabled for convenience.
