const acorn = require('acorn');

/**
 * Parses ES6 module source code, extracts imports/exports,
 * and transforms the code into a linkable closure body.
 *
 * @param {string} source - Module source code
 * @param {string} modulePath - Path to the module
 * @returns {{
 *   code: string,
 *   imports: Array<{ symbol: string, localName: string, specifier: string }>,
 *   exports: Array<{ symbol: string, localName: string }>,
 *   dependencies: Array<string>
 * }}
 */
function parseAndTransformModule(source, modulePath) {
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      ranges: true
    });
  } catch (err) {
    throw new Error(`Failed to parse module "${modulePath}": ${err.message}`);
  }

  const imports = [];
  const exports = [];
  const dependenciesSet = new Set();

  // We will collect code replacements: { start, end, replacement }
  const replacements = [];
  const postAppendStatements = [];

  let tempVarCounter = 0;

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source.value;
      dependenciesSet.add(specifier);

      const tempVar = `__import_${++tempVarCounter}`;
      const bindings = [];

      for (const spec of node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          imports.push({
            symbol: 'default',
            localName: spec.local.name,
            specifier
          });
          bindings.push(`const ${spec.local.name} = (${tempVar} && ${tempVar}.default !== undefined) ? ${tempVar}.default : ${tempVar};`);
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          imports.push({
            symbol: '*',
            localName: spec.local.name,
            specifier
          });
          bindings.push(`const ${spec.local.name} = ${tempVar};`);
        } else if (spec.type === 'ImportSpecifier') {
          const importedName = spec.imported.name || spec.imported.value;
          imports.push({
            symbol: importedName,
            localName: spec.local.name,
            specifier
          });
          if (importedName === spec.local.name) {
            bindings.push(`const { ${importedName} } = ${tempVar};`);
          } else {
            bindings.push(`const { ${importedName}: ${spec.local.name} } = ${tempVar};`);
          }
        }
      }

      let replacement;
      if (node.specifiers.length === 0) {
        // Side-effect import: import './style.css';
        replacement = `__require(${JSON.stringify(specifier)});`;
      } else {
        replacement = `const ${tempVar} = __require(${JSON.stringify(specifier)});\n` + bindings.join('\n');
      }

      replacements.push({
        start: node.start,
        end: node.end,
        replacement
      });
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        // Re-export: export { a, b as c } from './other.js';
        const specifier = node.source.value;
        dependenciesSet.add(specifier);
        const tempVar = `__reexport_${++tempVarCounter}`;
        const reexportLines = [`const ${tempVar} = __require(${JSON.stringify(specifier)});`];

        for (const spec of node.specifiers) {
          const origName = spec.local.name || spec.local.value;
          const exportedName = spec.exported.name || spec.exported.value;
          exports.push({
            symbol: exportedName,
            localName: origName
          });
          reexportLines.push(`__exports.${exportedName} = ${tempVar}.${origName};`);
        }

        replacements.push({
          start: node.start,
          end: node.end,
          replacement: reexportLines.join('\n')
        });
      } else if (node.declaration) {
        // export const a = 1, b = 2; or export function f() {} or export class C {}
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          const name = decl.id.name;
          exports.push({
            symbol: name,
            localName: name
          });
          const declCode = source.slice(decl.start, decl.end);
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: declCode
          });
          postAppendStatements.push(`__exports.${name} = ${name};`);
        } else if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            extractBindings(declarator.id).forEach(name => {
              exports.push({
                symbol: name,
                localName: name
              });
              postAppendStatements.push(`__exports.${name} = ${name};`);
            });
          }
          const declCode = source.slice(decl.start, decl.end);
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: declCode
          });
        }
      } else if (node.specifiers && node.specifiers.length > 0) {
        // export { x, y as z };
        const exportLines = [];
        for (const spec of node.specifiers) {
          const localName = spec.local.name;
          const exportedName = spec.exported.name;
          exports.push({
            symbol: exportedName,
            localName: localName
          });
          exportLines.push(`__exports.${exportedName} = ${localName};`);
        }
        replacements.push({
          start: node.start,
          end: node.end,
          replacement: exportLines.join('\n')
        });
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      exports.push({
        symbol: 'default',
        localName: decl.id ? decl.id.name : 'default'
      });

      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        if (decl.id) {
          const name = decl.id.name;
          const declCode = source.slice(decl.start, decl.end);
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: declCode
          });
          postAppendStatements.push(`__exports.default = ${name};`);
        } else {
          // Anonymous function or class: export default function() {}
          const declCode = source.slice(decl.start, decl.end);
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: `__exports.default = ${declCode};`
          });
        }
      } else {
        // Expression: export default 42; or export default foo();
        const exprCode = source.slice(decl.start, decl.end);
        replacements.push({
          start: node.start,
          end: node.end,
          replacement: `__exports.default = ${exprCode};`
        });
      }
    } else if (node.type === 'ExportAllDeclaration') {
      // export * from './other.js';
      const specifier = node.source.value;
      dependenciesSet.add(specifier);
      const tempVar = `__exportAll_${++tempVarCounter}`;
      exports.push({
        symbol: '*',
        localName: '*'
      });
      replacements.push({
        start: node.start,
        end: node.end,
        replacement: `const ${tempVar} = __require(${JSON.stringify(specifier)});\nObject.assign(__exports, ${tempVar});`
      });
    }
  }

  // Sort replacements in reverse order of start position so modifying string doesn't invalidate offsets
  replacements.sort((a, b) => b.start - a.start);

  let transformedCode = source;
  for (const rep of replacements) {
    transformedCode =
      transformedCode.slice(0, rep.start) +
      rep.replacement +
      transformedCode.slice(rep.end);
  }

  if (postAppendStatements.length > 0) {
    transformedCode += '\n' + postAppendStatements.join('\n');
  }

  return {
    code: transformedCode,
    imports,
    exports,
    dependencies: Array.from(dependenciesSet)
  };
}

function extractBindings(pattern) {
  const names = [];
  if (!pattern) return names;
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'Property') {
        names.push(...extractBindings(prop.value));
      } else if (prop.type === 'RestElement') {
        names.push(...extractBindings(prop.argument));
      }
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const elem of pattern.elements) {
      if (elem) {
        if (elem.type === 'RestElement') {
          names.push(...extractBindings(elem.argument));
        } else {
          names.push(...extractBindings(elem));
        }
      }
    }
  }
  return names;
}

module.exports = {
  parseAndTransformModule
};
