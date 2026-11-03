#!/usr/bin/env node
// node bench/screenshot.js <page.html> <out.png>: wait for the bundle, take a screenshot
import { launch } from './browser.js';

const [file, out] = process.argv.slice(2);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`file://${file}`);
await page.waitForFunction(() => window.__rowpack || window.__rowpackError);
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
