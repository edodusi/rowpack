export function formatCurrency(amount) {
  return '$' + Number(amount).toFixed(2);
}

export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function formatResult(label, value) {
  return `[${label}]: ${value}`;
}
