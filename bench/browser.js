/**
 * Headless Chrome helpers shared by the TodoMVC test and the benchmark.
 * Uses the system Chrome through playwright-core (no browser download).
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const chromePath = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

export async function launch() {
  const executablePath = chromePath();
  if (!executablePath) throw new Error('no Chrome found; set CHROME_PATH');
  return chromium.launch({ executablePath, headless: true });
}

/**
 * Open a page from disk, wait until the bundle reports it is done, return
 * timings, errors and the rendered app.
 */
export async function load(browser, file, { cpuSlowdown = 1 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (cpuSlowdown > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
  }
  await page.goto(`file://${file}`);
  await page.waitForFunction(() => window.__rowpack || window.__rowpackError, null, { timeout: 60_000 });
  const result = await page.evaluate(() => ({
    rowpack: window.__rowpack ? { ...window.__rowpack, db: undefined } : null,
    error: window.__rowpackError || null,
    nav: performance.getEntriesByType('navigation')[0]?.toJSON(),
    heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null,
  }));
  return { page, context, errors, ...result };
}
