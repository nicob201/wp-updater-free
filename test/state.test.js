const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/state');

const LIST = '{"sites":["a.test","b.test","c.test"]}';
const A = JSON.stringify({ site:'a.test', wp:'7.1.3', exclude:['elementor','elementor-pro'], core:[],
  plugins:[{name:'woocommerce',status:'active',version:'11.2.0',update_version:'11.2.1'},
           {name:'elementor-pro',status:'active',version:'4.0.1',update_version:'4.3.2'}],
  themes:[{name:'astra',status:'inactive',version:'4.14.0',update_version:'4.14.1'}] });
const B = JSON.stringify({ site:'b.test', wp:'7.1.3', exclude:['elementor','elementor-pro'], core:[],
  plugins:[{name:'elementor-pro',status:'active',version:'4.0.1',update_version:'4.3.2'}], themes:[] });

test('listing: pending, excluded and up to date', () => {
  const e = S.newState();
  S.listingLine(e, LIST, 1); assert.equal(e.sites['c.test'].status, 'checking'); assert.equal(e.listing, true);
  S.listingLine(e, '===== [1/3] a.test', 2); S.listingLine(e, A, 3); S.listingLine(e, B, 4);
  S.listingLine(e, '{"site":"c.test","error":"ssh failed"}', 5);
  assert.equal(e.sites['a.test'].status, 'pending');
  assert.deepEqual(e.sites['a.test'].pending.map(i => [i.type, i.name, i.active]), [['plugin','woocommerce',true], ['theme','astra',false]]);
  assert.deepEqual(e.sites['a.test'].skipped.map(i => i.name), ['elementor-pro']);
  assert.equal(e.sites['b.test'].status, 'up-to-date');
  assert.equal(e.sites['c.test'].status, 'error'); assert.equal(e.sites['c.test'].reason, 'ssh failed');
});

test('listing: pending core uses the current wp version', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  S.listingLine(e, JSON.stringify({ site:'a.test', wp:'7.1.3', exclude:[], core:[{version:'7.1.4',update_type:'minor'}], plugins:[], themes:[] }), 2);
  assert.deepEqual(e.sites['a.test'].pending, [{ type:'core', name:'WordPress', active:true, current:'7.1.3', next:'7.1.4' }]);
});

test('endListing: whatever did not answer becomes an error', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 9);
  assert.equal(e.listing, false); assert.equal(e.checked, 9);
  assert.equal(e.sites['b.test'].status, 'error'); assert.equal(e.sites['b.test'].reason, 'no response');
});

test('run: progress, result, review and END', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, ['a.test','c.test'], 10);
  assert.equal(e.sites['c.test'].status, 'queued'); assert.equal(e.run.active, true);
  for (const l of ['===== [1/2] a.test', '== a.test: database backup', '== a.test: updating',
    'Downloading update from https://downloads.wordpress.org/plugin/woocommerce.11.2.1.zip...']) S.runLine(e, l, 20);
  const a = e.sites['a.test'];
  assert.equal(a.status, 'updating'); assert.equal(a.downloading, 'woocommerce'); assert.ok(a.progress > 0 && a.progress < 1);
  assert.equal(e.run.current, 'a.test'); assert.equal(e.run.n, 1);
  for (const l of ['woocommerce\t11.2.0\t11.2.1\tUpdated', '== a.test: OK', '===== [2/2] c.test',
    '== c.test: site responds 500, check it', 'END code=1']) S.runLine(e, l, 30);
  assert.equal(a.status, 'done'); assert.equal(a.progress, 1);
  assert.deepEqual(a.result, [{ type:'plugin', name:'woocommerce', before:'11.2.0', after:'11.2.1' }]);
  assert.equal(e.sites['c.test'].status, 'review'); assert.equal(e.sites['c.test'].reason, 'site responds 500, check it');
  assert.equal(e.run.code, 1); assert.equal(e.run.active, false); assert.equal(e.run.durations.length, 1);
});

