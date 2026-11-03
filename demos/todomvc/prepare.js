#!/usr/bin/env node
/**
 * Fetch the TodoMVC Vanilla ES6 app used as the real-world test case.
 * It is GPL-3.0, so it is downloaded here instead of being vendored.
 *
 * Every bundler under test gets the same prepared source: the app's SCSS is
 * compiled to CSS once (bundling Sass is not what is being measured) and the
 * entry imports the CSS file instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sass from 'sass';

const REPO = 'https://github.com/tarhi-saad/TodoMVC-Vanilla-ES6.git';
const COMMIT = '96734497d6e3df1d9cf00f67b9787e300c9db0c9';
const dir = path.join(import.meta.dirname, 'app');

if (!fs.existsSync(path.join(dir, '.git'))) {
  execFileSync('git', ['clone', '--quiet', '--filter=blob:none', REPO, dir], { stdio: 'inherit' });
}
execFileSync('git', ['-C', dir, 'checkout', '--quiet', COMMIT], { stdio: 'inherit' });

const styles = path.join(dir, 'src', 'styles');
fs.writeFileSync(path.join(styles, 'main.css'), sass.compile(path.join(styles, 'main.scss'), { logger: sass.Logger.silent }).css);

const entry = path.join(dir, 'src', 'index.js');
const code = fs.readFileSync(entry, 'utf8');
fs.writeFileSync(entry, code.replace("import './styles/main.scss';", "import './styles/main.css';"));

console.log(`TodoMVC ready at ${path.relative(process.cwd(), entry)} (commit ${COMMIT.slice(0, 7)})`);
