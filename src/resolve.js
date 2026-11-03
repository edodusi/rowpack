/**
 * Module resolution: relative paths with the usual extension probing, and
 * bare specifiers through node_modules honouring package.json "exports",
 * then "module", then "main".
 */
import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs', '/index.json'];
const CONDITIONS = ['browser', 'import', 'module', 'default'];

const statCache = new Map();
const isFile = (p) => {
  let r = statCache.get(p);
  if (r === undefined) {
    r = fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
    statCache.set(p, r);
  }
  return r;
};

function probe(base) {
  for (const ext of EXTENSIONS) {
    if (isFile(base + ext)) return fs.realpathSync(base + ext);
  }
  return null;
}

function pickConditional(target) {
  if (typeof target === 'string' || target === null) return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = pickConditional(t);
      if (r) return r;
    }
    return null;
  }
  for (const key of Object.keys(target)) {
    if (CONDITIONS.includes(key)) {
      const r = pickConditional(target[key]);
      if (r) return r;
    }
  }
  return null;
}

function resolveExports(exportsField, subpath) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField) || !Object.keys(exportsField).some((k) => k.startsWith('.'))) {
    return subpath === '.' ? pickConditional(exportsField) : null;
  }
  if (subpath in exportsField) return pickConditional(exportsField[subpath]);
  for (const key of Object.keys(exportsField)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      const target = pickConditional(exportsField[key]);
      return target && target.replaceAll('*', subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined; // not exported
}

function resolveBare(specifier, fromDir) {
  const parts = specifier.split('/');
  const pkgName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = '.' + specifier.slice(pkgName.length);

  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', pkgName);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (isFile(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      if (pkg.exports !== undefined) {
        const target = resolveExports(pkg.exports, subpath);
        if (target) return probe(path.join(pkgDir, target));
        if (target === undefined && subpath !== '.') {
          // some packages forget assets in "exports"; fall through to the file system
          const direct = probe(path.join(pkgDir, subpath));
          if (direct) return direct;
        }
        return null;
      }
      if (subpath !== '.') return probe(path.join(pkgDir, subpath));
      const main = (typeof pkg.browser === 'string' && pkg.browser) || pkg.module || pkg.main || 'index.js';
      return probe(path.join(pkgDir, main));
    }
    if (dir === path.dirname(dir)) return null;
  }
}

const pkgCache = new Map();

/**
 * Does this file have side effects, according to the nearest package.json's
 * "sideEffects" field? (true unless the package says otherwise)
 */
export function hasSideEffects(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let pkg = pkgCache.get(dir);
    if (pkg === undefined) {
      const p = path.join(dir, 'package.json');
      pkg = isFile(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      pkgCache.set(dir, pkg);
    }
    if (pkg && 'sideEffects' in pkg) {
      const se = pkg.sideEffects;
      if (typeof se === 'boolean') return se;
      if (Array.isArray(se)) {
        const rel = path.relative(dir, file).split(path.sep).join('/');
        return se.some((g) => path.matchesGlob(rel, g.includes('/') ? g.replace(/^\.\//, '') : `**/${g}`));
      }
      return true;
    }
    if (pkg && pkg.name) return true; // a package root without the field
    if (dir === path.dirname(dir)) return true;
  }
}

/**
 * @param {string} specifier
 * @param {string} importer absolute path of the importing file
 * @returns {string|null} absolute real path
 */
const resolveCache = new Map();

export function resolve(specifier, importer) {
  if (specifier.startsWith('node:')) return null;
  const dir = path.dirname(importer);
  const key = `${dir}\0${specifier}`;
  let r = resolveCache.get(key);
  if (r === undefined) {
    r = specifier.startsWith('.') || specifier.startsWith('/') ? probe(path.resolve(dir, specifier)) : resolveBare(specifier, dir);
    resolveCache.set(key, r);
  }
  return r;
}

/** Forget cached file system lookups (between builds of a changing tree). */
export function clearResolveCache() {
  statCache.clear();
  resolveCache.clear();
  pkgCache.clear();
}
