#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`rowpack: ${err.message}`);
  process.exit(1);
}
