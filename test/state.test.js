const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/state');

const SV = 'aaaaaaaa', TV = 'bbbbbbbb', id = (s, p) => `${s}:/sites/${p}`;
const SERVER = (s, sites, skipped = []) => JSON.stringify({ server: s, sites: sites.map(p => `/sites/${p}`), skipped: skipped.map(p => `/sites/${p}`) });
const P = { name: 'woocommerce', status: 'active', version: '11.2.0', update_version: '11.2.1' };
const SITE = (s, p, x = {}) => JSON.stringify({ site: id(s, p), url: `https://${p}.test`, db: { name: `db_${p}`, host: 'localhost', prefix: 'wp_' },
  wp: '6.8.1', exclude: [], core: [], plugins: [], themes: [], ...x });

const LIST = SERVER(SV, ['a', 'b', 'c']);
const [A_ID, B_ID, C_ID] = ['a', 'b', 'c'].map(p => id(SV, p));
const A = SITE(SV, 'a', { exclude: ['elementor', 'elementor-pro'],
  plugins: [P, { name: 'elementor-pro', status: 'active', version: '4.0.1', update_version: '4.3.2' }],
  themes: [{ name: 'astra', status: 'inactive', version: '4.14.0', update_version: '4.14.1' }] });
const B = SITE(SV, 'b', { exclude: ['elementor', 'elementor-pro'],
  plugins: [{ name: 'elementor-pro', status: 'active', version: '4.0.1', update_version: '4.3.2' }] });
const C = SITE(SV, 'c', { plugins: [{ name: 'hostinger', status: 'active', version: '3.0.76', update_version: '3.0.80' }] });

test('listing: pending, excluded and up to date', () => {
  const e = S.newState();
  S.listingLine(e, LIST, 1); assert.equal(e.sites[C_ID].status, 'checking'); assert.equal(e.listing, true);
  S.listingLine(e, `===== [1/3] ${A_ID}`, 2); S.listingLine(e, A, 3); S.listingLine(e, B, 4);
  S.listingLine(e, JSON.stringify({ site: C_ID, error: 'ssh failed' }), 5);
  assert.equal(e.sites[A_ID].status, 'pending');
  assert.equal(e.sites[A_ID].url, 'https://a.test');
  assert.deepEqual(e.sites[A_ID].pending.map(i => [i.type, i.name, i.active]), [['plugin','woocommerce',true], ['theme','astra',false]]);
  assert.deepEqual(e.sites[A_ID].skipped.map(i => i.name), ['elementor-pro']);
  assert.equal(e.sites[B_ID].status, 'up-to-date');
  assert.equal(e.sites[C_ID].status, 'error'); assert.equal(e.sites[C_ID].reason, 'ssh failed');
});

test('listing: pending core uses the current wp version', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, SITE(SV, 'a', { wp: '7.1.3', core: [{ version: '7.1.4', update_type: 'minor' }] }), 2);
  assert.deepEqual(e.sites[A_ID].pending, [{ type:'core', name:'WordPress', active:true, current:'7.1.3', next:'7.1.4' }]);
});

// wp core check-update lists the minor update of the site's branch first, but wp core update installs the highest
test('listing: pending core is the highest version offered, the one wp core update installs', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, SITE(SV, 'a', { wp: '6.5.5', core: [{ version: '6.5.13', update_type: 'minor' }, { version: '7.1.3', update_type: 'major' }] }), 2);
  assert.equal(e.sites[A_ID].pending[0].next, '7.1.3');
});

test('listing: keeps the WordPress version of each site', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2);
  assert.equal(e.sites[A_ID].wp, '6.8.1');
});

