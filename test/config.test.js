const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../lib/config');
const srv = (o = {}) => ({ name: 'Main', host: 'example.com', port: 22, user: 'u1', path: '', ...o });

test('valid config: defaults, ids, dedupe, unknown keys dropped', () => {
  const c = C.validate({ servers: [srv({ port: '' })], exclude: ['elementor', 'elementor'], extra: 1 });
  assert.match(c.servers[0].id, /^[a-f0-9]{8}$/);
  assert.equal(c.servers[0].port, 22);
  assert.deepEqual(c.exclude, ['elementor']);
  assert.deepEqual(Object.keys(c).sort(), ['exclude', 'excludedSites', 'fullBackup', 'servers']);
  assert.equal(c.fullBackup, false);
});

test('rejects values that could reach ssh or bash', () => {
  for (const bad of [{ host: '-oProxyCommand=x' }, { host: 'a b' }, { host: '' }, { user: '-x' }, { user: 'a;b' }, { port: 0 },
                     { port: 70000 }, { port: '22a' }, { path: 'rel/dir' }, { path: '/a b' }, { path: '/x;y' }, { path: '/a/../b' }, { name: '' }])
    assert.throws(() => C.validate({ servers: [srv(bad)] }), Error, JSON.stringify(bad));
  for (const slug of ['Elementor Pro', '../x', '-x']) assert.throws(() => C.validate({ exclude: [slug] }), Error, slug);
  assert.throws(() => C.validate({ fullBackup: 'yes' }));
  assert.throws(() => C.validate(null));
});

test('rejects the same server twice', () => {   // Review Focus 5
  assert.throws(() => C.validate({ servers: [srv(), srv({ name: 'Again' })] }), /Main|Again/);
});

test('excludedSites: keeps valid ids of known servers only', () => {
  const c = C.validate({ servers: [srv({ id: 'aaaaaaaa' })], excludedSites: ['aaaaaaaa:/home/u/old', 'bbbbbbbb:/x', 'aaaaaaaa:/home/u/old'] });
  assert.deepEqual(c.excludedSites, ['aaaaaaaa:/home/u/old']);
  assert.throws(() => C.validate({ servers: [srv({ id: 'aaaaaaaa' })], excludedSites: ['aaaaaaaa:rel'] }));
});

test('load/save round trip, missing file gives defaults, file is private', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-')), 'config.json');
  assert.deepEqual(C.load(f), { servers: [], exclude: [], excludedSites: [], fullBackup: false });
  const c = C.validate({ servers: [srv()], fullBackup: true });
  C.save(f, c);
  assert.deepEqual(C.load(f), c);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, '{nope');
  assert.throws(() => C.load(f), /config/i);
});
