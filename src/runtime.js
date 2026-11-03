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
