/**
 * Vitest global setup — runs once before all tests.
 *
 * Sets test environment variables so no real PostgreSQL/Redis/LLM is needed
 * for unit tests. Integration tests override these with real connections.
 */

process.env.NODE_ENV = 'test';
process.env.SPA_API_PORT = '3102';
process.env.SPA_UI_PORT = '3103';
process.env.SPA_API_PREFIX = 'api/v1';
process.env.SPA_SWAGGER_PATH = 'docs';

// Unit tests use mocks — these are fallbacks for any code that reads env directly
process.env.DATABASE_URL =
  'postgresql://spa:spa@localhost:5433/social_poster';
process.env.REDIS_URL = 'redis://localhost:6381';

// LLM — mocked in tests, but set placeholder so ConfigService doesn't crash
process.env.OPENAI_API_KEY = 'test-key-not-real';

// Rate limits — set high so tests don't hit rate limiting
process.env.RATE_LIMIT_X_MAX_PER_DAY = '50';
process.env.RATE_LIMIT_THREADS_MAX_PER_DAY = '75';
process.env.RATE_LIMIT_FACEBOOK_MAX_PER_DAY = '25';
process.env.RATE_LIMIT_X_MAX_PER_WEEK = '10';
process.env.RATE_LIMIT_THREADS_MAX_PER_WEEK = '15';
process.env.RATE_LIMIT_FACEBOOK_MAX_PER_WEEK = '5';
process.env.RATE_LIMIT_MIN_DELAY_MS = '300000';

// Social network credentials — mocked, but set placeholders
process.env.X_USERNAME = 'test_x_user';
process.env.X_PASSWORD = 'test_x_pass';
process.env.THREADS_USERNAME = 'test_threads_user';
process.env.THREADS_PASSWORD = 'test_threads_pass';
process.env.FACEBOOK_USERNAME = 'test_fb_user';
process.env.FACEBOOK_PASSWORD = 'test_fb_pass';

// Content source — path to test fixtures
process.env.CAP_RUNS_DIR = './tests/fixtures/cap-runs';
process.env.BLOG_CONTENT_DIR = './tests/fixtures/blog';

// Browser — always headless in tests (override .env which may set headed mode for debugging)
process.env.CAMOUFOX_HEADLESS = 'true';
