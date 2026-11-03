export function unusedDeadFunction() {
  return 'This function is never imported or used. Strip/treeshake will purge it!';
}
