/**
 * The module runtime shared by every engine. It only needs a way to fetch a
 * module record by id: the SQL engine runs one query, the materialized bundle
 * reads an object literal. Same code, same semantics.
 *
 * This function is serialized with toString() into the bundle, so it must not
 * close over anything outside its own body.
 *
 * A record is { path, format, deps: {idx: id}, exports: [[name, originId, originLocal|null]],
 *               code?: string, factory?: Function, mime?: string, content?: string|Uint8Array }
 */
export function createRuntime(getRecord, host) {
  const mods = new Map();

  function mod(id) {
    let m = mods.get(id);
    if (m) return m;
    const rec = getRecord(id);
    if (!rec) throw new Error(`rowpack: module ${id} is not in the bundle`);
    m = { id, rec, state: 0, locals: null, ns: null, module: null };
    mods.set(id, m);
    m.ns = rec.format === 'cjs' ? cjsNamespace(m) : namespace(m);
    return m;
  }

  function namespace(m) {
    const ns = Object.create(null);
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    for (const [name, originId, originLocal] of m.rec.exports) {
      Object.defineProperty(ns, name, {
        enumerable: true,
        get: originLocal === null
          ? () => mod(originId).ns
          : () => {
            const origin = mod(originId);
            if (!origin.locals) throw new ReferenceError(`Cannot access '${name}' before initialization`);
            return origin.locals[originLocal]();
          },
      });
    }
    return Object.preventExtensions(ns);
  }

  function cjsNamespace(m) {
    const exp = () => (m.module ? m.module.exports : undefined);
    return new Proxy(Object.create(null), {
      get(_, key) {
        const e = exp();
        if (key === Symbol.toStringTag) return 'Module';
        if (key === 'default') return e && e.__esModule ? e.default : e;
        return e == null ? undefined : e[key];
      },
      has: (_, key) => key === 'default' || (exp() != null && key in Object(exp())),
      ownKeys: () => ['default', ...Object.keys(Object(exp() ?? {}))],
      getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: key === 'default' ? exp() : exp()?.[key] }),
      set: () => false,
    });
  }

  function link(m, idx) {
    const id = m.rec.deps[idx];
    if (id == null) throw new Error(`rowpack: ${m.rec.path} has no resolved dependency #${idx}`);
    const dep = mod(id);
    evaluate(dep);
    return dep;
  }

  function evaluate(m) {
    if (m.state !== 0) return; // 1 = evaluating (a cycle), 2 = done
    m.state = 1;
    const rec = m.rec;
    switch (rec.format) {
      case 'esm': {
        const factory = rec.factory || new Function('__export', '__import', '__dynamic', `${rec.code}\n//# sourceURL=rowpack:///${rec.path}`);
        factory(
          (locals) => { m.locals = locals; },
          (idx) => link(m, idx).ns,
          (idx) => Promise.resolve().then(() => link(m, idx).ns),
        );
        break;
      }
      case 'cjs': {
        const module = (m.module = { exports: {} });
        const factory = rec.factory || new Function('module', 'exports', 'require', `${rec.code}\n//# sourceURL=rowpack:///${rec.path}`);
        factory.call(module.exports, module, module.exports, (idx) => {
          const dep = link(m, idx);
          return dep.rec.format === 'cjs' ? dep.module.exports : dep.ns;
        });
        break;
      }
      default: {
        const value = host.load(rec);
        m.locals = { default: () => value };
      }
    }
    m.state = 2;
  }

  return {
    run(entryId) {
      const m = mod(entryId);
      evaluate(m);
      return m.ns;
    },
  };
}

/**
 * Module records straight from the database. At startup one recursive query
 * fetches everything the entry imports statically (ldd, in one SELECT) and
 * all module bodies are compiled in one go; anything reached only through
 * import() is fetched by its own query when it is first needed.
 * `query(sql, params)` returns rows as objects. Also serialized.
 */
export function createSqlSource(query, entryId) {
  const CLOSURE = `WITH RECURSIVE closure(id) AS (
    SELECT ? UNION SELECT d.resolved_id FROM dependencies d JOIN closure c ON d.importer_id = c.id WHERE d.kind <> 'dynamic'
  ) SELECT l.id, l.path, l.format, l.code, l.deps, l.exports, a.mime, a.content
    FROM closure c JOIN load_image l ON l.id = c.id LEFT JOIN assets a ON a.id = l.asset_id`;
  const stats = { queries: 0, modules: 0, queryMs: 0, compileMs: 0 };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const cache = new Map();

  function timedQuery(sql, params) {
    const t = now();
    const rows = query(sql, params);
    stats.queryMs += now() - t;
    return rows;
  }

  function load(rows) {
    const t = now();
    // one compilation unit for the whole batch: V8 parses each body lazily on first call
    const js = rows.filter((r) => r.format === 'esm' || r.format === 'cjs');
    const factories = js.length
      ? new Function(`return [${js.map((r) => (r.format === 'esm'
        ? `function (__export, __import, __dynamic) {\n${r.code}\n}`
        : `function (module, exports, require) {\n${r.code}\n}`)).join(',\n')}];`)()
      : [];
    js.forEach((r, i) => { r.factory = factories[i]; });
    for (const r of rows) {
      r.deps = JSON.parse(r.deps);
      r.exports = JSON.parse(r.exports);
      cache.set(r.id, r);
    }
    stats.modules += rows.length;
    stats.compileMs += now() - t;
  }

  stats.queries++;
  load(timedQuery(CLOSURE, [entryId]));
  return {
    stats,
    getRecord(id) {
      if (!cache.has(id)) {
        stats.queries++;
        load(timedQuery(CLOSURE, [id]).filter((r) => !cache.has(r.id)));
      }
      return cache.get(id);
    },
  };
}

/** How non-JavaScript modules become values, per platform. Also serialized. */
export function createHost() {
  const isBrowser = typeof document !== 'undefined';
  const text = (c) => (typeof c === 'string' ? c : new TextDecoder().decode(c));
  return {
    load(rec) {
      switch (rec.format) {
        case 'json': return JSON.parse(text(rec.content));
        case 'text': return text(rec.content);
        case 'css': {
          const css = text(rec.content);
          if (isBrowser) {
            const style = document.createElement('style');
            style.dataset.module = rec.path;
            style.textContent = css;
            document.head.appendChild(style);
          }
          return css;
        }
        case 'url': {
          if (typeof rec.content === 'string') return rec.content; // already a URL
          if (isBrowser) return URL.createObjectURL(new Blob([rec.content], { type: rec.mime }));
          let bin = '';
          for (let i = 0; i < rec.content.length; i += 0x8000) bin += String.fromCharCode.apply(null, rec.content.subarray(i, i + 0x8000));
          return `data:${rec.mime};base64,${btoa(bin)}`;
        }
        default: throw new Error(`rowpack: unknown module format ${rec.format}`);
      }
    },
  };
}
