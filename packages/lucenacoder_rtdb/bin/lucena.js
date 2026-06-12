#!/usr/bin/env node
import { main } from '../src/main.js';
main().catch((err) => {
  console.error('\n  ✖ ' + (err.message || err));
  process.exit(1);
});
