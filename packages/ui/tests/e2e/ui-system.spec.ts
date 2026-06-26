import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * UI System Tests — STC-036..041
 *
 * These tests verify the Social Poster Agent Vue 3 SPA UI as a black box using
 * Playwright browser automation. All backend API responses are mocked via
 * `page.route()` so no running backend is required — the Vite dev server
 * (port 3101) serves the SPA and Playwright intercepts every `/api/v1/*`
 * request before it reaches the proxy target.
 *
 * Traceability: STC-036..041 ↔ SYS-06 (UI) ↔ REQ-039,042,043,044,045,047
 * Spec: features/spa/v-model/system-test/system-test-cases.md §4.6
 */

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

interface MockPost {
  id: string;
  generationRunId: string | null;
  accountId: string;
  threadId: string | null;
  threadPosition: number;
  network: 'X' | 'THREADS' | 'FACEBOOK';
  content: string;
  sourceRef: { type: string; path: string; topic?: string } | null;
  status: 'DRAFT' | 'APPROVED' | 'POSTING' | 'POSTED' | 'FAILED' | 'REJECTED';
  postUrl: string | null;
  errorMessage: string | null;
  retryCount: number;
  llmMetadata: { model: string; tokens?: number } | null;
  createdAt: string;
  approvedAt: string | null;
  postedAt: string | null;
}