// WP-CLI marks an update "unavailable" when the new version needs a newer WordPress or PHP; wp plugin update skips it
const CF7 = { name: 'contact-form-7', status: 'inactive', update: 'unavailable', version: '5.9', update_version: '6.2.3', requires: '7.1', requires_php: '8.3' };
test("listing: updates the server can't apply aren't pending and say what they need", () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, SITE(SV, 'a', { wp: '7.1.3',
    plugins: [{ ...P, update: 'available' }, CF7, { name: 'akismet', status: 'active', update: 'none', version: '5.5', update_version: '' }],
    themes: [{ name: 'astra', status: 'active', update: 'unavailable', version: '4.0', update_version: '5.0', requires: '7.2', requires_php: '7.4' }] }), 2);
  const s = e.sites[A_ID];
  assert.deepEqual(s.pending.map(i => i.name), ['woocommerce']);
  assert.deepEqual(s.unavailable, [
    { type: 'plugin', name: 'contact-form-7', current: '5.9', next: '6.2.3', needs: 'PHP 8.3' },
    { type: 'theme', name: 'astra', current: '4.0', next: '5.0', needs: 'WordPress 7.2' }]);
  assert.equal(s.status, 'pending');
});

test("listing: a site whose only updates can't be applied is up to date", () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, SITE(SV, 'a', { wp: '7.1.3', plugins: [CF7] }), 2);
  assert.equal(e.sites[A_ID].status, 'up-to-date');
  assert.equal(e.sites[A_ID].unavailable.length, 1);
});

test('listing: a site that fails to list forgets the updates it could not apply', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, SITE(SV, 'a', { wp: '7.1.3', plugins: [CF7] }), 2);
  S.listingLine(e, JSON.stringify({ site: A_ID, error: 'ssh failed' }), 3);
  assert.deepEqual(e.sites[A_ID].unavailable, []);
});

test('endListing: whatever did not answer becomes an error', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 9);
  assert.equal(e.listing, false); assert.equal(e.checked, 9);
  assert.equal(e.sites[B_ID].status, 'error'); assert.equal(e.sites[B_ID].reason, 'no response');
});

test('run: progress, result, review and END', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, [A_ID, C_ID], 10);
  assert.equal(e.sites[C_ID].status, 'queued'); assert.equal(e.run.active, true);
  for (const l of [`===== [1/2] ${A_ID}`, `== ${A_ID}: database backup`, `== ${A_ID}: updating`,
    'Downloading update from https://downloads.wordpress.org/plugin/woocommerce.11.2.1.zip...']) S.runLine(e, l, 20);
  const a = e.sites[A_ID];
  assert.equal(a.status, 'updating'); assert.equal(a.downloading, 'woocommerce'); assert.ok(a.progress > 0 && a.progress < 1);
  assert.equal(e.run.current, A_ID); assert.equal(e.run.n, 1);
  for (const l of ['woocommerce\t11.2.0\t11.2.1\tUpdated', `== ${A_ID}: OK`, `===== [2/2] ${C_ID}`,
    `== ${C_ID}: site responds 500, check it`, 'END code=1']) S.runLine(e, l, 30);
  assert.equal(a.status, 'done'); assert.equal(a.progress, 1);
  assert.deepEqual(a.result, [{ type:'plugin', name:'woocommerce', before:'11.2.0', after:'11.2.1' }]);
  assert.equal(e.sites[C_ID].status, 'review'); assert.equal(e.sites[C_ID].reason, 'site responds 500, check it');
  assert.equal(e.run.code, 1); assert.equal(e.run.active, false); assert.equal(e.run.durations.length, 1);
});

test('the listing afterwards keeps result and review', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, [A_ID, C_ID], 10);
  for (const l of [`===== [1/2] ${A_ID}`, 'woocommerce\t11.2.0\t11.2.1\tUpdated', `== ${A_ID}: OK`,
    `===== [2/2] ${C_ID}`, `== ${C_ID}: update failed`, 'END code=1']) S.runLine(e, l, 20);
  S.listingLine(e, LIST, 30); S.listingLine(e, A, 31); S.listingLine(e, SITE(SV, 'c'), 32); S.endListing(e, 33);
  assert.equal(e.sites[A_ID].result.length, 1);
  assert.equal(e.sites[C_ID].status, 'review'); assert.equal(e.sites[C_ID].reason, 'update failed');
  S.startRun(e, [C_ID], 40);
  assert.equal(e.sites[C_ID].reason, null); assert.equal(e.sites[A_ID].result.length, 1);
});

