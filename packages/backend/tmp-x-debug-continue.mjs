import { Camoufox } from 'camoufox-js';

const browser = await Camoufox({
  headless: true,
  humanize: true,
  geoip: true,
  os: 'windows',
  locale: 'en-US',
});

const context = await browser.newContext({ viewport: null });
const page = await context.newPage();

await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);
console.log('url:', page.url());

const candidates = await page.getByText('Continue', { exact: true }).all();
console.log('Continue candidates:', candidates.length);
for (let i = 0; i < candidates.length; i++) {
  const playwrightVisible = await candidates[i].isVisible().catch(() => false);
  console.log(`candidate[${i}] isVisible:`, playwrightVisible);
  const info = await candidates[i].evaluate((el) => {
    const s = window.getComputedStyle(el);
    const isVisible = (e) => {
      const st = window.getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      return true;
    };
    let parentClickable = null;
    let p = el.parentElement;
    while (p && !parentClickable) {
      const st = window.getComputedStyle(p);
      const tag = p.tagName.toLowerCase();
      const role = p.getAttribute('role');
      const cls = p.className;
      if (role === 'button' || tag === 'button' || st.cursor === 'pointer' || cls.includes('btn') || cls.includes('button')) {
        parentClickable = { tag, role, className: cls, cursor: st.cursor };
      }
      p = p.parentElement;
      if (p && p.tagName.toLowerCase() === 'body') break;
    }
    return {
      tag: el.tagName.toLowerCase(),
      className: el.className,
      opacity: s.opacity,
      display: s.display,
      visibility: s.visibility,
      pointerEvents: s.pointerEvents,
      ariaHidden: el.getAttribute('aria-hidden'),
      rect: el.getBoundingClientRect(),
      isVisible: isVisible(el),
      parentClickable,
      outerHTML: el.outerHTML.slice(0, 300),
    };
  });
  console.log(`candidate[${i}]`, info);
}

await context.close();
await browser.close();
