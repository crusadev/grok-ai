/**
 * One-off diagnostic: drive grok.com as a guest, dump DOM structure and
 * screenshots so the real selectors can be discovered. Not part of the service.
 *
 * Usage: node scripts/inspect.mjs [country] [prompt]
 */
import 'dotenv/config';
import { launch } from 'cloakbrowser';

const cc = process.argv[2] || 'us';
const prompt =
  process.argv[3] || 'What is the capital of France? Answer in one short sentence.';

const user = `user-${process.env.DECODO_USERNAME}-country-${cc}`;
const proxy =
  `http://${encodeURIComponent(user)}:${encodeURIComponent(process.env.DECODO_PASSWORD)}` +
  `@${process.env.DECODO_HOST}:${process.env.DECODO_PORT}`;

const log = (...a) => console.log(...a);

const browser = await launch({ headless: true, proxy, humanize: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media') route.abort().catch(() => {});
    else route.continue().catch(() => {});
  });

  log('navigating to grok.com ...');
  await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/grok-1-load.png', fullPage: true });

  const afterLoad = await page.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 1800),
      textareas: q('textarea').map((t) => ({
        placeholder: t.placeholder,
        aria: t.getAttribute('aria-label'),
        className: t.className,
      })),
      editables: q('[contenteditable="true"]').map((e) => ({
        tag: e.tagName,
        aria: e.getAttribute('aria-label'),
        dataPlaceholder: e.getAttribute('data-placeholder'),
        className: e.className,
      })),
      buttons: q('button').slice(0, 50).map((b) => ({
        aria: b.getAttribute('aria-label'),
        text: (b.innerText || '').trim().slice(0, 40),
        testid: b.getAttribute('data-testid'),
        type: b.type,
      })),
    };
  });
  log('\n=== AFTER LOAD ===');
  log(JSON.stringify(afterLoad, null, 2));

  // Try to type into the first textarea / contenteditable and submit.
  const composer = await page.$('textarea, [contenteditable="true"]');
  if (!composer) {
    log('\n!! No composer (textarea/contenteditable) found — stopping.');
  } else {
    log('\ncomposer found — typing prompt ...');
    await composer.click();
    await page.keyboard.type(prompt, { delay: 20 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: '/tmp/grok-2-typed.png', fullPage: true });
    await page.keyboard.press('Enter');
    log('submitted — waiting 30s for the answer ...');

    for (let i = 1; i <= 6; i += 1) {
      await page.waitForTimeout(5000);
      const snap = await page.evaluate(() => ({
        bodyLen: (document.body?.innerText || '').length,
        hasWall: (document.body?.innerText || '')
          .toLowerCase()
          .includes('sign up to keep chatting'),
      }));
      log(`  +${i * 5}s  bodyLen=${snap.bodyLen}  signupWall=${snap.hasWall}`);
    }
    await page.screenshot({ path: '/tmp/grok-3-answer.png', fullPage: true });

    const afterAnswer = await page.evaluate(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      // Heuristic: elements that look like message bubbles.
      const candidates = q(
        '[data-testid], [class*="message" i], [class*="response" i], [class*="bubble" i], [class*="prose" i], [class*="markdown" i]',
      )
        .filter((el) => (el.innerText || '').trim().length > 20)
        .slice(0, 25)
        .map((el) => ({
          tag: el.tagName,
          testid: el.getAttribute('data-testid'),
          className: String(el.className).slice(0, 120),
          textStart: (el.innerText || '').trim().slice(0, 80),
        }));
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 2500),
        messageCandidates: candidates,
        links: q('a[href^="http"]').slice(0, 20).map((a) => a.href),
      };
    });
    log('\n=== AFTER ANSWER ===');
    log(JSON.stringify(afterAnswer, null, 2));
  }
  log('\nscreenshots: /tmp/grok-1-load.png /tmp/grok-2-typed.png /tmp/grok-3-answer.png');
} catch (err) {
  log('ERROR:', err?.message || String(err));
} finally {
  await browser.close().catch(() => {});
}
