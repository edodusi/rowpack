export function add(a, b) {
  return a + b;
}

// never imported: tree-shaking removes it
export function multiply(a, b) {
  return a * b;
}

export let calls = 0;
export function fibonacci(n) {
  calls++;
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
