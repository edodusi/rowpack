/**
 * The real-world check: TodoMVC Vanilla ES6 (13 app modules, flatpickr from
 * npm, 27 SVGs, a WAV, two stylesheets) must render and behave the same in
 * headless Chrome whether esbuild or rowpack bundled it.
 *
 * Needs `node demos/todomvc/prepare.js` and a local Chrome; skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPages } from '../bench/pages.js';
import { launch, load, chromePath } from '../bench/browser.js';

const entry = path.join(import.meta.dirname, '..', 'demos', 'todomvc', 'app', 'src', 'index.js');
const skip = !fs.existsSync(entry) ? 'run node demos/todomvc/prepare.js first' : !chromePath() ? 'no Chrome' : false;

test('TodoMVC renders and works the same in all three builds', { skip, timeout: 120_000 }, async () => {
  const pages = await buildPages(entry, fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-todo-')));
  const browser = await launch();
  try {
    const seen = {};
    for (const [name, file] of Object.entries(pages)) {
      const r = await load(browser, file);
      assert.deepEqual(r.errors, [], `${name}: page errors`);
      assert.equal(r.error, null, `${name}: bundle error`);
      const { page } = r;
      const initial = await page.evaluate(() => document.getElementById('root').innerHTML.replace(/blob:[^"']+|data:[^"']+/g, 'URL'));

      // create two lists, open the second, add a task to it
      const input = page.locator('#newList');
      for (const list of ['write the post', 'run the benchmark']) {
        await input.fill(list);
        await input.press('Enter');
      }
      await page.locator('.lists li').last().click();
      const taskInput = page.locator('#root input[type="text"]:not(#search-input):not(#newList)').first();
      await taskInput.fill('measure it');
      await taskInput.press('Enter');
      const after = await page.evaluate(() => ({
        texts: [...document.querySelectorAll('#root li')].map((li) => li.textContent.trim()).filter(Boolean),
        styles: document.querySelectorAll('style').length,
        stored: Object.keys(localStorage).length,
      }));
      seen[name] = { initial, after };
      await r.context.close();
    }

    assert.ok(seen.esbuild.initial.length > 1000, 'the app rendered something');
    for (const t of ['write the post', 'run the benchmark', 'measure it']) {
      assert.ok(seen.esbuild.after.texts.some((x) => x.includes(t)), `the app shows "${t}"`);
    }
    for (const name of ['fast', 'sql']) {
      assert.equal(seen[name].initial, seen.esbuild.initial, `${name}: initial DOM differs from esbuild`);
      assert.deepEqual(seen[name].after.texts, seen.esbuild.after.texts, `${name}: DOM after interaction differs`);
      assert.equal(seen[name].after.stored, seen.esbuild.after.stored, `${name}: localStorage differs`);
    }
  } finally {
    await browser.close();
  }
});
