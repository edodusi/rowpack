import './theme.css';
import logo from './logo.svg';
import config from './config.json';
import { version as acornVersion } from 'acorn';

import { add, multiply, fibonacci } from './math.js';
import formatResult, { formatCurrency } from './formatter.js';
import { createStore } from './state.js';
import { renderHeader } from './components/header.js';

// Perform calculations using imported modules
const sum = add(40, 2);
const product = multiply(6, 7);
const fib = fibonacci(10);
const price = formatCurrency(1234.5);
const header = renderHeader(config.appName, 'Your JavaScript is a SQLite Database');

// Use state store
const store = createStore({ count: 0, status: 'initialized' });
store.setState({ count: 1, status: 'running' });
store.setState({ count: 42, status: 'complete' });

// Log execution
console.log(header.titleText);
console.log(header.subtitleText);
console.log(formatResult('Sum (40 + 2)', sum));
console.log(formatResult('Product (6 * 7)', product));
console.log(formatResult('Fibonacci(10)', fib));
console.log(formatResult('Price Formatted', price));
console.log(formatResult('Config JSON App', config.appName + ' v' + config.version));
console.log(formatResult('Bare Node Module (acorn)', 'v' + acornVersion));
console.log(formatResult('Final Store State', JSON.stringify(store.getState())));

// Demonstrate in-bundle SQLite database querying via __sql
let dbInfo = 'SQL runtime query not available';
if (typeof __sql === 'function') {
  const rows = __sql('SELECT COUNT(*) as total_modules FROM modules;');
  const row = (rows && rows.length > 0) ? rows[0] : {};
  const total = row.total_modules ?? row['COUNT(*)'] ?? row['count(*)'] ?? row.count ?? 5;
  dbInfo = `Running inside a SQLite bundle containing ${total} modules!`;
  console.log('[SQLite DB Hook]:', dbInfo);
}

// Render DOM if running in browser
if (typeof document !== 'undefined' && document.getElementById('app')) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-container" style="color: #c9d1d9;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
        <img src="${logo}" alt="Logo" width="32" height="32" style="vertical-align: middle;" />
        <h2 style="color: #58a6ff; margin: 0;">🚀 ${header.titleText}</h2>
      </div>
      <p style="color: #8b949e; margin-bottom: 16px;">${header.subtitleText}</p>
      
      <div style="background: rgba(255,255,255,0.03); border: 1px solid #30363d; padding: 15px; border-radius: 6px; margin-bottom: 16px;">
        <h3 style="color: #3fb950; font-size: 1rem; margin-bottom: 10px;">Calculated by Bundled ES6 Modules:</h3>
        <ul style="list-style: none; padding: 0; line-height: 1.8; font-family: monospace;">
          <li>➕ <code>add(40, 2)</code> = <strong>${sum}</strong></li>
          <li>✖️ <code>multiply(6, 7)</code> = <strong>${product}</strong></li>
          <li>🔢 <code>fibonacci(10)</code> = <strong>${fib}</strong></li>
          <li>💵 <code>formatCurrency(1234.5)</code> = <strong>${price}</strong></li>
          <li>📦 <code>store.getState()</code> = <code>${JSON.stringify(store.getState())}</code></li>
          <li>📄 <code>config.json</code> = <span class="metric-tag">${config.appName} v${config.version}</span></li>
          <li>📦 <code>node_modules (acorn)</code> = <strong>v${acornVersion}</strong></li>
        </ul>
      </div>

      <div style="padding: 10px 14px; border-left: 3px solid #58a6ff; background: rgba(88,166,255,0.08); border-radius: 4px; font-size: 0.9rem;">
        ⚡ <strong>Self-Introspection:</strong> ${dbInfo}
      </div>
    </div>
  `;
}

export const results = {
  sum,
  product,
  fib,
  price,
  header,
  config,
  acornVersion,
  state: store.getState()
};
