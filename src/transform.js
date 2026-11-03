/**
 * Turns one JavaScript module into rows: statements, bindings, references,
 * exports and dependencies. Nothing here touches SQLite; the bundler inserts
 * the result and SQL does the linking.
 *
 * ESM is rewritten so imports become live reads from the dependency's
 * namespace object (`__rp_i0.name`), which gives real live bindings, cycles
 * and TDZ errors without copying values.
 */
import { Parser } from 'acorn';
import { walk } from 'estree-walker';
import isReference from 'is-reference';
import { analyze } from 'periscopic';
import MagicString from 'magic-string';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (name) => (IDENT.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);
const keyName = (node) => (node.type === 'Identifier' ? node.name : String(node.value));
export const importVar = (idx) => `__rp_i${idx}`;
export const DEFAULT_LOCAL = '__rp_default';

/** @typedef {{ code: string, pure: boolean, declares: string[], refs: Array<{kind:'local'|'import', name:string, dep?:number}> }} Statement */

/**
 * @param {string} source
 * @param {string} id  module path, used in error messages
 * @returns {{
 *   format: 'esm'|'cjs',
 *   deps: Array<{specifier: string, kind: 'static'|'dynamic'|'require'}>,
 *   exports: Array<{name: string, kind: 'local'|'indirect'|'star', local?: string, dep?: number, imported?: string}>,
 *   statements: Statement[],
 *   warnings: string[],
 * }}
 */
