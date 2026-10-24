// Guard: the app must not open Supabase Realtime (WebSocket) channels.
//   node tests/no-realtime.test.mjs
//
// Realtime keeps one WebSocket open per signed-in user and adds Realtime log lines
// and "concurrent connection" usage on the Supabase dashboard. The app gets fresh
// data on launch, pull-to-refresh and foreground/online refreshes instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wwwDir = path.join(root, 'www');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'fonts' || e.name === 'vendor' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

console.log('no Realtime');

t('no www file opens a Realtime channel or listens to postgres_changes', () => {
  const offenders = [];
  for (const f of walk(wwwDir)) {
    const src = fs.readFileSync(f, 'utf8');
    if (/\.channel\s*\(|postgres_changes|removeChannel|\.realtime\b/.test(src)) offenders.push(path.relative(root, f));
  }
  assert.deepEqual(offenders, []);
});

t('no SQL script adds a table to the supabase_realtime publication', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(root, 'supabase')).filter((n) => n.endsWith('.sql'))) {
    const src = fs.readFileSync(path.join(root, 'supabase', f), 'utf8');
    if (/ALTER\s+PUBLICATION\s+supabase_realtime\s+(ADD|SET)\s+TABLE/i.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

t('disable_realtime.sql exists and drops tables from the publication', () => {
  const src = fs.readFileSync(path.join(root, 'supabase', 'disable_realtime.sql'), 'utf8');
  assert.match(src, /ALTER PUBLICATION supabase_realtime DROP TABLE/);
});

console.log(`\n${passed} passed`);
