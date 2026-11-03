/**
 * The static linker: turns a bundle into one flat script, the way ld turns
 * object files into an executable. Modules are laid out in ESM evaluation
 * order in a single scope, every module-level binding gets a unique name, and
 * each relocation is patched to point straight at the binding it resolves to.
 * After linking there are no namespace lookups left on the hot path.
 *
 * The relocation targets come from SQL (the resolved_relocations view).
 * Bundles this cannot express exactly fall back to the dynamic runtime.
 */
import { DatabaseSync } from 'node:sqlite';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (name) => (IDENT.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);

const HELPERS = {
  ns: `function __rp_ns(getters) {
  var ns = Object.create(null);
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  Object.keys(getters).sort().forEach(function (k) { Object.defineProperty(ns, k, { enumerable: true, get: getters[k] }); });
  return Object.preventExtensions(ns);
}`,
  cjs: `function __rp_cjs(factory, deps) {
  var module;
  return function () {
    if (!module) {
      module = { exports: {} };
      factory.call(module.exports, module, module.exports, function (i) { return deps()[i](); });
    }
    return module.exports;
  };
}
function __rp_cjsns(e) {
  var ns = Object.create(null);
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  if (e != null && (typeof e === "object" || typeof e === "function")) {
    Object.keys(e).forEach(function (k) { if (k !== "default") Object.defineProperty(ns, k, { enumerable: true, get: function () { return e[k]; } }); });
  }
  Object.defineProperty(ns, "default", { enumerable: true, value: e && e.__esModule ? e.default : e });
  return ns;
}`,
  css: `function __rp_css(css, path) {
  if (typeof document !== "undefined") {
    var style = document.createElement("style");
    style.dataset.module = path;
    style.textContent = css;
    document.head.appendChild(style);
  }
  return css;
}`,
};

/**
 * @param {string} file .sqlite bundle
 * @returns {{ code: string } | { fallback: string }}
 */
export function staticLink(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return link(db);
  } finally {
    db.close();
  }
}

