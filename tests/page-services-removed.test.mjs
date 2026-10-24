// Page Services (profile service cards, add/edit sheet, icon picker, All Services screen, Search "Services" tab)
// was removed in 2.10. Guards against it creeping back in, and against the removal taking the shared in-app
// link opener (window.openServiceLink) with it.   node tests/page-services-removed.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('www/index.html'), main = read('www/main.js'), search = read('www/search.js'), bafs = read('www/bafs.js');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }

const GONE = /page_services|fetchPageServices|AllServicesModal|ManageServiceModal|ServiceIconPicker|saveService|deleteService|selectServiceIcon|SERVICE_ICONS|renderServiceList|renderViewServicesList|profile-services|services-view-all|modal-view-services|modal-manage-service|modal-service-icon-picker/;

t('no Page Services markup or code left in index.html / main.js / search.js', () => {
  for (const [name, src] of [['index.html', html], ['main.js', main], ['search.js', search]]) {
    assert.ok(!GONE.test(src), `${name} still references Page Services: ${(src.match(GONE) || [])[0]}`);
  }
});

t('Search has no Services tab and no Services results; the box says students or pages', () => {
  assert.ok(!/data-tab="services"/.test(html));
  assert.deepEqual([...html.matchAll(/data-tab="(all|users|pages|services)"/g)].map((m) => m[1]), ['all', 'users', 'pages']);
  assert.ok(!/currentSearchTab === 'services'/.test(search));
  assert.ok(/placeholder="Search students or pages\.\.\."/.test(html));
});

t('the back router no longer lists the removed modals', () => {
  assert.ok(!/modal-view-services|modal-manage-service|modal-service-icon-picker/.test(main));
});

t('window.openServiceLink (the app-wide in-app link opener) is still there and still used', () => {
  assert.ok(/window\.openServiceLink = async function/.test(main));
  assert.ok(/window\.openServiceLink/.test(html), 'Help / Privacy / Terms links');
  assert.ok(/openServiceLink/.test(bafs), 'BAFs study material links');
});

console.log(`\n${passed} passed`);
