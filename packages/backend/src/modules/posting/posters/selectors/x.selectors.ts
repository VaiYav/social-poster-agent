// X.com (Twitter) selectors — multi-fallback strategy.
// X uses data-testid attributes for testing, which are relatively stable.
// Fallbacks use ARIA roles and CSS for resilience.

import type { SelectorStrategy } from '../selector-strategy.js';

export const X_SELECTORS = {
  // ── Login ──────────────────────────────────────────────────────
  login: {
    url: 'https://x.com/i/flow/login',
    username: {
      testId: undefined,
      css: ['input[autocomplete="username"]', 'input[name="text"]', 'input[type="text"]'],
      label: { label: 'Phone, email, or username' },
    } satisfies SelectorStrategy,
    password: {
      css: ['input[autocomplete="current-password"]', 'input[type="password"]', 'input[name="password"]'],
      label: { label: 'Password' },
    } satisfies SelectorStrategy,
    submit: {
      testId: 'LoginForm_Login_Button',
      role: { role: 'button', name: 'Next' },
      css: ['button[type="submit"]', 'div[role="button"]:has-text("Next")', 'div[role="button"]:has-text("Log in")'],
    } satisfies SelectorStrategy,
    successIndicator: {
      testId: 'AppTabBar_Home_Link',
      role: { role: 'link', name: 'Home' },
      css: ['a[href="/home"]'],
    } satisfies SelectorStrategy,
  },

  // ── Posting ────────────────────────────────────────────────────
  compose: {
    // Navigate directly to compose page
    url: 'https://x.com/compose/post',
    textarea: {
      testId: 'tweetTextarea_0',
      role: { role: 'textbox' },
      css: ['div[contenteditable="true"][data-testid="tweetTextarea_0"]', 'div[contenteditable="true"]'],
    } satisfies SelectorStrategy,
    submitButton: {
      testId: 'tweetButton',
      role: { role: 'button', name: 'Post' },
      text: { text: 'Post', exact: true },
      css: ['button[data-testid="tweetButton"]', 'div[role="button"][data-testid="tweetButton"]'],
    } satisfies SelectorStrategy,
    // After posting, URL should match /status/{digits}
    postUrlPattern: /\/status\/(\d+)$/,
  },

  // ── Engagement ─────────────────────────────────────────────────
  engagement: {
    like: {
      testId: 'like',
      role: { role: 'button', name: 'Like' },
      css: ['button[data-testid="like"]', 'div[role="button"][data-testid="like"]'],
    } satisfies SelectorStrategy,
    unlike: {
      testId: 'unlike',
      role: { role: 'button', name: 'Unlike' },
      css: ['button[data-testid="unlike"]', 'div[role="button"][data-testid="unlike"]'],
    } satisfies SelectorStrategy,
    reply: {
      testId: 'reply',
      role: { role: 'button', name: 'Reply' },
      css: ['button[data-testid="reply"]', 'div[role="button"][data-testid="reply"]'],
    } satisfies SelectorStrategy,
    repost: {
      testId: 'retweet',
      role: { role: 'button', name: 'Repost' },
      css: ['button[data-testid="retweet"]', 'div[role="button"][data-testid="retweet"]'],
    } satisfies SelectorStrategy,
    follow: {
      testId: 'placementTracking',
      role: { role: 'button', name: 'Follow' },
      css: ['div[role="button"][data-testid$="-follow"]', 'button:has-text("Follow")'],
    } satisfies SelectorStrategy,
    // Reply dialog textarea (same as compose but in dialog)
    replyTextarea: {
      testId: 'tweetTextarea_0',
      css: ['div[contenteditable="true"]'],
    } satisfies SelectorStrategy,
    // Reply dialog submit button
    replySubmit: {
      testId: 'tweetButton',
      role: { role: 'button', name: 'Reply' },
      css: ['button[data-testid="tweetButton"]'],
    } satisfies SelectorStrategy,
  },

  // ── Feed ───────────────────────────────────────────────────────
  feed: {
    url: 'https://x.com/home',
    // Individual tweet articles in the feed
    tweetArticle: {
      testId: 'tweetText',
      css: ['article[data-testid="tweetText"]', 'div[data-testid="tweetText"]'],
    } satisfies SelectorStrategy,
    // Tweet link (for extracting post URL)
    tweetLink: {
      testId: undefined,
      css: ['a[href*="/status/"]', 'a[href^="/"][href*="/status/"]'],
    } satisfies SelectorStrategy,
  },

  // ── Profile ────────────────────────────────────────────────────
  profile: {
    // URL pattern: https://x.com/{username}
    urlPattern: /^https:\/\/x\.com\/([^/]+)$/,
    // Latest tweet on profile page
    latestTweet: {
      testId: 'tweetText',
      css: ['div[data-testid="tweetText"]'],
    } satisfies SelectorStrategy,
  },
} as const;
