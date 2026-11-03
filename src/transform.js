/**
 * Turns one JavaScript module into rows: statements, bindings, references,
 * relocations, exports and dependencies. Nothing here touches SQLite; the
 * bundler inserts the result and SQL does the linking.
 *
 * Statement code is written in "dynamic" form: an import becomes a live read
 * from the dependency's namespace object (`__rp_i0.name`), which gives real
 * live bindings, cycles and TDZ errors with no copying. Every place that names
 * a module-level binding or an import is also recorded as a relocation, so the
 * static linker can later rewrite it into a direct variable, like ld does.
 */
import { Parser } from 'acorn';
import { walk } from 'estree-walker';
import isReference from 'is-reference';
import { analyze } from 'periscopic';

const IDENT = /^[A-Za-z_$][\w$]*$/;
export const prop = (name) => (IDENT.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);
const keyName = (node) => (node.type === 'Identifier' ? node.name : String(node.value));
export const importVar = (idx) => `__rp_i${idx}`;
export const DEFAULT_LOCAL = '__rp_default';

/**
 * @typedef {{kind: 'local'|'import'|'dynamic', name: string, dep?: number, form: 'plain'|'callee'|'shorthand', start: number, end: number}} Relocation
 * @typedef {{ code: string, pure: boolean, declares: string[], refs: Array<{kind: 'local'|'import', name: string, dep?: number}>, relocations: Relocation[] }} Statement
 */

/**
 * @param {string} source
 * @param {string} id  module path, used in error messages
 */
