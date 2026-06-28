// X.com (Twitter) selectors — multi-fallback strategy.
// X uses data-testid attributes for testing, which are relatively stable.
// Fallbacks use ARIA roles and CSS for resilience.

import type { SelectorStrategy } from '../selector-strategy.js';

export const X_SELECTORS = {
  // ── Login ──────────────────────────────────────────────────────
  // Selectors aligned with stealth-x (Youhai020616/stealth-x) — same Camoufox + Playwright stack.
  // Multi-fallback arrays: try first, fallback next. X changes DOM frequently, so each
  // selector group has multiple strategies.
  login: {
    url: 'https://x.com/i/flow/login',
    username: {
      testId: undefined,
      css: [
        'input[name="text"][autocomplete="username"]',
        'input[autocomplete="username"]',
        'input[name="text"]',
        'input[name="username_or_email"]',
        '#jf-input-username_or_email',
      ],
      label: { label: 'Phone, email, or username' },
    } satisfies SelectorStrategy,
    password: {
      css: ['input[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'],
      label: { label: 'Password' },
    } satisfies SelectorStrategy,
    // "Next" button — submits the username step of the multi-step wizard.
    // Distinct from "Log in" button (submits password step) per stealth-x.
    nextButton: {
      testId: 'LoginForm_Login_Button',
      role: { role: 'button', name: 'Next' },
      css: [
        '[data-testid="LoginForm_Login_Button"]',
        'button[role="button"]:has-text("Next")',
        'div[role="button"]:has-text("Next")',
        'button[type="submit"]:has-text("Continue")',
      ],
    } satisfies SelectorStrategy,
    // "Log in" button — submits the password step.
    submit: {
      testId: 'LoginForm_Login_Button',
      role: { role: 'button', name: 'Log in' },
      css: [
        '[data-testid="LoginForm_Login_Button"]',
        'button[role="button"]:has-text("Log in")',
        'div[role="button"]:has-text("Log in")',
        'button[type="submit"]',
      ],
    } satisfies SelectorStrategy,
    // 2FA / identity verification input — X uses ocfEnterTextTextInput for both
    // 2FA code and "enter phone/email to verify identity" challenge (stealth-x Step 1.5/3).
    twoFactorInput: {
      testId: 'ocfEnterTextTextInput',
      css: [
        'input[data-testid="ocfEnterTextTextInput"]',
        'input[name="text"][type="text"]',
      ],
    } satisfies SelectorStrategy,
    twoFactorConfirm: {
      testId: 'ocfEnterTextNextButton',
      role: { role: 'button', name: 'Next' },
      css: [
        '[data-testid="ocfEnterTextNextButton"]',
        'button[role="button"]:has-text("Next")',
        'div[role="button"]:has-text("Next")',
      ],
    } satisfies SelectorStrategy,
    successIndicator: {
      testId: 'AppTabBar_Home_Link',
      role: { role: 'link', name: 'Home' },
      css: ['a[href="/home"]'],
    } satisfies SelectorStrategy,
    // Account switcher button — most reliable logged-in indicator (stealth-x checkLoggedIn).
    // aria-label format: "Account menu, Accounts: @username" → extract @handle via regex.
    accountSwitcher: {
      testId: 'SideNav_AccountSwitcher_Button',
      css: ['[data-testid="SideNav_AccountSwitcher_Button"]'],
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
      css: [
        'button[data-testid="tweetButton"]',
        'div[role="button"][data-testid="tweetButton"]',
        'button[data-testid="tweetButtonInline"]',
        'div[role="button"][data-testid="tweetButtonInline"]',
      ],
    } satisfies SelectorStrategy,
    // Side nav compose button (fallback: open compose dialog from home page)
    sideNavComposeButton: {
      testId: 'SideNav_NewTweet_Button',
      role: { role: 'button', name: 'Post' },
      css: ['button[data-testid="SideNav_NewTweet_Button"]', 'a[href="/compose/post"]'],
    } satisfies SelectorStrategy,
    // After posting, URL should match /status/{id} — X historically uses numeric IDs
    // but we accept alphanumeric too in case of format changes.
    postUrlPattern: /\/status\/([A-Za-z0-9]+)$/,
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
      // X follow button: data-testid ends with "-follow" (e.g., "userFollow")
      // The old placementTracking testId was a wrapper, not the button itself.
      testId: undefined,
      role: { role: 'button', name: 'Follow' },
      css: [
        'div[role="button"][data-testid$="-follow"]',
        'div[role="button"][data-testid$="-Follow"]',
        'button[data-testid$="-follow"]',
        'button[aria-label*="Follow"]',
        'div[role="button"][aria-label*="Follow"]',
        'button:has-text("Follow")',
        'div[role="button"]:has-text("Follow")',
      ],
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
      css: ['div[data-testid="tweetText"]', 'article[data-testid="tweetText"]', 'article div[data-testid="tweetText"]'],
    } satisfies SelectorStrategy,
    // Tweet link (for extracting post URL) — matches any /status/ link
    tweetLink: {
      testId: undefined,
      css: ['a[href*="/status/"]', 'a[href^="/"][href*="/status/"]', 'article a[href*="/status/"]'],
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