test('an OK after "update failed" does not hide the error', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, [A_ID], 10);
  for (const l of [`===== [1/1] ${A_ID}`, `== ${A_ID}: updating`, `== ${A_ID}: update failed`, `== ${A_ID}: OK`, 'END code=1'])
    S.runLine(e, l, 20);
  assert.equal(e.sites[A_ID].status, 'review'); assert.equal(e.sites[A_ID].reason, 'update failed');
});

test('startRun creates sites it does not know', () => {
  const e = S.newState(); S.startRun(e, [id(SV, 'z')], 1);
  assert.equal(e.sites[id(SV, 'z')].status, 'queued'); assert.equal(e.sites[id(SV, 'z')].path, '/sites/z');
});

test('garbage in the output breaks nothing', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  for (const l of ['PHP: 2026-10-21 [notice] Implicitly marking parameter $key as nullable', '{"site":"aaaa', '', 'name\tstatus\tversion\tupdate_version'])
    { S.listingLine(e, l, 2); S.runLine(e, l, 2); }
  assert.equal(e.sites[A_ID].status, 'checking');
});

test('the log keeps only the last 500 lines', () => {
  const e = S.newState(); for (let i = 0; i < 600; i++) S.runLine(e, 'x' + i, 1);
  assert.equal(e.log.length, 500); assert.equal(e.log[0], 'x100');
});

test('a listing that fails silently does not leave the old lists as current', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.listingLine(e, B, 2); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startListing(e);
  assert.equal(e.listing, true); assert.equal(e.sites[A_ID].status, 'checking');
  S.listingLine(e, JSON.stringify({ site: C_ID, error: 'ssh failed' }), 4);
  S.endListing(e, 9, 255);
  assert.equal(e.checked, 3);   // doesn't say "checked just now" if it failed
  assert.equal(e.sites[A_ID].status, 'error'); assert.deepEqual(e.sites[A_ID].pending, []);
  assert.deepEqual(e.sites[C_ID].pending, []);
});

test('END halfway through a site: it goes to review, the queued ones go back and done counts only the good ones', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startRun(e, [A_ID, C_ID], 10);
  for (const l of [`===== [1/2] ${A_ID}`, `== ${A_ID}: database backup`, 'END code=255']) S.runLine(e, l, 20);
  assert.equal(e.sites[A_ID].status, 'review'); assert.equal(e.sites[A_ID].reason, 'the update stopped halfway');
  assert.equal(e.sites[C_ID].status, 'pending');
  assert.deepEqual(e.run.done, []); assert.equal(e.run.code, 255);
  S.startRun(e, [C_ID], 30);
  for (const l of [`===== [1/1] ${C_ID}`, `== ${C_ID}: OK`, 'END code=0']) S.runLine(e, l, 40);
  assert.deepEqual(e.run.done, [C_ID]);
});

test('"Check for updates" by hand clears review; the automatic listing does not', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startRun(e, [C_ID], 10);
  for (const l of [`===== [1/1] ${C_ID}`, `== ${C_ID}: site responds 500, check it`, 'END code=1']) S.runLine(e, l, 20);
  S.startListing(e);
  assert.equal(e.sites[C_ID].status, 'review');
  S.startListing(e, { clearReview: true });
  assert.equal(e.sites[C_ID].status, 'checking'); assert.equal(e.sites[C_ID].reason, null);
  S.listingLine(e, LIST, 30); S.listingLine(e, C, 31);
  assert.equal(e.sites[C_ID].status, 'pending');
});

// ---- Several servers, excluded sites and duplicates ----

test("server line replaces only that server's sites; skipped ones are excluded", () => {   // Review Focus 5
  const e = S.newState();
  S.listingLine(e, SERVER(SV, ['a', 'b', 'old'], ['old']), 1); S.listingLine(e, SERVER(TV, ['x']), 1);
  assert.equal(e.sites[id(SV, 'old')].status, 'excluded'); assert.equal(e.sites[id(SV, 'a')].status, 'checking');
  assert.equal(e.sites[id(SV, 'a')].path, '/sites/a'); assert.equal(e.sites[id(SV, 'a')].server, SV);
  S.listingLine(e, SERVER(SV, ['a']), 2);
  assert.deepEqual(Object.keys(e.sites).sort(), [id(SV, 'a'), id(TV, 'x')]);
  S.listingLine(e, SERVER(TV, []), 3);
  assert.deepEqual(Object.keys(e.sites), [id(SV, 'a')]);
});

