// withUserParams (www/link-params.js): the parameters ECampus appends to links it opens for the user.
// Pure function — no DOM, no deps.   node tests/link-params.test.mjs
import assert from 'node:assert/strict';
import { withUserParams, STUDENT_ID_OFFSET } from '../www/link-params.js';

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } }

const ME = { student_id: '1', full_name: 'Mohit Mali', course: 'TYBAF', profile_img_url: 'https://i.ibb.co/0jDkVxfB/study-icon.png' };

t('full set (Mini Apps) looks exactly like the requested example', () => {
  assert.equal(
    withUserParams('https://app.example.com/', ME, { full: true, dark: true }),
    'https://app.example.com/?student_id=5490&name=Mohit%20Mali&course=TYBAF&dp_url=https://i.ibb.co/0jDkVxfB/study-icon.png&theme=dark'
  );
});

t('student_id is the numeric id + the offset (id 1 -> 5490); light theme by default', () => {
  assert.equal(STUDENT_ID_OFFSET, 5489);
  assert.match(withUserParams('https://a.test/', { student_id: '123' }), /student_id=5612&/);
  assert.match(withUserParams('https://a.test/', ME), /theme=light$/);
});

t('base set (other links) is student_id + name + theme only — no course / dp_url', () => {
  const u = withUserParams('https://a.test/x', ME, { dark: false });
  assert.equal(u, 'https://a.test/x?student_id=5490&name=Mohit%20Mali&theme=light');
});

t('params the profile does not have are left out, not sent empty', () => {
  assert.equal(withUserParams('https://a.test/', { student_id: 'abc', full_name: '' }, { full: true }), 'https://a.test/?theme=light');
  assert.equal(withUserParams('https://a.test/', null), 'https://a.test/?theme=light');
});

t('existing query params and path are kept; only our own keys are replaced', () => {
  const u = withUserParams('https://a.test/app/home?tab=fees&theme=old&student_id=9', ME, { full: true, dark: true });
  assert.equal(u, 'https://a.test/app/home?tab=fees&student_id=5490&name=Mohit%20Mali&course=TYBAF&dp_url=https://i.ibb.co/0jDkVxfB/study-icon.png&theme=dark');
});

t('values are encoded safely: & = # ? spaces and unicode cannot break out of their param', () => {
  const u = withUserParams('https://a.test/', { student_id: '1', full_name: 'A&B=C #1? ñ', course: 'B.Com (A&F)' }, { full: true });
  assert.match(u, /name=A%26B%3DC%20%231%3F%20%C3%B1&/);
  assert.match(u, /course=B\.Com%20\(A%26F\)&/);
  const parsed = new URL(u);
  assert.equal(parsed.searchParams.get('name'), 'A&B=C #1? ñ');     // a normal parser reads it back exactly
  assert.equal(parsed.searchParams.get('course'), 'B.Com (A&F)');
  assert.equal(parsed.hash, '');
});

t('a standard parser reads the dp_url value back whole (":" and "/" left readable are legal in a query)', () => {
  const parsed = new URL(withUserParams('https://a.test/', ME, { full: true }));
  assert.equal(parsed.searchParams.get('dp_url'), ME.profile_img_url);
  assert.equal(parsed.searchParams.get('name'), 'Mohit Mali');
});

t('an unparseable URL comes back unchanged', () => {
  assert.equal(withUserParams('not a url', ME), 'not a url');
});

console.log(`\n${passed} passed`);