export function transformModule(source, id) {
  let ast;
  try {
    ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (err) {
    throw new Error(`${id}: ${err.message}`);
  }

  const isEsm = ast.body.some((n) => n.type === 'ImportDeclaration' || n.type.startsWith('Export'));
  const { map, scope: moduleScope, globals } = analyze(ast);
  const isCjs = !isEsm && (globals.has('module') || globals.has('exports') || globals.has('require'));

  const deps = [];
  const depIndex = new Map();
  const warnings = [];
  const addDep = (specifier, kind) => {
    const key = `${kind === 'dynamic' ? 'd' : 's'}:${specifier}`;
    if (!depIndex.has(key)) {
      depIndex.set(key, deps.length);
      deps.push({ specifier, kind });
    }
    return depIndex.get(key);
  };

  /** source edits: { start, end, text, reloc? } — never overlapping */
  const edits = [];
  /** per top-level statement: bindings it reads */
  const refsOf = new Map(ast.body.map((n) => [n, []]));

  if (isCjs) return transformCjs();

  // ---- imports and re-exports -------------------------------------------
  const importBindings = new Map(); // local name -> { dep, imported }
  const exportsOut = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const dep = addDep(node.source.value, 'static');
      for (const spec of node.specifiers) {
        const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : keyName(spec.imported);
        importBindings.set(spec.local.name, { dep, imported });
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const dep = addDep(node.source.value, 'static');
      if (node.exported) exportsOut.push({ name: keyName(node.exported), kind: 'indirect', dep, imported: '*' });
      else exportsOut.push({ name: '*', kind: 'star', dep });
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      const dep = addDep(node.source.value, 'static');
      for (const spec of node.specifiers) exportsOut.push({ name: keyName(spec.exported), kind: 'indirect', dep, imported: keyName(spec.local) });
    }
  }
  const declared = (name) => moduleScope.declarations.has(name) && !importBindings.has(name);
  knownBinding = (name) => moduleScope.declarations.has(name) || importBindings.has(name);

  // ---- declarations of module-level bindings: relocated so they can be renamed
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (!decl) continue;
    for (const { ident, shorthand } of declarationIdents(decl)) {
      edits.push(localEdit(ident, shorthand ? 'shorthand' : 'plain'));
    }
  }

  // ---- references --------------------------------------------------------
  let current = null;
  let scope = moduleScope;
  const scopes = new Set();
  const ownerIsModule = (name) => {
    const owner = scope.find_owner(name);
    return owner === moduleScope || owner === null; // periscopic skips namespace specifiers
  };

  walk(ast, {
    enter(node, parent, key) {
      if (map.has(node)) {
        scope = map.get(node);
        scopes.add(scope);
      }
      if (parent === ast) current = node;
      if (node.type === 'ImportDeclaration') return this.skip();

      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          const dep = addDep(node.source.value, 'dynamic');
          edits.push({ start: node.start, end: node.end, text: `__dynamic(${dep})`, reloc: { kind: 'dynamic', name: '*', dep, form: 'plain' } });
          refsOf.get(current).push({ kind: 'import', dep, name: '*' });
          this.skip();
        } else {
          warnings.push(`${id}: dynamic import() with a non-literal specifier is left as native import()`);
        }
        return;
      }
      if (node.type === 'MetaProperty' && node.meta.name === 'import') {
        edits.push({ start: node.start, end: node.end, text: `({ url: ${JSON.stringify(`rowpack:${id}`)} })` });
        return;
      }
      if (node.type === 'AwaitExpression' && scope === moduleScope) throw new Error(`${id}: top-level await is not supported`);
      if (node.type !== 'Identifier' || !isReference(node, parent)) return;
      if (parent.type === 'ExportSpecifier') return;
      if (!ownerIsModule(node.name)) return;

      const shorthand = parent.type === 'Property' && parent.shorthand && key === 'value';
      const binding = importBindings.get(node.name);
      if (!binding) {
        if (!declared(node.name)) return; // a global
        refsOf.get(current).push({ kind: 'local', name: node.name });
        edits.push(localEdit(node, shorthand ? 'shorthand' : 'plain'));
        return;
      }

      const ns = importVar(binding.dep);
      let refName = binding.imported;
      let text;
      let form = 'plain';
      if (binding.imported === '*') {
        text = ns;
        if (parent.type === 'MemberExpression' && parent.object === node) {
          if (!parent.computed) refName = parent.property.name;
          else if (parent.property.type === 'Literal' && typeof parent.property.value === 'string') refName = parent.property.value;
        }
      } else {
        text = ns + prop(binding.imported);
        if ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'TaggedTemplateExpression' && parent.tag === node)) {
          text = `(0, ${text})`; // keep `this` undefined, as in ESM
          form = 'callee';
        }
      }
      if (shorthand) {
        text = `${node.name}: ${text}`;
        form = 'shorthand';
      }
      refsOf.get(current).push({ kind: 'import', dep: binding.dep, name: refName });
      edits.push({ start: node.start, end: node.end, text, reloc: { kind: 'import', name: binding.imported, dep: binding.dep, form, local: node.name } });
    },
    leave(node) {
      if (map.has(node)) scope = scope.parent ?? moduleScope;
    },
  });

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  // a declaring identifier can be seen both as a declaration and as a reference: keep one
  for (let i = edits.length - 1; i > 0; i--) if (edits[i].start === edits[i - 1].start) edits.splice(i, 1);

  // ---- statements ----------------------------------------------------------
  const statements = [];
  const seen = new Set();
  const push = (node, parts, pure, declares) => {
    const { code, relocations } = assemble(parts);
    const redeclares = declares.some((d) => seen.has(d));
    declares.forEach((d) => seen.add(d));
    const refs = dedupeRefs(refsOf.get(node)).filter((r) => !(r.kind === 'local' && declares.includes(r.name)));
    statements.push({ code, pure: pure && !redeclares, declares, refs, relocations });
  };
  const exportLocal = (name, local) => {
    const viaImport = importBindings.get(local);
    if (viaImport) exportsOut.push({ name, kind: 'indirect', dep: viaImport.dep, imported: viaImport.imported });
    else exportsOut.push({ name, kind: 'local', local });
  };
  const range = (start, end) => ({ range: [start, end] });
  const defaultRef = (form = 'plain') => ({ text: DEFAULT_LOCAL, reloc: { kind: 'local', name: DEFAULT_LOCAL, form } });

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') continue;
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) continue;
      if (!node.declaration) {
        for (const spec of node.specifiers) exportLocal(keyName(spec.exported), spec.local.name);
        continue;
      }
      const d = node.declaration;
      const names = declaredNames(d);
      for (const name of names) exportLocal(name, name);
      push(node, [range(d.start, d.end)], isPureDeclaration(d), names);
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
        exportLocal('default', d.id.name);
        push(node, [range(d.start, d.end)], isPureDeclaration(d), [d.id.name]);
      } else if (d.type === 'FunctionDeclaration') {
        // anonymous default function: hoisted, and named "default"
        const paren = source.indexOf('(', d.start);
        exportLocal('default', DEFAULT_LOCAL);
        push(node, [range(d.start, paren), { text: ' ' }, defaultRef(), range(paren, d.end),
          { text: '\nObject.defineProperty(' }, defaultRef(), { text: ', "name", { value: "default" });' }], true, [DEFAULT_LOCAL]);
      } else {
        exportLocal('default', DEFAULT_LOCAL);
        const anon = d.type === 'ClassDeclaration' || isAnonymousFn(d);
        const pure = d.type === 'ClassDeclaration' ? isPureClass(d) : isPureExpression(d);
        push(node, [{ text: 'const ' }, defaultRef(), { text: anon ? ' = { default: ' : ' = ' }, range(d.start, d.end), { text: anon ? ' }.default;' : ';' }], pure, [DEFAULT_LOCAL]);
      }
      continue;
    }
    push(node, [range(node.start, node.end)], isPureDeclaration(node), declaredNames(node));
  }

  return {
    format: 'esm',
    deps,
    exports: exportsOut,
    statements,
    warnings,
    // names the static linker must not reuse: globals read here, names declared in inner scopes
    globals: [...globals.keys()],
    innerNames: innerScopeNames(scopes, moduleScope),
  };

  // ---- helpers that need this module's state ---------------------------
  function localEdit(ident, form) {
    return { start: ident.start, end: ident.end, text: ident.name, reloc: { kind: 'local', name: ident.name, form } };
  }

  /** Build a statement's text from source ranges (with edits applied) and literal parts. */
  function assemble(parts) {
    let code = '';
    const relocations = [];
    const put = (text, reloc) => {
      if (reloc) relocations.push({ ...reloc, start: code.length, end: code.length + text.length });
      code += text;
    };
    for (const part of parts) {
      if (!part.range) {
        put(part.text, part.reloc);
        continue;
      }
      let [pos, end] = part.range;
      for (const e of editsIn(pos, end)) {
        code += source.slice(pos, e.start);
        put(e.text, e.reloc);
        pos = e.end;
      }
      code += source.slice(pos, end);
    }
    return { code, relocations };
  }

  function editsIn(start, end) {
    let lo = 0;
    let hi = edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edits[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < edits.length && edits[i].end <= end; i++) out.push(edits[i]);
    return out;
  }

  function transformCjs() {
    let scope = moduleScope;
    walk(ast, {
      enter(node) {
        if (map.has(node)) scope = map.get(node);
        if (
          node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
          scope.find_owner('require') === null && node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string'
        ) {
          const dep = addDep(node.arguments[0].value, 'require');
          edits.push({ start: node.arguments[0].start, end: node.arguments[0].end, text: String(dep) });
        }
      },
      leave(node) {
        if (map.has(node)) scope = scope.parent ?? moduleScope;
      },
    });
    edits.sort((a, b) => a.start - b.start);
    let code = '';
    let pos = 0;
    for (const e of edits) {
      code += source.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    code += source.slice(pos);
    return {
      format: 'cjs', deps, exports: [], warnings, globals: [], innerNames: [],
      statements: [{ code, pure: false, declares: [], refs: [], relocations: [] }],
    };
  }
}