test('startListing drops sites of servers that were removed', () => {
  const e = S.newState(); S.listingLine(e, SERVER(SV, ['a']), 1); S.listingLine(e, SERVER(TV, ['x']), 1);
  S.startListing(e, { servers: [SV] });
  assert.deepEqual(Object.keys(e.sites), [id(SV, 'a')]);
});

test('shared database or address → duplicate; same DB with another prefix is fine; excluding the copy clears it', () => {
  const e = S.newState();
  const copyDb = { db: { name: 'db_live', host: 'localhost', prefix: 'wp_' }, url: 'https://copy.test' };
  const other = SITE(SV, 'other', { db: { name: 'db_live', host: 'localhost', prefix: 'wp2_' } });
  S.listingLine(e, SERVER(SV, ['live', 'copy', 'other']), 1);
  S.listingLine(e, SITE(SV, 'live', { plugins: [P] }), 2); S.listingLine(e, SITE(SV, 'copy', copyDb), 2); S.listingLine(e, other, 2);
  S.endListing(e, 3);
  assert.equal(e.sites[id(SV, 'live')].status, 'duplicate'); assert.match(e.sites[id(SV, 'live')].reason, /copy\.test/);
  assert.equal(e.sites[id(SV, 'copy')].status, 'duplicate');
  assert.equal(e.sites[id(SV, 'other')].status, 'up-to-date');
  S.startListing(e); S.listingLine(e, SERVER(SV, ['live', 'copy', 'other'], ['copy']), 4);
  S.listingLine(e, SITE(SV, 'live', { plugins: [P] }), 5); S.listingLine(e, other, 5); S.endListing(e, 6);
  assert.equal(e.sites[id(SV, 'live')].status, 'pending');
});

test('same address on two servers → duplicate', () => {
  const e = S.newState(); S.listingLine(e, SERVER(SV, ['a']), 1); S.listingLine(e, SERVER(TV, ['a']), 1);
  S.listingLine(e, SITE(SV, 'a'), 2); S.listingLine(e, SITE(TV, 'a', { db: { name: 'other', host: 'localhost', prefix: 'wp_' } }), 2);
  assert.equal(e.sites[id(TV, 'a')].status, 'duplicate'); assert.match(e.sites[id(TV, 'a')].reason, /Same address/);
});

test('a run across two servers counts sites in order and tracks the file copy step', () => {
  const e = S.newState(); S.listingLine(e, SERVER(SV, ['a']), 1); S.listingLine(e, SERVER(TV, ['x']), 1);
  S.listingLine(e, SITE(SV, 'a', { plugins: [P] }), 2); S.listingLine(e, SITE(TV, 'x', { plugins: [P] }), 2); S.endListing(e, 3);
  S.startRun(e, [id(SV, 'a'), id(TV, 'x')], 10);
  for (const l of [`===== [1/1] ${id(SV, 'a')}`, `== ${id(SV, 'a')}: database backup`, `== ${id(SV, 'a')}: copying files`]) S.runLine(e, l, 20);
  assert.equal(e.sites[id(SV, 'a')].step, 'files');
  for (const l of [`== ${id(SV, 'a')}: OK`, `===== [1/1] ${id(TV, 'x')}`]) S.runLine(e, l, 30);
  assert.equal(e.run.n, 2);
  for (const l of [`== ${id(TV, 'x')}: file copy failed, not updated`, 'END code=1']) S.runLine(e, l, 40);
  assert.equal(e.sites[id(TV, 'x')].status, 'review'); assert.equal(e.sites[id(TV, 'x')].reason, 'file copy failed, not updated');
  assert.equal(e.sites[id(SV, 'a')].status, 'done'); assert.equal(e.run.active, false);
});

// ---- Full backups ----

const listed = () => { const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.listingLine(e, C, 2); S.endListing(e, 3); return e; };

