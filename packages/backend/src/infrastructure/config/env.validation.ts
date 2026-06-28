import * as Joi from 'joi';

/**
 * P1-3 fix: Env-var validation schema.
 * Validates all required env vars at startup.
 * Uses a manual validation approach (not ConfigModule.validationSchema) to avoid
 * overwriting process.env with Joi defaults — which would break tests that set
 * process.env after module import but before module initialization.
 */
const envSchema = Joi.object({
  // ── Social credentials (required for posting) ──
  SOCIAL_X_USERNAME: Joi.string().allow('').default(''),
  SOCIAL_X_PASSWORD: Joi.string().allow('').default(''),
  SOCIAL_THREADS_USERNAME: Joi.string().allow('').default(''),
  SOCIAL_THREADS_PASSWORD: Joi.string().allow('').default(''),
  SOCIAL_FACEBOOK_EMAIL: Joi.string().allow('').default(''),
  SOCIAL_FACEBOOK_PASSWORD: Joi.string().allow('').default(''),
  SOCIAL_FACEBOOK_PAGE_SLUG: Joi.string().allow('').default(''),

  // ── Social cookies (optional — used for cookie-based auth, more stable than login) ──
  // Format: "name1=value1; name2=value2" (same as browser cookie header)
  // X: requires auth_token + ct0
  // Threads: requires sessionid
  // Facebook: requires c_user + xs
  SOCIAL_X_COOKIES: Joi.string().allow('').default(''),
  SOCIAL_THREADS_COOKIES: Joi.string().allow('').default(''),
  SOCIAL_FACEBOOK_COOKIES: Joi.string().allow('').default(''),

  // ── Warm-up ──
  SOCIAL_X_WARMUP: Joi.string().valid('true', 'false').default('false'),
  SOCIAL_THREADS_WARMUP: Joi.string().valid('true', 'false').default('false'),
  SOCIAL_FACEBOOK_WARMUP: Joi.string().valid('true', 'false').default('false'),
  WARMUP_DAYS_TOTAL: Joi.number().integer().min(1).max(30).default(7),

  // ── LLM ──
  OPENAI_API_KEY: Joi.string().allow('').default(''),
  ANTHROPIC_API_KEY: Joi.string().allow('').default(''),
  LLM_DEFAULT_MODEL: Joi.string().default('gpt-5-nano'),
  // Sprint J: LLM circuit breaker + cache config
  LLM_CB_THRESHOLD: Joi.number().default(3),
  LLM_CB_COOLDOWN_MS: Joi.number().default(60000),
  LLM_CACHE_TTL_MS: Joi.number().default(300000),
  LLM_CACHE_MAX_SIZE: Joi.number().default(100),
  CONTENT_CACHE_TTL_MS: Joi.number().default(120000),
  GROQ_API_KEY: Joi.string().allow('').default(''),
  GROQ_MODEL: Joi.string().default('llama-3.3-70b-versatile'),
  OPENROUTER_API_KEY: Joi.string().allow('').default(''),
  OPENROUTER_MODEL: Joi.string().default('meta-llama/llama-3.3-70b-instruct:free'),
  DEEPSEEK_API_KEY: Joi.string().allow('').default(''),
  DEEPSEEK_MODEL: Joi.string().default('deepseek-chat'),
  CEREBRAS_API_KEY: Joi.string().allow('').default(''),
  CEREBRAS_MODEL: Joi.string().default('llama-3.3-70b'),

  // ── Database ──
  DATABASE_URL: Joi.string().default('postgresql://spa:spa@localhost:5433/social_poster'),

  // ── Redis ──
  REDIS_URL: Joi.string().default('redis://localhost:6381'),

  // ── Server ──
  // SPA_API_PORT is the actual port used by main.ts (default 3100).
  // PORT is kept for compatibility but is not used by the application.
  SPA_API_PORT: Joi.number().port().default(3100),
  SPA_UI_PORT: Joi.number().port().default(3101),
  SPA_API_PREFIX: Joi.string().default('/api/v1'),
  SPA_SWAGGER_PATH: Joi.string().default('docs'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

  // ── Feature flags ──
  ENGAGEMENT_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // Auto-approve: when true, drafts are auto-approved and enqueued without human review
  AUTO_APPROVE_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // ADR-006: Autonomous agent config
  AUTONOMOUS_RUNNER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  AUTONOMOUS_RUNNER_SCHEDULE: Joi.string().default('0 */4 * * *'),
  AUTONOMOUS_POSTS_PER_RUN: Joi.number().integer().min(1).max(20).default(3),
  AUTONOMOUS_TARGET_NETWORKS: Joi.string().default('X,THREADS,FACEBOOK'),
  AUTONOMOUS_POSTING_DELAY_MIN_MS: Joi.number().integer().min(0).default(600000),
  AUTONOMOUS_POSTING_DELAY_MAX_MS: Joi.number().integer().min(1000).default(3600000),
  AUTO_APPROVE_MIN_SCORE: Joi.number().integer().min(1).max(10).default(7),
  AUTO_APPROVE_REVIEW_SCORE: Joi.number().integer().min(1).max(10).default(4),
  AUTO_APPROVE_REJECT_STREAK_ALERT: Joi.number().integer().min(1).default(3),
  // A1/BUG-12: AUTO_CHECK_MIN_QUALITY_SCORE retired — the score decision lives
  // solely in AutoApproveService (AUTO_APPROVE_MIN_SCORE / AUTO_APPROVE_REVIEW_SCORE).
  // A leftover value in the env is harmless (schema allows unknown keys).

  // ── Monitoring ──
  SENTRY_DSN: Joi.string().allow('').default(''),

  // ── Security ──
  // P0-H3: AES-256-GCM key for encrypting storageState at rest (64 hex chars = 32 bytes)
  // Generate with: openssl rand -hex 32
  SESSION_ENCRYPTION_KEY: Joi.string().allow('').default(''),

  // ── Content paths ──
  BLOG_DIR: Joi.string().allow('').default(''),
  BRIEF_DIR: Joi.string().allow('').default(''),
  TOPICS_DIR: Joi.string().allow('').default(''),
  CREATE_RUNS_DIR: Joi.string().allow('').default(''),

  // ── Sprint O: New Features ──
  // Captcha solver (2Captcha)
  CAPTCHA_SOLVER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  TWO_CAPTCHA_API_KEY: Joi.string().allow('').default(''),
  CAPTCHA_POLL_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),
  CAPTCHA_MAX_POLL_ATTEMPTS: Joi.number().integer().min(1).default(24),

  // Proxy rotation
  PROXY_ROTATION_ENABLED: Joi.string().valid('true', 'false').default('false'),
  PROXY_LIST: Joi.string().allow('').default(''),
  PROXY_GATEWAY_URL: Joi.string().allow('').default(''),
  PROXY_STICKY_MINUTES: Joi.number().integer().min(1).default(10),

  // Quote cards (F19)
  QUOTE_CARDS_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // Default to a writable path inside the app dir — the /data content mount is read-only in prod.
  QUOTE_CARDS_DIR: Joi.string().default('/app/quote-cards'),
  QUOTE_CARD_WIDTH: Joi.number().integer().default(1200),
  QUOTE_CARD_HEIGHT: Joi.number().integer().default(675),

  // Adaptive replies (F4)
  REPLIES_ENABLED: Joi.string().valid('true', 'false').default('false'),
  REPLIES_MAX_PER_POST: Joi.number().integer().min(0).default(3),
  REPLIES_DELAY_MIN_MS: Joi.number().integer().min(0).default(300000),
  REPLIES_AUTO_DELAY_MIN_MS: Joi.number().integer().min(0).default(300000),  // 5 min
  REPLIES_AUTO_DELAY_MAX_MS: Joi.number().integer().min(1000).default(1800000), // 30 min
}).unknown(true); // allow extra env vars (PATH, HOME, etc.)

/**
 * Validate env vars at startup. Call this from a module's onModuleInit.
 * Throws with a clear error message if validation fails.
 */
export function validateEnv(): void {
  const { error, value } = envSchema.validate(process.env, {
    abortEarly: false,
    allowUnknown: true,
  });

  if (error) {
    throw new Error(
      `Environment variable validation failed:\n${error.details.map((d) => `  - ${d.message}`).join('\n')}`,
    );
  }

  // P0-H3: In production, SESSION_ENCRYPTION_KEY must be a valid 64-char hex string.
  // An empty or invalid key means storageState (cookies, localStorage) is stored
  // in plaintext — a critical security risk for production.
  if (process.env.NODE_ENV === 'production') {
    const key = process.env.SESSION_ENCRYPTION_KEY ?? '';
    if (!key || !/^[a-f0-9]{64}$/i.test(key)) {
      throw new Error(
        'SESSION_ENCRYPTION_KEY must be a 64-character hex string in production. ' +
          'Generate with: openssl rand -hex 32',
      );
    }
  }

  // Apply defaults for missing vars (only set if not already in process.env)
  for (const [key, val] of Object.entries(value)) {
    if (process.env[key] === undefined && val !== undefined) {
      process.env[key] = String(val);
    }
  }
}