function link(db) {
  const all = (sql) => db.prepare(sql).all();
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'stripped'").get()) return { fallback: 'the bundle was stripped of its relocations' };
  const modules = new Map(all('SELECT m.id, m.path, m.format, m.is_entry, a.mime, a.content FROM modules m LEFT JOIN assets a ON a.id = m.asset_id').map((m) => [m.id, m]));
  const deps = new Map();
  for (const d of all('SELECT importer_id, idx, kind, resolved_id FROM dependencies ORDER BY importer_id, idx')) {
    if (!deps.has(d.importer_id)) deps.set(d.importer_id, []);
    deps.get(d.importer_id).push(d);
  }
  const statements = new Map();
  for (const s of all('SELECT module_id, idx, code FROM statements ORDER BY module_id, idx')) {
    if (!statements.has(s.module_id)) statements.set(s.module_id, []);
    statements.get(s.module_id).push({ ...s, relocs: [] });
  }
  const byStmt = new Map();
  for (const list of statements.values()) for (const s of list) byStmt.set(`${s.module_id}:${s.idx}`, s);
  for (const r of all('SELECT * FROM resolved_relocations ORDER BY module_id, stmt_idx, start')) {
    byStmt.get(`${r.module_id}:${r.stmt_idx}`)?.relocs.push(r);
  }
  const linked = new Map();
  for (const x of all('SELECT module_id, name, origin_id, origin_local FROM linked_exports ORDER BY module_id, name')) {
    if (!linked.has(x.module_id)) linked.set(x.module_id, []);
    linked.get(x.module_id).push(x);
  }
  const reserved = new Set(all('SELECT name FROM reserved_names').map((r) => r.name));
  if (reserved.has('eval')) return { fallback: 'a module calls eval(), which can see module scope' };

  // ---- evaluation order: depth-first post-order over static imports ------
  const entry = [...modules.values()].find((m) => m.is_entry).id;
  const order = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const m = modules.get(id);
    if (m.format === 'esm') for (const d of deps.get(id) || []) if (d.kind === 'static') visit(d.resolved_id);
    order.push(id);
  };
  visit(entry);
  const inStatic = new Set(order);
  const cjsReachable = new Set();
  const visitCjs = (id) => {
    if (cjsReachable.has(id)) return;
    cjsReachable.add(id);
    for (const d of deps.get(id) || []) {
      const t = modules.get(d.resolved_id);
      if (t.format !== 'cjs') throw Object.assign(new Error(`${modules.get(id).path} requires ${t.format} module ${t.path}`), { fallback: true });
      visitCjs(t.id);
    }
  };
  try {
    for (const id of order) if (modules.get(id).format === 'cjs') visitCjs(id);
  } catch (err) {
    if (err.fallback) return { fallback: err.message };
    throw err;
  }
  for (const list of deps.values()) {
    for (const d of list) {
      if (d.kind === 'dynamic' && !inStatic.has(d.resolved_id)) {
        return { fallback: `${modules.get(d.importer_id).path} lazily imports ${modules.get(d.resolved_id).path}, which nothing imports statically` };
      }
    }
  }

  // ---- names: one scope, so every module-level binding needs a unique one -
  const taken = new Set(reserved);
  const names = new Map(); // "id:local" -> final name
  const claim = (base) => {
    let name = IDENT.test(base) && !base.startsWith('__rp_') ? base : `_${base.replace(/[^\w$]/g, '_')}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
    for (let i = 1; ; i++) {
      if (!taken.has(`${name}$${i}`)) {
        taken.add(`${name}$${i}`);
        return `${name}$${i}`;
      }
    }
  };
  const nameOf = (id, local) => {
    const key = `${id}:${local}`;
    if (!names.has(key)) {
      const m = modules.get(id);
      // derived names always carry a suffix, so they can never be a keyword ("delete.svg")
      const file = m.path.split('/').pop();
      const stem = file.replace(/\.[^.]+$/, '');
      const ext = file.slice(stem.length + 1) || m.format;
      const base = local === '__rp_default' ? `${stem}_default` : m.format !== 'esm' ? `${stem}_${ext}` : local;
      names.set(key, claim(base || 'module'));
    }
    return names.get(key);
  };
  for (const id of order) {
    for (const s of statements.get(id) || []) for (const r of s.relocs) if (r.kind === 'local') nameOf(id, r.name);
  }

  // ---- namespaces that something reads as an object ----------------------
  const nsNeeded = new Set();
  const cjsNs = (id) => `__rp_cjsns_${id}`;
  const nsVar = (id) => (modules.get(id).format === 'cjs' ? cjsNs(id) : `__rp_ns_${id}`);
  const needNs = (id) => {
    if (modules.get(id).format === 'cjs' || nsNeeded.has(id)) return;
    nsNeeded.add(id);
    for (const x of linked.get(id) || []) if (x.origin_local === null) needNs(x.origin_id);
  };

  const target = (r) => {
    if (r.target_format === 'cjs') {
      if (r.name === '*') return cjsNs(r.target_id);
      return cjsNs(r.target_id) + prop(r.name);
    }
    if (r.target_local === null) {
      needNs(r.target_id);
      return nsVar(r.target_id);
    }
    return nameOf(r.target_id, r.target_local);
  };

  const relocate = (s) => {
    let out = '';
    let pos = 0;
    for (const r of s.relocs) {
      out += s.code.slice(pos, r.start);
      pos = r.end;
      if (r.kind === 'local') {
        const fin = nameOf(r.target_id, r.name);
        out += r.form === 'shorthand' && fin !== r.name ? `${r.name}: ${fin}` : fin;
      } else if (r.kind === 'dynamic') {
        const t = r.target_format === 'cjs' ? cjsNs(r.target_id) : (needNs(r.target_id), nsVar(r.target_id));
        out += `Promise.resolve().then(function () { return ${t}; })`;
      } else {
        const t = target(r);
        const simple = IDENT.test(t);
        if (r.form === 'callee') out += simple ? t : `(0, ${t})`;
        else if (r.form === 'shorthand') out += `${r.local}: ${t}`;
        else out += t;
      }
    }
    return out + s.code.slice(pos);
  };

  // ---- layout -------------------------------------------------------------
  const body = [];
  const cjsDefs = [];
  const used = new Set();
  for (const id of order) {
    const m = modules.get(id);
    if (m.format === 'esm') {
      const stmts = statements.get(id) || [];
      if (stmts.length) body.push(`// ${m.path}\n${stmts.map(relocate).join('\n')}`);
    } else if (m.format === 'cjs') {
      body.push(`var ${cjsNs(id)} = __rp_cjsns(__rp_require_${id}());`);
      used.add('cjs');
    } else {
      const name = nameOf(id, 'default');
      const text = typeof m.content === 'string' ? m.content : null;
      let value;
      if (m.format === 'json') value = `JSON.parse(${JSON.stringify(text)})`;
      else if (m.format === 'text') value = JSON.stringify(text);
      else if (m.format === 'css') {
        value = `__rp_css(${JSON.stringify(text)}, ${JSON.stringify(m.path)})`;
        used.add('css');
      } else value = JSON.stringify(`data:${m.mime};base64,${Buffer.from(m.content).toString('base64')}`);
      body.push(`var ${name} = ${value};`);
    }
  }
  for (const id of cjsReachable) {
    used.add('cjs');
    const m = modules.get(id);
    const code = (statements.get(id) || [])[0]?.code ?? '';
    const req = (deps.get(id) || []).map((d) => `__rp_require_${d.resolved_id}`).join(', ');
    cjsDefs.push(`// ${m.path}\nvar __rp_require_${id} = __rp_cjs(function (module, exports, require) {\n${code}\n}, function () { return [${req}]; });`);
  }

  // namespace objects are getters, so they can be created before any module runs
  const nsDefs = [];
  for (const id of [...nsNeeded].sort((a, b) => a - b)) {
    const getters = (linked.get(id) || []).map((x) => {
      const t = x.origin_local === null ? nsVar(x.origin_id) : nameOf(x.origin_id, x.origin_local);
      return `${JSON.stringify(x.name)}: function () { return ${t}; }`;
    });
    nsDefs.push(`var ${nsVar(id)} = __rp_ns({ ${getters.join(', ')} });`);
    used.add('ns');
  }
  // needNs may have been triggered while relocating, so layout namespaces last
  const helpers = [...used].map((k) => HELPERS[k]).join('\n');

  const code = `(function () {
${helpers}
${cjsDefs.join('\n')}
(function () {
"use strict";
${nsDefs.join('\n')}
${body.join('\n')}
}).call(undefined);
}).call(undefined);
`;
  return { code };
}