export function transformModule(source, id) {
  let ast;
  try {
    ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (err) {
    throw new Error(`${id}: ${err.message}`);
  }

  for (const node of ast.body) node.__refs = [];
  const isEsm = ast.body.some((n) => n.type === 'ImportDeclaration' || n.type.startsWith('Export'));
  const { map, scope: moduleScope, globals } = analyze(ast);
  const isCjs = !isEsm && (globals.has('module') || globals.has('exports') || globals.has('require'));

  const s = new MagicString(source);
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

  if (isCjs) return transformCjs(ast, source, s, map, moduleScope, addDep, deps, warnings, id);

  // ---- pass 1: imports and exports -------------------------------------
  /** local name -> { dep, imported } */
  const importBindings = new Map();
  const exportsOut = [];

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const dep = addDep(node.source.value, 'static');
      for (const spec of node.specifiers) {
        const imported =
          spec.type === 'ImportDefaultSpecifier' ? 'default'
            : spec.type === 'ImportNamespaceSpecifier' ? '*'
              : keyName(spec.imported);
        importBindings.set(spec.local.name, { dep, imported });
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const dep = addDep(node.source.value, 'static');
      if (node.exported) exportsOut.push({ name: keyName(node.exported), kind: 'indirect', dep, imported: '*' });
      else exportsOut.push({ name: '*', kind: 'star', dep });
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      const dep = addDep(node.source.value, 'static');
      for (const spec of node.specifiers) {
        exportsOut.push({ name: keyName(spec.exported), kind: 'indirect', dep, imported: keyName(spec.local) });
      }
    }
  }

  const exportLocal = (name, local) => {
    const viaImport = importBindings.get(local);
    if (viaImport) exportsOut.push({ name, kind: 'indirect', dep: viaImport.dep, imported: viaImport.imported });
    else exportsOut.push({ name, kind: 'local', local });
  };

  // ---- pass 2: rewrite references to imports ---------------------------
  // Also records, per top-level statement, which bindings it reads.
  let current = null; // statement being walked
  let scope = moduleScope;
  // periscopic does not record namespace import specifiers, so "no owner" also means module scope
  const ownerIsModule = (name) => {
    const owner = scope.find_owner(name);
    return owner === moduleScope || owner === null;
  };

  walk(ast, {
    enter(node, parent, key) {
      if (map.has(node)) scope = map.get(node);
      if (parent === ast) current = node;

      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          const dep = addDep(node.source.value, 'dynamic');
          s.overwrite(node.start, node.end, `__dynamic(${dep})`);
          current.__refs.push({ kind: 'import', dep, name: '*' });
          this.skip();
        } else {
          warnings.push(`${id}: dynamic import() with a non-literal specifier is left as native import()`);
        }
        return;
      }
      if (node.type === 'MetaProperty' && node.meta.name === 'import') {
        s.overwrite(node.start, node.end, `({ url: ${JSON.stringify(`rowpack:${id}`)} })`);
        return;
      }
      if (node.type === 'AwaitExpression' && scope === moduleScope) {
        throw new Error(`${id}: top-level await is not supported`);
      }
      if (node.type !== 'Identifier' || !isReference(node, parent)) return;
      // export { a as b } specifiers are handled by the export pass, not rewritten
      if (parent.type === 'ExportSpecifier') return;
      if (!ownerIsModule(node.name)) return;

      const binding = importBindings.get(node.name);
      if (!binding) {
        current.__refs?.push({ kind: 'local', name: node.name });
        return;
      }

      const ns = importVar(binding.dep);
      let replacement;
      let refName = binding.imported;
      if (binding.imported === '*') {
        replacement = ns;
        // ns.foo with a static key only needs foo; anything else needs everything
        if (parent.type === 'MemberExpression' && parent.object === node) {
          if (!parent.computed) refName = parent.property.name;
          else if (parent.property.type === 'Literal' && typeof parent.property.value === 'string') refName = parent.property.value;
        }
      } else {
        replacement = ns + prop(binding.imported);
        const isCallee =
          (parent.type === 'CallExpression' && parent.callee === node) ||
          (parent.type === 'TaggedTemplateExpression' && parent.tag === node);
        if (isCallee) replacement = `(0, ${replacement})`; // keep `this` undefined, as in ESM
      }
      current.__refs?.push({ kind: 'import', dep: binding.dep, name: refName });

      if (parent.type === 'Property' && parent.shorthand && key === 'value') {
        s.overwrite(parent.start, parent.end, `${node.name}: ${replacement}`);
      } else {
        s.overwrite(node.start, node.end, replacement);
      }
    },
    leave(node) {
      if (map.has(node)) scope = scope.parent ?? moduleScope;
    },
  });

  // ---- pass 3: statements ---------------------------------------------
  return { format: 'esm', deps, exports: exportsOut, statements: collectStatements(), warnings };

  function collectStatements() {
    const out = [];
    const seen = new Set();
    const known = (name) => moduleScope.declarations.has(name) || importBindings.has(name) || name === 'undefined';
    knownBinding = known;
    // a statement that redeclares a binding is never removable
    const push = (code, pure, declares, refs) => {
      const redeclares = declares.some((d) => seen.has(d));
      declares.forEach((d) => seen.add(d));
      out.push(stmt(code, pure && !redeclares, declares, refs));
    };
    for (const node of ast.body) {
      const refs = dedupeRefs(node.__refs || []);
      if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') continue;
      if (node.type === 'ExportNamedDeclaration') {
        if (node.source) continue;
        if (!node.declaration) {
          for (const spec of node.specifiers) exportLocal(keyName(spec.exported), spec.local.name);
          continue;
        }
        const decl = node.declaration;
        const declares = declaredNames(decl);
        for (const name of declares) exportLocal(name, name);
        push(s.slice(decl.start, decl.end), isPureDeclaration(decl), declares, refs);
        continue;
      }
      if (node.type === 'ExportDefaultDeclaration') {
        const decl = node.declaration;
        const body = s.slice(decl.start, decl.end);
        if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
          exportLocal('default', decl.id.name);
          push(body, isPureDeclaration(decl), [decl.id.name], refs);
        } else if (decl.type === 'FunctionDeclaration') {
          // anonymous default function: hoisted, and its name is "default"
          const named = body.replace(/^(async\s+)?function\s*(\*?)\s*/, `$1function $2${DEFAULT_LOCAL}`);
          exportLocal('default', DEFAULT_LOCAL);
          push(`${named}\nObject.defineProperty(${DEFAULT_LOCAL}, "name", { value: "default" });`, true, [DEFAULT_LOCAL], refs);
        } else if (decl.type === 'ClassDeclaration') {
          exportLocal('default', DEFAULT_LOCAL);
          push(`const ${DEFAULT_LOCAL} = { default: ${body} }.default;`, isPureClass(decl), [DEFAULT_LOCAL], refs);
        } else {
          exportLocal('default', DEFAULT_LOCAL);
          const named = isAnonymousFn(decl) ? `{ default: ${body} }.default` : body;
          push(`const ${DEFAULT_LOCAL} = ${named};`, isPureExpression(decl), [DEFAULT_LOCAL], refs);
        }
        continue;
      }
      const code = s.slice(node.start, node.end);
      push(code, isPureDeclaration(node), declaredNames(node), refs);
    }
    return out;
  }
}

