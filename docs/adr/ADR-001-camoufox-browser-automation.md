# ADR-001: Camoufox for Browser Automation

**Status:** Accepted  
**Date:** 2026-07-15  
**Decider:** Valentyn Yakovliev

## Context

The Social Poster Agent needs to automate posting to X (Twitter), Threads, and Facebook via browser automation. Standard Playwright with Chromium is easily detected by social platforms' anti-bot systems, leading to account bans.

## Decision

Use **Camoufox** (anti-detect Firefox fork) as the browser backend for Playwright.

## Rationale

- Camoufox patches Firefox at the C++ level to spoof fingerprinting signals (canvas, WebGL, fonts, navigator properties)
- Maintains a real Firefox profile — not a patched Chromium that can be detected via CDP
- Compatible with Playwright's Firefox protocol — no API changes needed
- Better ban resistance vs. Chromium-based stealth plugins (puppeteer-extra-plugin-stealth)

## Consequences

**Positive:**
- Lower ban rate on X and Facebook
- No CDP detection vector
- Standard Playwright API works unchanged

**Negative:**
- Larger binary (~200MB Firefox fork)
- Slower startup than Chromium
- Must build from source or use prebuilt binaries per platform
- No headless mode by default (must use `headless: 'new'` or Xvfb)

## Alternatives Considered

1. **Standard Playwright Chromium** — easily detected, high ban risk
2. **puppeteer-extra + stealth plugin** — Chromium-based, CDP detectable
3. **resolvable-browser** — commercial, expensive
4. **Manual posting** — doesn't scale

## References

- [Camoufox GitHub](https://github.com/daijro/camoufox)
- CONSTITUTION §6: "Browser = Camoufox (anti-detect Firefox)"