function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((r) => {
    const k = `${r.kind}|${r.dep ?? ''}|${r.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Names declared in any scope below the module scope. */
function innerScopeNames(scopes, moduleScope) {
  const names = new Set();
  for (const scope of scopes) {
    if (scope === moduleScope) continue;
    for (const name of scope.declarations.keys()) names.add(name);
  }
  return [...names];
}

/** Identifier nodes that declare module-level bindings in a top-level statement. */
function declarationIdents(node) {
  const out = [];
  const fromPattern = (p, shorthand = false) => {
    switch (p?.type) {
      case 'Identifier': out.push({ ident: p, shorthand }); break;
      case 'ObjectPattern':
        for (const q of p.properties) {
          if (q.type === 'RestElement') fromPattern(q.argument);
          else fromPattern(q.value, q.shorthand && q.value.type === 'Identifier');
        }
        break;
      case 'ArrayPattern': for (const e of p.elements) if (e) fromPattern(e.type === 'RestElement' ? e.argument : e); break;
      case 'AssignmentPattern': fromPattern(p.left, shorthand); break;
      case 'RestElement': fromPattern(p.argument); break;
    }
  };
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) out.push({ ident: node.id, shorthand: false });
  else if (node.type === 'VariableDeclaration') for (const d of node.declarations) fromPattern(d.id);
  else {
    // var inside top-level blocks and loops declares module-level bindings too
    walk(node, {
      enter(n) {
        if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassBody') return this.skip();
        if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) fromPattern(d.id);
      },
    });
  }
  return out;
}

function declaredNames(node) {
  return declarationIdents(node).map((d) => d.ident.name);
}

// ---- purity: a statement is pure only if evaluating it cannot be observed ----
let knownBinding = () => false;

function isAnonymousFn(n) {
  return ((n.type === 'FunctionExpression' || n.type === 'ClassExpression') && !n.id) || n.type === 'ArrowFunctionExpression';
}

function isPureDeclaration(node) {
  switch (node.type) {
    case 'FunctionDeclaration': return true;
    case 'ClassDeclaration': return isPureClass(node);
    case 'VariableDeclaration':
      return node.declarations.every((d) => d.id.type === 'Identifier' && (!d.init || isPureExpression(d.init)));
    case 'EmptyStatement': return true;
    default: return false;
  }
}

function isPureClass(node) {
  if (node.superClass && !(node.superClass.type === 'Identifier' && (knownBinding(node.superClass.name) || KNOWN_GLOBALS.has(node.superClass.name)))) return false;
  return node.body.body.every((m) => {
    if (m.type === 'StaticBlock') return false;
    if (m.computed && !isPureExpression(m.key)) return false;
    if (m.type === 'PropertyDefinition' && m.static && m.value && !isPureExpression(m.value)) return false;
    return true;
  });
}

// Built-ins whose reads never throw and whose static properties are plain data.
// Same assumption esbuild and Rollup make: nobody replaced Math.max with a getter.
const KNOWN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'Object', 'Array', 'Function', 'String', 'Number', 'Boolean',
  'Symbol', 'BigInt', 'Math', 'JSON', 'Reflect', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'console',
]);
const EQUALITY = new Set(['===', '!==', '==', '!=']);

/**
 * @param {object} e  expression
 * @param {Set<string>} guarded  globals proven to exist by a `typeof x` test on the left of &&
 */
function isPureExpression(e, guarded = new Set()) {
  const pure = (x) => isPureExpression(x, guarded);
  switch (e.type) {
    case 'Identifier': return knownBinding(e.name) || KNOWN_GLOBALS.has(e.name) || guarded.has(e.name);
    case 'Literal':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'ClassExpression': return isPureClass(e);
    case 'TemplateLiteral': return e.expressions.length === 0;
    case 'ArrayExpression': return e.elements.every((x) => !x || (x.type !== 'SpreadElement' && pure(x)));
    case 'ObjectExpression':
      return e.properties.every((p) => p.type === 'Property' && !p.computed && p.kind === 'init' && pure(p.value));
    case 'UnaryExpression':
      if (e.operator === 'typeof' && e.argument.type === 'Identifier') return true; // typeof never throws
      return e.operator !== 'delete' && pure(e.argument);
    case 'MemberExpression': return !e.computed && isBuiltinPath(e);
    case 'LogicalExpression': {
      if (!pure(e.left)) return false;
      const g = new Set(guarded);
      if (e.operator === '&&') collectTypeofGuards(e.left, g);
      return isPureExpression(e.right, g);
    }
    case 'ConditionalExpression': {
      if (!pure(e.test)) return false;
      const g = new Set(guarded);
      collectTypeofGuards(e.test, g);
      return isPureExpression(e.consequent, g) && pure(e.alternate);
    }
    case 'BinaryExpression':
      return EQUALITY.has(e.operator) && pure(e.left) && pure(e.right) && (isTypeofOrLiteral(e.left) || isTypeofOrLiteral(e.right));
    default: return false;
  }
}

function isBuiltinPath(e) {
  if (e.type === 'Identifier') return KNOWN_GLOBALS.has(e.name) && !knownBinding(e.name);
  return e.type === 'MemberExpression' && !e.computed && isBuiltinPath(e.object);
}

const isTypeofOrLiteral = (x) => x.type === 'Literal' || (x.type === 'UnaryExpression' && x.operator === 'typeof');

/** `typeof self == 'object' && self ...` proves `self` exists on the right-hand side. */
function collectTypeofGuards(test, into) {
  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    collectTypeofGuards(test.left, into);
    collectTypeofGuards(test.right, into);
  } else if (test.type === 'BinaryExpression' && EQUALITY.has(test.operator)) {
    const t = [test.left, test.right].find((x) => x.type === 'UnaryExpression' && x.operator === 'typeof' && x.argument.type === 'Identifier');
    const other = t === test.left ? test.right : test.left;
    const negated = test.operator.startsWith('!');
    if (t && other.type === 'Literal' && (negated ? other.value === 'undefined' : other.value !== 'undefined')) into.add(t.argument.name);
  }
}