function stmt(code, pure, declares, refs) {
  return { code, pure, declares, refs: refs.filter((r) => !(r.kind === 'local' && declares.includes(r.name))) };
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

function declaredNames(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return node.id ? [node.id.name] : [];
  if (node.type === 'VariableDeclaration') return node.declarations.flatMap((d) => patternNames(d.id));
  // var declarations nested in top-level blocks or loops belong to module scope
  const names = [];
  walk(node, {
    enter(n) {
      if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassBody') return this.skip();
      if (n.type === 'VariableDeclaration' && n.kind === 'var') names.push(...n.declarations.flatMap((d) => patternNames(d.id)));
    },
  });
  return names;
}

function patternNames(p) {
  switch (p?.type) {
    case 'Identifier': return [p.name];
    case 'ObjectPattern': return p.properties.flatMap((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value));
    case 'ArrayPattern': return p.elements.flatMap((e) => (e ? patternNames(e.type === 'RestElement' ? e.argument : e) : []));
    case 'AssignmentPattern': return patternNames(p.left);
    case 'RestElement': return patternNames(p.argument);
    default: return [];
  }
}

// ---- purity: conservative, a statement is pure only if evaluating it cannot be observed
function isAnonymousFn(n) {
  return (n.type === 'FunctionExpression' || n.type === 'ClassExpression') && !n.id || n.type === 'ArrowFunctionExpression';
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
  if (node.superClass && !(node.superClass.type === 'Identifier' && knownBinding(node.superClass.name))) return false;
  return node.body.body.every((m) => {
    if (m.type === 'StaticBlock') return false;
    if (m.computed && !isPureExpression(m.key)) return false;
    if (m.type === 'PropertyDefinition' && m.static && m.value && !isPureExpression(m.value)) return false;
    return true;
  });
}

let knownBinding = () => false;

function isPureExpression(e) {
  switch (e.type) {
    case 'Identifier': return knownBinding(e.name); // reading an unknown global can throw
    case 'Literal':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'ClassExpression': return isPureClass(e);
    case 'TemplateLiteral': return e.expressions.every(isPureExpression) && e.expressions.length === 0;
    case 'ArrayExpression': return e.elements.every((x) => !x || (x.type !== 'SpreadElement' && isPureExpression(x)));
    case 'ObjectExpression':
      return e.properties.every((p) => p.type === 'Property' && !p.computed && p.kind === 'init' && isPureExpression(p.value));
    case 'UnaryExpression': return e.operator !== 'delete' && isPureExpression(e.argument);
    default: return false;
  }
}

// ---- CommonJS: one opaque, impure statement; require('x') becomes require(n)
function transformCjs(ast, source, s, map, moduleScope, addDep, deps, warnings, id) {
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
        s.overwrite(node.arguments[0].start, node.arguments[0].end, String(dep));
      }
    },
    leave(node) {
      if (map.has(node)) scope = scope.parent ?? moduleScope;
    },
  });
  return {
    format: 'cjs',
    deps,
    exports: [],
    statements: [{ code: s.toString(), pure: false, declares: [], refs: [] }],
    warnings,
  };
}
