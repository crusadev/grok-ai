/** One-off: drive the UI through a scrape to screenshot the loader + result. */
import { launch } from 'cloakbrowser';

const browser = await launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1320, height: 1180 });
  await page.goto('http://localhost:8088/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.fill('.submit__prompt', 'Name one mountain.');
  await page.click('.btn');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: '/tmp/ui-loading.png' });
  console.log('saved /tmp/ui-loading.png');

  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(3000);
    if (await page.$('.result')) break;
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/ui-result.png', fullPage: true });
  console.log('saved /tmp/ui-result.png');
} finally {
  await browser.close();
}
