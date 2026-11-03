import formatResult from '../formatter.js';
export { formatCurrency } from '../formatter.js';

export function renderHeader(title, subtitle) {
  return {
    titleText: formatResult('Title', title),
    subtitleText: formatResult('Subtitle', subtitle)
  };
}
