// Threads selectors — multi-fallback strategy.
// Threads (by Meta) uses React with frequent UI changes.
// Primary: getByRole/getByLabel (accessibility tree is more stable than CSS).
// Fallbacks: aria-label CSS, then text-based.

import type { SelectorStrategy } from '../selector-strategy.js';

export const THREADS_SELECTORS = {
  // ── Login ──────────────────────────────────────────────────────
  login: {
    url: 'https://www.threads.com/login',
    username: {
      label: { label: 'Username, phone number or email address' },
      css: [
        'input[aria-label*="Username"]',
        'input[aria-label*="username"]',
        'input[placeholder*="Username"]',
        'input[placeholder*="username"]',
        'input[autocomplete="username"]',
      ],
    } satisfies SelectorStrategy,
    password: {
      label: { label: 'Password' },
      css: [
        'input[aria-label*="Password"]',
        'input[aria-label*="password"]',
        'input[type="password"]',
        'input[autocomplete="current-password"]',
      ],
    } satisfies SelectorStrategy,
    // Threads login button — must NOT match "Continue with Instagram" button
    submit: {
      role: { role: 'button', name: 'Log in' },
      css: [
        'div[role="button"]:has-text("Log in"):not(:has-text("Instagram"))',
        'button:has-text("Log in"):not(:has-text("Instagram"))',
      ],
    } satisfies SelectorStrategy,
    // After login, Threads shows a "New thread" button in the nav
    successIndicator: {
      role: { role: 'button', name: 'New thread' },
      css: ['button:has-text("New thread")', 'div[role="button"]:has-text("New thread")', 'button[aria-label="Create"]', 'button:has(img[aria-label="Create"])', 'a[href="/compose"]'],
    } satisfies SelectorStrategy,
  },

  // ── Posting ────────────────────────────────────────────────────
  compose: {
    // Navigate to home, then click New thread button
    homeUrl: 'https://www.threads.com/',
    // New thread button opens a compose dialog (modal)
    composeButton: {
      role: { role: 'button', name: 'New thread' },
      css: ['button:has-text("New thread")', 'div[role="button"]:has-text("New thread")', 'button[aria-label="Create"]', 'button:has(img[aria-label="Create"])', 'a[href="/compose"]'],
    } satisfies SelectorStrategy,
    // Compose dialog textarea — contenteditable div
    // Note: must be scoped to the dialog, not just any contenteditable on page
    textarea: {
      role: { role: 'textbox' },
      css: [
        'div[role="dialog"] div[contenteditable="true"]',
        'div[contenteditable="true"][data-contents="true"]',
        'div[contenteditable="true"]',
      ],
    } satisfies SelectorStrategy,
    // Post button in compose dialog
    submitButton: {
      role: { role: 'button', name: 'Post' },
      text: { text: 'Post', exact: true },
      css: [
        'div[role="dialog"] button:has-text("Post")',
        'div[role="button"]:has-text("Post")',
        'button:has-text("Post")',
      ],
    } satisfies SelectorStrategy,
    // After posting, navigate to profile to validate
    // Profile URL: https://www.threads.com/@username
    profileUrlPattern: /\/@[^/]+$/,
    // Post URL: https://www.threads.com/@username/post/XXXXX
    // Threads also uses public short links: https://www.threads.com/t/XXXXX
    // Allow optional trailing slash or query params so real permalinks are not rejected.
    postUrlPattern: /(?:\/@[^/]+\/post\/|\/t\/)[A-Za-z0-9_-]+(?:\?.*)?\/?$/,
  },

  // ── Engagement ─────────────────────────────────────────────────
  engagement: {
    like: {
      // Threads like button has a heart SVG with aria-label "Like" or "Liked"
      role: { role: 'button', name: 'Like' },
      css: [
        'div[role="button"]:has(svg[aria-label="Like"])',
        'button:has(svg[aria-label="Like"])',
        'div[role="button"][aria-label*="like"]',
      ],
    } satisfies SelectorStrategy,
    unlike: {
      role: { role: 'button', name: 'Liked' },
      css: [
        'div[role="button"]:has(svg[aria-label="Liked"])',
        'button:has(svg[aria-label="Liked"])',
      ],
    } satisfies SelectorStrategy,
    reply: {
      // Reply button on a post
      role: { role: 'button', name: 'Reply' },
      css: [
        'div[role="button"]:has(svg[aria-label*="Reply"])',
        'div[role="button"]:has(svg[aria-label*="reply"])',
      ],
    } satisfies SelectorStrategy,
    repost: {
      role: { role: 'button', name: 'Repost' },
      css: [
        'div[role="button"]:has(svg[aria-label*="Repost"])',
        'div[role="button"]:has(svg[aria-label*="repost"])',
      ],
    } satisfies SelectorStrategy,
    // Items in the Threads repost menu. Threads sometimes calls it "Repost" or "Quote".
    repostMenuRepost: {
      role: { role: 'menuitem', name: 'Repost' },
      text: { text: 'Repost', exact: false },
      css: [
        '[role="menuitem"]:has-text("Repost")',
        'div[role="button"]:has-text("Repost")',
      ],
    } satisfies SelectorStrategy,
    repostMenuQuote: {
      role: { role: 'menuitem', name: 'Quote' },
      text: { text: 'Quote', exact: false },
      css: [
        '[role="menuitem"]:has-text("Quote")',
        'div[role="button"]:has-text("Quote")',
      ],
    } satisfies SelectorStrategy,
    quoteTextarea: {
      css: ['div[role="dialog"] div[contenteditable="true"]', 'div[contenteditable="true"]'],
    } satisfies SelectorStrategy,
    quoteSubmit: {
      role: { role: 'button', name: 'Post' },
      text: { text: 'Post', exact: false },
      css: [
        'div[role="dialog"] button:has-text("Post")',
        'div[role="dialog"] div[role="button"]:has-text("Post")',
        'button:has-text("Post")',
        'div[role="button"]:has-text("Post")',
      ],
    } satisfies SelectorStrategy,
    follow: {
      role: { role: 'button', name: 'Follow' },
      text: { text: 'Follow', exact: true },
      css: ['div[role="button"]:has-text("Follow")', 'button:has-text("Follow")'],
    } satisfies SelectorStrategy,
    // Reply dialog textarea
    replyTextarea: {
      role: { role: 'textbox' },
      css: ['div[role="dialog"] div[contenteditable="true"]', 'div[contenteditable="true"]'],
    } satisfies SelectorStrategy,
    // Reply dialog submit button
    replySubmit: {
      role: { role: 'button', name: 'Post' },
      text: { text: 'Post', exact: true },
      css: ['div[role="dialog"] button:has-text("Post")', 'button:has-text("Post")'],
    } satisfies SelectorStrategy,
  },

  // ── Feed ───────────────────────────────────────────────────────
  feed: {
    url: 'https://www.threads.com/',
    // Individual post articles in the feed
    postArticle: {
      css: ['div[role="article"]', 'article'],
    } satisfies SelectorStrategy,
    // Post link (for extracting post URL)
    postLink: {
      css: ['a[href*="/post/"]', 'a[href^="/@"][href*="/post/"]'],
    } satisfies SelectorStrategy,
  },

  // ── Profile ────────────────────────────────────────────────────
  profile: {
    // URL pattern: https://www.threads.com/@username
    urlPattern: /\/@([^/]+)$/,
    // Latest post on profile page
    latestPost: {
      css: ['div[role="article"]', 'article'],
    } satisfies SelectorStrategy,
    // Post text content within an article
    postText: {
      css: ['div[data-contents="true"]', 'div[dir="auto"]'],
    } satisfies SelectorStrategy,
  },
} as const;
