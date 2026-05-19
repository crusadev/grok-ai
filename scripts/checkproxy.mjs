/**
 * Diagnostic: verify each tab (browser context) really gets its own proxy IP.
 * Mirrors the production path — one browser launched with the per-context
 * placeholder proxy, then N contexts each with buildProxy()-style settings.
 *
 * Usage: node scripts/checkproxy.mjs [country] [tabs]
 */
import 'dotenv/config';
import { launch } from 'cloakbrowser';

const cc = process.argv[2] || 'ca';
const tabs = Number(process.argv[3] || 5);

const proxy = {
  server: `http://${process.env.DECODO_HOST}:${process.env.DECODO_PORT}`,
  username: `user-${process.env.DECODO_USERNAME}-country-${cc}`,
  password: process.env.DECODO_PASSWORD,
};

const browser = await launch({ headless: true, proxy: { server: 'per-context' } });
try {
  const results = await Promise.all(
    Array.from({ length: tabs }, (_unused, i) =>
      (async () => {
        const context = await browser.newContext({ proxy });
        try {
          const page = await context.newPage();
          await page.goto('https://ipinfo.io/json', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          const body = await page.evaluate(() => document.body.innerText);
          const info = JSON.parse(body);
          return { tab: i + 1, ip: info.ip, country: info.country, city: info.city };
        } catch (err) {
          return { tab: i + 1, error: err?.message || String(err) };
        } finally {
          await context.close().catch(() => {});
        }
      })(),
    ),
  );

  for (const r of results) console.log(JSON.stringify(r));

  const ips = results.filter((r) => r.ip).map((r) => r.ip);
  const unique = new Set(ips);
  console.log(`\n${ips.length}/${tabs} tabs returned an IP — ${unique.size} unique`);
  if (ips.length === tabs && unique.size === tabs) {
    console.log('PASS — every tab has its own distinct proxy IP');
  } else {
    console.log('CHECK — repeated IPs or errors above');
  }
} finally {
  await browser.close();
}
