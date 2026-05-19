/**
 * Diagnostic v2: retry past the sign-up wall, then capture the ASSISTANT
 * answer lifecycle. `.response-content-markdown` is used by both the user
 * bubble and the assistant reply, so the assistant one is found by excluding
 * any node inside [data-testid="user-message"].
 *
 * Usage: node scripts/inspect2.mjs [country]
 */
import 'dotenv/config';
import { launch } from 'cloakbrowser';

const cc = process.argv[2] || 'ca';
const PROMPT = 'What is the capital of France? Answer in one short sentence.';
const MAX_TRIES = 12;
const log = (...a) => console.log(...a);

function proxyUrl() {
  const user = `user-${process.env.DECODO_USERNAME}-country-${cc}`;
  return (
    `http://${encodeURIComponent(user)}:${encodeURIComponent(process.env.DECODO_PASSWORD)}` +
    `@${process.env.DECODO_HOST}:${process.env.DECODO_PORT}`
  );
}

// Runs in the browser: assistant answer text + wall + button labels.
function probe() {
  const all = Array.from(document.querySelectorAll('.response-content-markdown'));
  const assistant = all.filter((el) => !el.closest('[data-testid="user-message"]'));
  const last = assistant[assistant.length - 1];
  const body = ((document.body && document.body.innerText) || '').toLowerCase();
  return {
    assistantCount: assistant.length,
    answerText: last ? (last.innerText || '').trim() : null,
    wall:
      body.includes('sign up to keep chatting') || body.includes('really high demand'),
    hasComposer: !!document.querySelector('textarea, [contenteditable="true"]'),
    buttons: Array.from(document.querySelectorAll('button'))
      .map(
        (b) =>
          b.getAttribute('aria-label') ||
          b.getAttribute('data-testid') ||
          (b.innerText || '').trim(),
      )
      .filter(Boolean),
  };
}

async function attempt() {
  const browser = await launch({ headless: true, proxy: proxyUrl(), humanize: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);
    await page.route('**/*', (r) => {
      const t = r.request().resourceType();
      if (t === 'image' || t === 'media') r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });

    await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    for (const sel of ['#onetrust-accept-btn-handler', '#onetrust-reject-all-handler']) {
      const b = await page.$(sel);
      if (b) { await b.click().catch(() => {}); break; }
    }

    // Wait for the composer (or detect a wall shown on load).
    let ready = false;
    for (let i = 0; i < 24; i += 1) {
      const s = await page.evaluate(probe);
      if (s.wall) { log('  WALLED on load'); return false; }
      if (s.hasComposer) { ready = true; break; }
      await page.waitForTimeout(500);
    }
    if (!ready) { log('  no composer (timeout)'); return false; }

    const composer = await page.$('textarea, [contenteditable="true"]');
    await composer.click();
    await page.keyboard.type(PROMPT, { delay: 15 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');

    let lastText = '';
    let stable = 0;
    let gotAnswer = false;
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(1000);
      const s = await page.evaluate(probe);
      if (s.wall && !s.answerText) { log(`  +${i + 1}s WALLED`); return false; }

      const len = s.answerText ? s.answerText.length : 0;
      if (i % 2 === 0 || (s.answerText && s.answerText !== lastText)) {
        log(`  +${i + 1}s assistantCount=${s.assistantCount} answerLen=${len} buttons=[${s.buttons.join(' | ')}]`);
      }
      if (s.answerText && s.answerText.length > 0) {
        gotAnswer = true;
        if (s.answerText === lastText) stable += 1;
        else { stable = 0; lastText = s.answerText; }
        if (stable >= 4) { log(`  answer stable after +${i + 1}s`); break; }
      }
    }
    if (!gotAnswer) { log('  no assistant answer appeared'); return false; }

    const dump = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.response-content-markdown'));
      const assistant = all.filter((el) => !el.closest('[data-testid="user-message"]'));
      const ans = assistant[assistant.length - 1];
      const chain = [];
      let el = ans;
      for (let i = 0; el && i < 8; i += 1) {
        chain.push({
          tag: el.tagName,
          testid: el.getAttribute('data-testid'),
          className: String(el.className || '').slice(0, 130),
        });
        el = el.parentElement;
      }
      return {
        answerText: ans ? (ans.innerText || '').trim() : null,
        answerOuterHTML: ans ? ans.outerHTML.slice(0, 1600) : null,
        answerParentChain: chain,
        messageBubbles: Array.from(
          document.querySelectorAll('[class*="message-bubble" i],[data-testid*="message" i]'),
        ).map((e) => ({
          tag: e.tagName,
          testid: e.getAttribute('data-testid'),
          className: String(e.className || '').slice(0, 90),
          textStart: (e.innerText || '').trim().slice(0, 50),
        })),
        answerLinks: ans
          ? Array.from(ans.querySelectorAll('a')).map((a) => ({
              href: a.href,
              text: (a.innerText || '').trim().slice(0, 40),
            }))
          : [],
        citationish: Array.from(
          document.querySelectorAll(
            '[class*="citation" i],[class*="source" i],[data-testid*="source" i],[data-testid*="citation" i]',
          ),
        )
          .slice(0, 12)
          .map((e) => ({
            tag: e.tagName,
            testid: e.getAttribute('data-testid'),
            className: String(e.className || '').slice(0, 90),
            text: (e.innerText || '').trim().slice(0, 50),
          })),
      };
    });
    log('\n=== FINAL DUMP ===');
    log(JSON.stringify(dump, null, 2));
    await page.screenshot({ path: '/tmp/grok-answer.png', fullPage: true });
    return true;
  } finally {
    await browser.close().catch(() => {});
  }
}

for (let t = 1; t <= MAX_TRIES; t += 1) {
  log(`\n--- attempt ${t}/${MAX_TRIES} (country=${cc}) ---`);
  let ok = false;
  try {
    ok = await attempt();
  } catch (e) {
    log('  error:', e?.message || String(e));
  }
  if (ok) {
    log('\nSUCCESS — captured a real assistant answer.');
    process.exit(0);
  }
}
log('\nAll attempts walled/failed.');
process.exit(1);