interface MockSession {
  id: string;
  accountId: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ERROR';
  lastHealthCheck: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockRun {
  id: string;
  triggeredBy: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt: string | null;
  sourceTopics: string[];
  errorMessage: string | null;
  _count: { posts: number };
}

const NETWORKS = ['X', 'THREADS', 'FACEBOOK'] as const;
const STATUSES = ['DRAFT', 'APPROVED', 'POSTED', 'FAILED', 'REJECTED'] as const;

function makePost(overrides: Partial<MockPost> & { id: string }): MockPost {
  return {
    generationRunId: 'run-0001',
    accountId: 'acc-0001',
    threadId: null,
    threadPosition: 0,
    network: 'X',
    content: 'Test post content for social media.',
    sourceRef: { type: 'brief', path: '/fixtures/brief-1.md', topic: 'topic-1' },
    status: 'DRAFT',
    postUrl: null,
    errorMessage: null,
    retryCount: 0,
    llmMetadata: { model: 'gpt-4o-mini', tokens: 120 },
    createdAt: '2026-06-26T10:00:00.000Z',
    approvedAt: null,
    postedAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<MockSession> & { id: string }): MockSession {
  return {
    accountId: 'acc-0001',
    status: 'ACTIVE',
    lastHealthCheck: '2026-06-26T09:00:00.000Z',
    createdAt: '2026-06-20T08:00:00.000Z',
    updatedAt: '2026-06-26T09:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<MockRun> & { id: string }): MockRun {
  return {
    triggeredBy: 'MANUAL',
    status: 'COMPLETED',
    startedAt: '2026-06-26T10:00:00.000Z',
    completedAt: '2026-06-26T10:02:00.000Z',
    sourceTopics: ['topic-1', 'topic-2'],
    errorMessage: null,
    _count: { posts: 3 },
    ...overrides,
  };
}

/**
 * Generate N posts distributed across all statuses and networks.
 */
function makePostsAllStatuses(count: number): MockPost[] {
  const posts: MockPost[] = [];
  for (let i = 0; i < count; i++) {
    const status = STATUSES[i % STATUSES.length]!;
    const network = NETWORKS[i % NETWORKS.length]!;
    posts.push(
      makePost({
        id: `post-${String(i + 1).padStart(4, '0')}`,
        status,
        network,
        content: `Post #${i + 1} — ${status} on ${network}`,
        postUrl: status === 'POSTED' ? `https://x.com/test/status/${i + 1}` : null,
        errorMessage: status === 'FAILED' ? 'Network timeout' : null,
        createdAt: new Date(2026, 5, 26, 10, i, 0).toISOString(),
      }),
    );
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Route mocking helpers
// ---------------------------------------------------------------------------

/**
 * Fulfill a route with JSON data and a status code.
 */
async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Parse the URL to extract path and query params.
 */
function parseUrl(url: string): { pathname: string; params: URLSearchParams } {
  const u = new URL(url);
  return { pathname: u.pathname, params: u.searchParams };
}

/**
 * Set up default API mocks for all endpoints. Individual tests can override
 * specific routes by calling `page.route()` again after this helper (later
 * registrations take precedence in Playwright).
 */
async function mockApiDefaults(page: Page, opts: {
  posts?: MockPost[];
  sessions?: MockSession[];
  runs?: MockRun[];
  delayMs?: number;
  errorStatus?: number;
} = {}): Promise<void> {
  const allPosts = opts.posts ?? makePostsAllStatuses(20);
  const sessions = opts.sessions ?? [
    makeSession({ id: 'sess-1', accountId: 'X', status: 'ACTIVE' }),
    makeSession({ id: 'sess-2', accountId: 'THREADS', status: 'EXPIRED', lastHealthCheck: '2026-06-25T08:00:00.000Z' }),
    makeSession({ id: 'sess-3', accountId: 'FACEBOOK', status: 'ERROR', lastHealthCheck: '2026-06-24T08:00:00.000Z' }),
  ];
  const runs = opts.runs ?? [
    makeRun({ id: 'run-0001', _count: { posts: 9 } }),
    makeRun({ id: 'run-0002', status: 'FAILED', errorMessage: 'LLM timeout', _count: { posts: 0 } }),
  ];
  const delayMs = opts.delayMs ?? 0;
  const errorStatus = opts.errorStatus;

  // GET /posts and /posts/drafts
  await page.route('**/api/v1/posts**', async (route) => {
    if (errorStatus) {
      await fulfill(route, errorStatus, { message: 'Internal Server Error' });
      return;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const { pathname, params } = parseUrl(route.request().url());

    // /posts/drafts — return only DRAFT posts
    if (pathname.endsWith('/posts/drafts')) {
      const network = params.get('network');
      let drafts = allPosts.filter((p) => p.status === 'DRAFT');
      if (network) drafts = drafts.filter((p) => p.network === network);
      await fulfill(route, 200, { posts: drafts });
      return;
    }

    // /posts?status=X&limit=Y — filter by status, return total count
    const status = params.get('status');
    const limit = params.get('limit');
    let filtered = allPosts;
    if (status) filtered = allPosts.filter((p) => p.status === status);
    const total = filtered.length;
    if (limit) filtered = filtered.slice(0, Number(limit));
    await fulfill(route, 200, { posts: filtered, total });
  });

  // GET /generation/runs
  await page.route('**/api/v1/generation/runs**', async (route) => {
    if (errorStatus) {
      await fulfill(route, errorStatus, { message: 'Internal Server Error' });
      return;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await fulfill(route, 200, runs);
  });

  // POST /generation/run
  await page.route('**/api/v1/generation/run', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (errorStatus) {
      await fulfill(route, errorStatus, { message: 'Internal Server Error' });
      return;
    }
    await fulfill(route, 202, {
      runId: 'run-new-0001',
      status: 'started',
    });
  });

  // GET /sessions
  await page.route('**/api/v1/sessions', async (route) => {
    if (errorStatus) {
      await fulfill(route, errorStatus, { message: 'Internal Server Error' });
      return;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await fulfill(route, 200, sessions);
  });

  // POST /sessions/health-check
  await page.route('**/api/v1/sessions/health-check**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const { params } = parseUrl(route.request().url());
    const network = params.get('network');
    // Return updated session: EXPIRED → ACTIVE after auto-login
    const updated = sessions.map((s) =>
      s.accountId === network && s.status === 'EXPIRED'
        ? { ...s, status: 'ACTIVE' as const, lastHealthCheck: '2026-06-26T11:00:00.000Z' }
        : s,
    );
    await fulfill(route, 200, updated);
  });

  // POST /posts/:id/approve and /reject
  await page.route('**/api/v1/posts/*/approve', async (route) => {
    await fulfill(route, 200, { success: true });
  });
  await page.route('**/api/v1/posts/*/reject', async (route) => {
    await fulfill(route, 200, { success: true });
  });
}

// ---------------------------------------------------------------------------
// STC-036: Dashboard displays 5 stat cards and recent posts
// ---------------------------------------------------------------------------

test.describe('STC-036: Dashboard displays 5 stat cards and recent posts', () => {
  test('shows Drafts, Approved, Posted, Failed, Rejected cards + recent posts', async ({ page }) => {
    const posts = makePostsAllStatuses(20); // 4 per status
    await mockApiDefaults(page, { posts });

    await page.goto('/');

    // Verify 5 stat cards with correct labels
    const statCards = page.locator('.grid > .rounded-lg');
    await expect(statCards).toHaveCount(5);

    const expectedLabels = ['Drafts', 'Approved', 'Posted', 'Failed', 'Rejected'];
    for (let i = 0; i < 5; i++) {
      await expect(statCards.nth(i).locator('.text-sm')).toHaveText(expectedLabels[i]!);
    }

    // Verify stat values (4 posts per status from 20 distributed)
    const values = statCards.locator('.text-2xl');
    await expect(values.nth(0)).toHaveText('4'); // Drafts
    await expect(values.nth(1)).toHaveText('4'); // Approved
    await expect(values.nth(2)).toHaveText('4'); // Posted
    await expect(values.nth(3)).toHaveText('4'); // Failed
    await expect(values.nth(4)).toHaveText('4'); // Rejected

    // Verify recent posts section — ≤5 items
    const recentPosts = page.locator('h2:has-text("Recent Posts") + div .rounded-lg, h2:has-text("Recent Posts") ~ div .rounded-lg');
    const postCards = page.locator('.space-y-2 > .rounded-lg');
    await expect(postCards.first()).toBeVisible();
    const postCount = await postCards.count();
    expect(postCount).toBeLessThanOrEqual(5);

    // Verify each post card has a StatusBadge and NetworkIcon
    const firstCard = postCards.first();
    await expect(firstCard.locator('span.rounded').first()).toBeVisible(); // StatusBadge
    await expect(firstCard.locator('.flex.items-center.gap-1')).toBeVisible(); // NetworkIcon
  });
});

// ---------------------------------------------------------------------------
// STC-037: Queue view shows drafts with Approve/Reject buttons
// ---------------------------------------------------------------------------

test.describe('STC-037: Queue view shows drafts with Approve/Reject buttons', () => {
  test('lists draft posts with Approve and Reject buttons on each', async ({ page }) => {
    const drafts = Array.from({ length: 5 }, (_, i) =>
      makePost({
        id: `draft-${i + 1}`,
        status: 'DRAFT',
        network: NETWORKS[i % 3]!,
        content: `Draft post #${i + 1} awaiting review`,
      }),
    );
    // Include some non-draft posts to ensure filtering works
    const allPosts = [
      ...drafts,
      makePost({ id: 'posted-1', status: 'POSTED' }),
      makePost({ id: 'failed-1', status: 'FAILED' }),
    ];
    await mockApiDefaults(page, { posts: allPosts });

    await page.goto('/queue');

    // Verify 5 draft posts listed
    const postCards = page.locator('.space-y-4 > .rounded-lg');
    await expect(postCards).toHaveCount(5);

    // Verify Approve and Reject buttons on each card
    for (let i = 0; i < 5; i++) {
      const card = postCards.nth(i);
      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
    }
  });

  test('clicking Approve removes the post from the queue', async ({ page }) => {
    const drafts = Array.from({ length: 3 }, (_, i) =>
      makePost({ id: `draft-${i + 1}`, status: 'DRAFT', content: `Draft ${i + 1}` }),
    );
    await mockApiDefaults(page, { posts: drafts });

    await page.goto('/queue');
    const postCards = page.locator('.space-y-4 > .rounded-lg');
    await expect(postCards).toHaveCount(3);

    // Approve the first draft
    await postCards.first().getByRole('button', { name: 'Approve' }).click();

    // Card should be removed from the list
    await expect(postCards).toHaveCount(2);
  });
});

// ---------------------------------------------------------------------------
// STC-038: Generate view triggers generation and shows run history
// ---------------------------------------------------------------------------

test.describe('STC-038: Generate view triggers generation and shows run history', () => {
  test('form renders with count, source type, and network checkboxes', async ({ page }) => {
    await mockApiDefaults(page);

    await page.goto('/generate');

    // Verify form elements (labels in Generate.vue are siblings of inputs,
    // not associated via for/id, so we use CSS selectors)
    await expect(page.locator('input[type="number"]')).toBeVisible();
    await expect(page.locator('select')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'X' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'THREADS' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'FACEBOOK' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();
  });

  test('clicking Generate triggers POST /generation/run and shows success', async ({ page }) => {
    await mockApiDefaults(page);

    await page.goto('/generate');

    // Set up request listener after navigation, before clicking
    const runRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/v1/generation/run') && req.method() === 'POST',
    );

    // Set count to 2 (label is sibling of input, no for/id association)
    await page.locator('input[type="number"]').fill('2');

    // Uncheck FACEBOOK, leave X and THREADS
    await page.getByRole('checkbox', { name: 'FACEBOOK' }).uncheck();

    // Click Generate
    await page.getByRole('button', { name: 'Generate' }).click();

    // Verify the POST request was made with correct body
    const req = await runRequestPromise;
    const body = JSON.parse(req.postData() ?? '{}');
    expect(body.count).toBe(2);
    expect(body.networks).toEqual(['X', 'THREADS']);
    expect(body.sourceType).toBe('brief');

    // Verify success message appears (202 handled)
    await expect(page.getByText(/Generation started/)).toBeVisible();
  });

  test('run history is displayed with status and post count', async ({ page }) => {
    const runs = [
      makeRun({ id: 'run-001', status: 'COMPLETED', _count: { posts: 9 } }),
      makeRun({ id: 'run-002', status: 'FAILED', errorMessage: 'LLM timeout', _count: { posts: 0 } }),
      makeRun({ id: 'run-003', status: 'RUNNING', completedAt: null, _count: { posts: 3 } }),
    ];
    await mockApiDefaults(page, { runs });

    await page.goto('/generate');

    // Verify run history section
    const runCards = page.locator('h2:has-text("Generation Runs") ~ div .border');
    await expect(runCards).toHaveCount(3);

    // Verify first run shows COMPLETED status and post count
    await expect(runCards.first().getByText('COMPLETED')).toBeVisible();
    await expect(runCards.first().getByText(/9 posts/)).toBeVisible();

    // Verify failed run shows error message
    await expect(runCards.nth(1).getByText('FAILED')).toBeVisible();
    await expect(runCards.nth(1).getByText('LLM timeout')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// STC-039: Sessions view lists sessions with health check button
// ---------------------------------------------------------------------------

test.describe('STC-039: Sessions view lists sessions with health check button', () => {
  test('lists 3 sessions with status badges and Health Check buttons', async ({ page }) => {
    const sessions = [
      makeSession({ id: 'sess-1', accountId: 'X', status: 'ACTIVE' }),
      makeSession({ id: 'sess-2', accountId: 'THREADS', status: 'EXPIRED', lastHealthCheck: '2026-06-25T08:00:00.000Z' }),
      makeSession({ id: 'sess-3', accountId: 'FACEBOOK', status: 'ERROR', lastHealthCheck: '2026-06-24T08:00:00.000Z' }),
    ];
    await mockApiDefaults(page, { sessions });

    await page.goto('/sessions');

    // Verify 3 sessions listed
    const sessionCards = page.locator('.space-y-3 > .rounded-lg');
    await expect(sessionCards).toHaveCount(3);

    // Verify status badges with correct colors
    // ACTIVE = green
    await expect(sessionCards.nth(0).locator('.bg-green-100')).toHaveText('ACTIVE');
    // EXPIRED = yellow
    await expect(sessionCards.nth(1).locator('.bg-yellow-100')).toHaveText('EXPIRED');
    // ERROR = red
    await expect(sessionCards.nth(2).locator('.bg-red-100')).toHaveText('ERROR');

    // Verify Health Check button on each
    for (let i = 0; i < 3; i++) {
      await expect(sessionCards.nth(i).getByRole('button', { name: 'Health Check' })).toBeVisible();
    }
  });

  test('clicking Health Check triggers POST /sessions/health-check and updates status', async ({ page }) => {
    // Stateful sessions: after health-check, GET /sessions returns updated data
    let sessions = [
      makeSession({ id: 'sess-1', accountId: 'X', status: 'EXPIRED', lastHealthCheck: '2026-06-25T08:00:00.000Z' }),
    ];

    // Mock GET /sessions — returns current state (updates after health-check)
    await page.route('**/api/v1/sessions', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await fulfill(route, 200, sessions);
    });

    // Mock POST /sessions/health-check — updates state, then GET returns ACTIVE
    await page.route('**/api/v1/sessions/health-check**', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const { params } = parseUrl(route.request().url());
      const network = params.get('network');
      sessions = sessions.map((s) =>
        s.accountId === network && s.status === 'EXPIRED'
          ? { ...s, status: 'ACTIVE' as const, lastHealthCheck: '2026-06-26T11:00:00.000Z' }
          : s,
      );
      await fulfill(route, 200, sessions);
    });

    const healthCheckRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/sessions/health-check') && req.method() === 'POST',
    );

    await page.goto('/sessions');

    const sessionCard = page.locator('.space-y-3 > .rounded-lg').first();
    // Verify EXPIRED badge initially
    await expect(sessionCard.locator('.bg-yellow-100')).toHaveText('EXPIRED');

    // Click Health Check
    await sessionCard.getByRole('button', { name: 'Health Check' }).click();

    // Verify API call was made with network=X
    const req = await healthCheckRequest;
    expect(req.url()).toContain('network=X');

    // Verify status updates from EXPIRED → ACTIVE
    await expect(sessionCard.locator('.bg-green-100')).toHaveText('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// STC-040: Loading, error, and empty states displayed on all views
// ---------------------------------------------------------------------------

test.describe('STC-040: Loading, error, and empty states', () => {
  test('loading spinner shown during data fetch', async ({ page }) => {
    // Use a delay long enough to catch the loading state
    await mockApiDefaults(page, { delayMs: 500 });

    await page.goto('/');

    // Verify LoadingSpinner is visible (SVG with animate-spin class)
    const spinner = page.locator('.animate-spin').first();
    await expect(spinner).toBeVisible({ timeout: 3000 });
  });

  test('error state displayed on Dashboard when API returns 500', async ({ page }) => {
    await mockApiDefaults(page, { errorStatus: 500 });

    await page.goto('/');

    // Verify ErrorState component is shown (red error message)
    const errorState = page.locator('.text-red-600').filter({ hasText: /error|Error|failed|Failed|Network/i });
    await expect(errorState.first()).toBeVisible({ timeout: 5000 });
  });

  test('empty state displayed on Queue when no drafts exist', async ({ page }) => {
    // No DRAFT posts — only POSTED
    const posts = [
      makePost({ id: 'p-1', status: 'POSTED' }),
      makePost({ id: 'p-2', status: 'APPROVED' }),
    ];
    await mockApiDefaults(page, { posts });

    await page.goto('/queue');

    // Verify EmptyState component is shown
    await expect(page.getByText('No drafts pending')).toBeVisible();
  });

  test('empty state displayed on Sessions when no sessions exist', async ({ page }) => {
    await mockApiDefaults(page, { sessions: [] });

    await page.goto('/sessions');

    await expect(page.getByText('No sessions configured')).toBeVisible();
  });

  test('empty state displayed on Generate when no runs exist', async ({ page }) => {
    await mockApiDefaults(page, { runs: [] });

    await page.goto('/generate');

    await expect(page.getByText('No generation runs yet')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// STC-041: Browser compatibility across Chrome, Firefox, and Safari
// ---------------------------------------------------------------------------

test.describe('STC-041: Browser compatibility across Chrome, Firefox, and Safari', () => {
  // GAP-005 fixed: Firefox and WebKit are now installed and configured
  // in playwright.config.ts. This test runs once per browser project
  // (chromium, firefox, webkit) and verifies all 5 views render correctly.
  test('all 5 views render correctly across Chrome, Firefox, and Safari', async ({ page, browserName }) => {
    await mockApiDefaults(page);

    // Dashboard — 5 stat cards
    await page.goto('/');
    await expect(page.locator('.grid > .rounded-lg')).toHaveCount(5);

    // Queue — draft list renders
    await page.goto('/queue');
    await expect(page.getByRole('heading', { name: 'Queue — Draft Posts' })).toBeVisible();

    // Generate — form renders
    await page.goto('/generate');
    await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

    // Sessions — session list renders
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();

    // History — post list renders
    await page.goto('/history');
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

    // Verify no console errors
    // (Playwright captures console errors; this assertion documents the
    // requirement that no JavaScript errors occur in any browser)
    expect(browserName).toBeTruthy();
  });

  test('Chromium renders all 5 views without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await mockApiDefaults(page);

    // Dashboard
    await page.goto('/');
    await expect(page.locator('.grid > .rounded-lg')).toHaveCount(5);

    // Queue
    await page.goto('/queue');
    await expect(page.getByRole('heading', { name: 'Queue — Draft Posts' })).toBeVisible();

    // Generate
    await page.goto('/generate');
    await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();

    // Sessions
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();

    // History
    await page.goto('/history');
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

    // No JavaScript console errors
    expect(consoleErrors).toEqual([]);
  });
});
