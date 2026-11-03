export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function fibonacci(n) {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
