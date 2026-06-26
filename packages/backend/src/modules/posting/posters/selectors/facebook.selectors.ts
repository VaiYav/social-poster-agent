// Facebook selectors — multi-fallback strategy.
// Facebook is known for aggressive A/B testing and frequent UI changes.
// Primary: getByLabel/getByRole (accessibility tree).
// Fallbacks: legacy IDs (#email, #pass), then aria-label CSS, then text.

import type { SelectorStrategy } from '../selector-strategy.js';

export const FACEBOOK_SELECTORS = {
  // ── Login ──────────────────────────────────────────────────────
  login: {
    url: 'https://www.facebook.com/login',
    // Facebook's new login page uses labeled textboxes, not input#email
    email: {
      label: { label: 'Email address or mobile number' },
      css: [
        'input[aria-label*="Email"]',
        'input[aria-label*="email"]',
        'input[placeholder*="Email"]',
        'input[placeholder*="email"]',
        'input#email',
        'input[name="email"]',
      ],
    } satisfies SelectorStrategy,
    password: {
      label: { label: 'Password' },
      css: [
        'input[aria-label*="Password"]',
        'input[aria-label*="password"]',
        'input[type="password"]',
        'input#pass',
        'input[name="pass"]',
      ],
    } satisfies SelectorStrategy,
    submit: {
      role: { role: 'button', name: 'Log in' },
      text: { text: 'Log in', exact: true },
      css: ['button:has-text("Log in")', 'button[name="login"]', 'button[type="submit"]'],
    } satisfies SelectorStrategy,
    // After login, Facebook shows the main navigation bar
    successIndicator: {
      role: { role: 'navigation' },
      css: ['[role="navigation"]', '[role="banner"]', 'div[role="navigation"]'],
    } satisfies SelectorStrategy,
  },

  // ── Posting (Business Page) ────────────────────────────────────
  compose: {
    // Navigate to the business page first
    // URL: https://www.facebook.com/{pageSlug}/
    pageUrlPattern: /^https:\/\/www\.facebook\.com\/([^/]+)\/?$/,
    // "Create post" button on the page
    createPostButton: {
      role: { role: 'button', name: 'Create post' },
      text: { text: 'Create post', exact: false },
      css: [
        'div[role="button"]:has-text("Create post")',
        'div[role="button"]:has-text("What\'s on your mind")',
        'button:has-text("Create post")',
        'div[role="button"][aria-label*="Create"]',
      ],
    } satisfies SelectorStrategy,
    // Compose dialog textarea — contenteditable div
    textarea: {
      role: { role: 'textbox' },
      css: [
        'div[role="dialog"] div[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="post"]',
        'div[contenteditable="true"][data-contents="true"]',
        'div[contenteditable="true"]',
      ],
    } satisfies SelectorStrategy,
    // Publish button
    publishButton: {
      role: { role: 'button', name: 'Publish' },
      text: { text: 'Publish', exact: true },
      css: [
        'div[role="dialog"] div[role="button"]:has-text("Publish")',
        'div[role="button"]:has-text("Publish")',
        'button:has-text("Publish")',
        'div[role="button"]:has-text("Post")',
        'button:has-text("Post")',
      ],
    } satisfies SelectorStrategy,
    // After posting, URL may contain /posts/ or /permalink/
    postUrlPattern: /\/(posts|permalink|photos)\/\d+/,
  },

  // ── Engagement ─────────────────────────────────────────────────
  engagement: {
    like: {
      role: { role: 'button', name: 'Like' },
      css: [
        'div[role="button"][aria-label*="Like"]',
        'div[role="button"]:has(svg[aria-label*="Like"])',
        'button[aria-label*="Like"]',
      ],
    } satisfies SelectorStrategy,
    unlike: {
      role: { role: 'button', name: 'Remove Like' },
      css: [
        'div[role="button"][aria-label*="Remove Like"]',
        'div[role="button"][aria-label*="Liked"]',
      ],
    } satisfies SelectorStrategy,
    comment: {
      role: { role: 'button', name: 'Comment' },
      css: [
        'div[role="button"][aria-label*="Comment"]',
        'div[role="button"]:has(svg[aria-label*="Comment"])',
        'button[aria-label*="Comment"]',
      ],
    } satisfies SelectorStrategy,
    // Comment input field
    commentInput: {
      role: { role: 'textbox' },
      css: [
        'div[role="dialog"] div[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="comment"]',
        'div[contenteditable="true"][aria-label*="Comment"]',
        'input[placeholder*="comment"]',
        'div[contenteditable="true"]',
      ],
    } satisfies SelectorStrategy,
    // Comment submit button
    commentSubmit: {
      role: { role: 'button', name: 'Comment' },
      text: { text: 'Comment', exact: true },
      css: [
        'div[role="dialog"] div[role="button"]:has-text("Comment")',
        'div[role="button"]:has-text("Comment")',
        'button:has-text("Comment")',
      ],
    } satisfies SelectorStrategy,
    follow: {
      role: { role: 'button', name: 'Subscribe' },
      text: { text: 'Subscribe', exact: true },
      css: [
        'div[role="button"]:has-text("Subscribe")',
        'div[role="button"]:has-text("Follow")',
        'button:has-text("Subscribe")',
        'button:has-text("Follow")',
      ],
    } satisfies SelectorStrategy,
  },

  // ── Feed ───────────────────────────────────────────────────────
  feed: {
    // Page feed URL: https://www.facebook.com/{pageSlug}/
    url: (pageSlug: string) => `https://www.facebook.com/${pageSlug}/`,
    // Individual post articles in the feed
    postArticle: {
      css: ['div[role="article"]', 'article'],
    } satisfies SelectorStrategy,
    // Post link (for extracting post URL)
    postLink: {
      css: ['a[href*="/posts/"]', 'a[href*="/permalink/"]', 'a[href*="/photos/"]'],
    } satisfies SelectorStrategy,
  },

  // ── Profile/Page ───────────────────────────────────────────────
  profile: {
    // URL pattern: https://www.facebook.com/{pageSlug}
    urlPattern: /^https:\/\/www\.facebook\.com\/([^/]+)\/?$/,
    // Latest post on page
    latestPost: {
      css: ['div[role="article"]', 'article'],
    } satisfies SelectorStrategy,
    // Post text content within an article
    postText: {
      css: ['div[data-ad-comet-preview="message"]', 'div[dir="auto"]', 'div[data-contents="true"]'],
    } satisfies SelectorStrategy,
  },
} as const;
