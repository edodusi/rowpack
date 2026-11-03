// A small app that touches every feature: ESM with a live binding, JSON,
// CSS, an SVG, and an export nobody uses.
import { add, fibonacci, calls } from './math.js';
import config from './config.json' with { type: 'json' };
import './style.css';
import logo from './logo.svg';

const fib = fibonacci(10);
console.log(`> ${config.name}: add(40, 2) = ${add(40, 2)}, fibonacci(10) = ${fib} in ${calls} calls`);

if (typeof document !== 'undefined') {
  document.getElementById('root').innerHTML = `
    <main class="hello">
      <div class="logo">${logo}</div>
      <h1>${config.name}</h1>
      <p>add(40, 2) = ${add(40, 2)}, fibonacci(10) = ${fib}, computed in ${calls} calls.</p>
      <p>This page linked its modules by querying a SQLite database.</p>
    </main>`;
}
