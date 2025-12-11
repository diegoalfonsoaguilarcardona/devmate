#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);
const old = pkg.version || '0.0.0';
const parts = old.split('.').map(n => parseInt(n, 10));
if (parts.length !== 3 || parts.some(n => Number.isNaN(n) || n < 0)) {
  parts[0] = 0; parts[1] = 0; parts[2] = 0;
}
parts[2] += 1;
const next = `${parts[0]}.${parts[1]}.${parts[2]}`;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[devmate] Version bumped: ${old} -> ${next}`);