test('a backup run never changes the update status of its sites', () => {
  const e = listed();
  const pending = structuredClone(e.sites[A_ID].pending);
  S.startRun(e, [A_ID], 10, 'backup');
  assert.equal(e.run.kind, 'backup');
  assert.deepEqual(e.sites[A_ID].backup, { status: 'queued', step: null, reason: null });
  assert.equal(e.sites[A_ID].status, 'pending');
  S.runLine(e, `===== [1/1] ${A_ID}`, 20);
  assert.equal(e.sites[A_ID].backup.status, 'copying'); assert.equal(e.sites[A_ID].status, 'pending');
  S.runLine(e, `== ${A_ID}: database backup`, 21); assert.equal(e.sites[A_ID].backup.step, 'database');
  S.runLine(e, `== ${A_ID}: copying files`, 22); assert.equal(e.sites[A_ID].backup.step, 'files');
  for (const l of [`== ${A_ID}: OK`, 'END code=0']) S.runLine(e, l, 30);
  const a = e.sites[A_ID];
  assert.equal(a.status, 'pending'); assert.deepEqual(a.pending, pending); assert.deepEqual(a.result, []);
  assert.deepEqual(a.backup, { status: 'done', step: null, reason: null });
  assert.deepEqual(e.run.done, [A_ID]); assert.deepEqual(e.run.durations, [10]); assert.equal(e.run.active, false);
});

test('backup run: a failed step keeps its reason, until the next backup run', () => {
  const e = listed();
  S.startRun(e, [A_ID], 10, 'backup');
  for (const l of [`===== [1/1] ${A_ID}`, `== ${A_ID}: database backup`, `== ${A_ID}: copying files`,
    `== ${A_ID}: backup failed (files)`, '', 'Check: x', 'END code=1']) S.runLine(e, l, 20);
  assert.deepEqual(e.sites[A_ID].backup, { status: 'failed', step: null, reason: 'backup failed (files)' });
  assert.equal(e.sites[A_ID].status, 'pending'); assert.deepEqual(e.run.done, []);
  S.startRun(e, [C_ID], 30);   // an update run leaves it
  assert.equal(e.sites[A_ID].backup.status, 'failed');
  S.startRun(e, [C_ID], 40, 'backup');
  assert.equal(e.sites[A_ID].backup, null);
});

test('backup run cut halfway: the site being copied failed, the queued ones are untouched', () => {   // Review Focus 1
  const e = listed();
  S.startRun(e, [A_ID, C_ID], 10, 'backup');
  for (const l of [`===== [1/2] ${A_ID}`, `== ${A_ID}: copying files`]) S.runLine(e, l, 20);
  S.closeRun(e, null);
  assert.deepEqual(e.sites[A_ID].backup, { status: 'failed', step: null, reason: 'the backup stopped halfway' });
  assert.equal(e.sites[C_ID].backup, null);
  assert.equal(e.sites[A_ID].status, 'pending'); assert.equal(e.sites[C_ID].status, 'pending');
});

test('update runs say their kind', () => {
  const e = listed();
  S.startRun(e, [A_ID], 1);
  assert.equal(e.run.kind, 'update');
});

test('sizes: measuring, measured, failed, and leftovers become unknown', () => {   // Review Focus 5
  const e = listed();
  assert.equal(e.sites[A_ID].size, null);
  S.startSizes(e, [A_ID, B_ID, C_ID]);
  assert.deepEqual(e.sites[B_ID].size, { status: 'measuring' });
  S.sizeLine(e, JSON.stringify({ site: A_ID, bytes: 2400000000 }));
  S.sizeLine(e, JSON.stringify({ site: B_ID, error: 'could not measure' }));
  for (const junk of ['', 'PHP notice', '{"site":"zzzzzzzz:/x","bytes":1}', JSON.stringify({ site: C_ID, bytes: 'many' })]) S.sizeLine(e, junk);
  S.endSizes(e, [A_ID, B_ID, C_ID]);
  assert.deepEqual(e.sites[A_ID].size, { status: 'done', bytes: 2400000000 });
  assert.deepEqual(e.sites[B_ID].size, { status: 'error' });
  assert.deepEqual(e.sites[C_ID].size, { status: 'error' });
});
