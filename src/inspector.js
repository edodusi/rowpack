/**
 * A small SQL console for the SQL engine page: the page queries the bundle
 * it is running from. Opt in with --inspector.
 */
export const INSPECTOR = `<style>
#rp-inspector { position: fixed; right: 12px; bottom: 12px; width: min(560px, 95vw); max-height: 60vh; display: flex; flex-direction: column;
  font: 12px/1.4 ui-monospace, Menlo, monospace; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 8px; z-index: 99999; }
#rp-inspector header { padding: 8px 10px; border-bottom: 1px solid #30363d; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
#rp-inspector header b { margin-right: auto; }
#rp-inspector button { font: inherit; background: #21262d; color: inherit; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
#rp-inspector textarea { font: inherit; background: #010409; color: inherit; border: 0; border-bottom: 1px solid #30363d; padding: 8px 10px; min-height: 3.2em; resize: vertical; }
#rp-inspector .out { overflow: auto; padding: 0 10px 10px; }
#rp-inspector table { border-collapse: collapse; margin-top: 8px; }
#rp-inspector td, #rp-inspector th { border-bottom: 1px solid #21262d; padding: 2px 8px 2px 0; text-align: left; white-space: nowrap; max-width: 28ch; overflow: hidden; text-overflow: ellipsis; }
</style>
<section id="rp-inspector" aria-label="Bundle inspector">
  <header><b>this page is a database</b>
    <button data-q="SELECT * FROM ldd">ldd</button>
    <button data-q="SELECT * FROM symbols">nm</button>
    <button data-q="SELECT * FROM module_sizes">sizes</button>
    <button data-run>run</button></header>
  <textarea spellcheck="false" aria-label="SQL">SELECT * FROM ldd</textarea>
  <div class="out" role="region" aria-live="polite"></div>
</section>
<script>
(() => {
  const box = document.getElementById('rp-inspector');
  const sql = box.querySelector('textarea');
  const out = box.querySelector('.out');
  const esc = (v) => String(v instanceof Uint8Array ? '<' + v.length + ' bytes>' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const run = () => {
    const db = window.__rowpack && window.__rowpack.db;
    if (!db) return;
    try {
      const res = db.exec(sql.value);
      out.innerHTML = res.length ? res.map((r) => '<table><tr>' + r.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' +
        r.values.slice(0, 500).map((row) => '<tr>' + row.map((v) => '<td title="' + esc(v) + '">' + esc(v) + '</td>').join('') + '</tr>').join('') + '</table>').join('') : '<p>no rows</p>';
    } catch (e) { out.textContent = String(e.message || e); }
  };
  box.addEventListener('click', (e) => {
    if (e.target.dataset.q) { sql.value = e.target.dataset.q; run(); }
    if (e.target.hasAttribute('data-run')) run();
  });
  sql.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });
  const wait = setInterval(() => { if (window.__rowpack) { clearInterval(wait); run(); } }, 20);
})();
</script>`;
