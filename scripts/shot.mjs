/** One-off: screenshot the web UI for visual verification. */
import { launch } from 'cloakbrowser';

const url = process.argv[2] || 'http://localhost:8088/';
const browser = await launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1320, height: 1500 });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/ui.png', fullPage: true });
  console.log('saved /tmp/ui.png');
} finally {
  await browser.close();
}