test('the listing afterwards keeps result and review', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, ['a.test','c.test'], 10);
  for (const l of ['===== [1/2] a.test', 'woocommerce\t11.2.0\t11.2.1\tUpdated', '== a.test: OK',
    '===== [2/2] c.test', '== c.test: update failed', 'END code=1']) S.runLine(e, l, 20);
  S.listingLine(e, LIST, 30); S.listingLine(e, A, 31);
  S.listingLine(e, JSON.stringify({ site:'c.test', wp:'7.1.3', exclude:[], core:[], plugins:[], themes:[] }), 32); S.endListing(e, 33);
  assert.equal(e.sites['a.test'].result.length, 1);
  assert.equal(e.sites['c.test'].status, 'review'); assert.equal(e.sites['c.test'].reason, 'update failed');
  S.startRun(e, ['c.test'], 40);
  assert.equal(e.sites['c.test'].reason, null); assert.equal(e.sites['a.test'].result.length, 1);
});

test('an OK after "update failed" does not hide the error', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.endListing(e, 3);
  S.startRun(e, ['a.test'], 10);
  for (const l of ['===== [1/1] a.test', '== a.test: updating', '== a.test: update failed', '== a.test: OK', 'END code=1'])
    S.runLine(e, l, 20);
  assert.equal(e.sites['a.test'].status, 'review'); assert.equal(e.sites['a.test'].reason, 'update failed');
});

test('startRun creates sites it does not know', () => {
  const e = S.newState(); S.startRun(e, ['z.test'], 1);
  assert.equal(e.sites['z.test'].status, 'queued');
});

test('garbage in the output breaks nothing', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1);
  for (const l of ['PHP: 2026-10-21 [notice] Implicitly marking parameter $key as nullable', '{"site":"a.te', '', 'name\tstatus\tversion\tupdate_version'])
    { S.listingLine(e, l, 2); S.runLine(e, l, 2); }
  assert.equal(e.sites['a.test'].status, 'checking');
});

test('the log keeps only the last 500 lines', () => {
  const e = S.newState(); for (let i = 0; i < 600; i++) S.runLine(e, 'x' + i, 1);
  assert.equal(e.log.length, 500); assert.equal(e.log[0], 'x100');
});

const C = JSON.stringify({ site:'c.test', wp:'7.1.3', exclude:[], core:[],
  plugins:[{name:'hostinger',status:'active',version:'3.0.76',update_version:'3.0.80'}], themes:[] });

test('a listing that fails silently does not leave the old lists as current', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.listingLine(e, B, 2); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startListing(e);
  assert.equal(e.listing, true); assert.equal(e.sites['a.test'].status, 'checking');
  S.listingLine(e, '{"site":"c.test","error":"ssh failed"}', 4);
  S.endListing(e, 9, 255);
  assert.equal(e.checked, 3);   // doesn't say "checked just now" if it failed
  assert.equal(e.sites['a.test'].status, 'error'); assert.deepEqual(e.sites['a.test'].pending, []);
  assert.deepEqual(e.sites['c.test'].pending, []);
});

test('END halfway through a site: it goes to review, the queued ones go back and done counts only the good ones', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, A, 2); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startRun(e, ['a.test','c.test'], 10);
  for (const l of ['===== [1/2] a.test', '== a.test: database backup', 'END code=255']) S.runLine(e, l, 20);
  assert.equal(e.sites['a.test'].status, 'review'); assert.equal(e.sites['a.test'].reason, 'the update stopped halfway');
  assert.equal(e.sites['c.test'].status, 'pending');
  assert.deepEqual(e.run.done, []); assert.equal(e.run.code, 255);
  S.startRun(e, ['c.test'], 30);
  for (const l of ['===== [1/1] c.test', '== c.test: OK', 'END code=0']) S.runLine(e, l, 40);
  assert.deepEqual(e.run.done, ['c.test']);
});

test('"Check for updates" by hand clears review; the automatic listing does not', () => {
  const e = S.newState(); S.listingLine(e, LIST, 1); S.listingLine(e, C, 2); S.endListing(e, 3, 0);
  S.startRun(e, ['c.test'], 10);
  for (const l of ['===== [1/1] c.test', '== c.test: site responds 500, check it', 'END code=1']) S.runLine(e, l, 20);
  S.startListing(e);
  assert.equal(e.sites['c.test'].status, 'review');
  S.startListing(e, { clearReview: true });
  assert.equal(e.sites['c.test'].status, 'checking'); assert.equal(e.sites['c.test'].reason, null);
  S.listingLine(e, LIST, 30); S.listingLine(e, C, 31);
  assert.equal(e.sites['c.test'].status, 'pending');
});
