const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const B = require('../lib/backups');
const SRV = { user: 'u', host: 'main.test' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-b-'));

test('folderName follows the rule of updater.sh', () => {
  assert.equal(B.folderName('https://example.com/blog/'), 'example.com_blog');
  assert.equal(B.folderName('http://site1.demo'), 'site1.demo');
  assert.equal(B.folderName('https://example.com:8443/'), 'example.com_8443');
});

test('readFull reads the record of the full backup on disk', () => {
  const root = tmp(), dir = path.join(root, 'u@main.test', 'x.test', 'full-backup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'backup.json'), '{"date":"2026-10-22T12:00:00Z","bytes":123}');
  const rec = { date: '2026-10-22T12:00:00Z', bytes: 123 };
  assert.deepEqual(B.readFull(root, SRV, 'https://x.test/'), rec);
  assert.deepEqual(B.readFull(root, SRV, 'http://x.test'), rec);   // both use the folder x.test
  assert.equal(B.readFull(root, { user: 'u', host: 'other.test' }, 'https://x.test'), null);
  assert.equal(B.readFull(root, SRV, 'https://y.test'), null);
  for (const bad of ['{nope', '{"date":1,"bytes":123}', '{"date":"2026-10-22T12:00:00Z"}']) {
    fs.writeFileSync(path.join(dir, 'backup.json'), bad);
    assert.equal(B.readFull(root, SRV, 'https://x.test'), null, bad);
  }
});

test('canHardlink creates the folder, says whether hardlinks work there and leaves nothing behind', () => {
  const dir = path.join(tmp(), 'backups');
  assert.equal(B.canHardlink(dir), true);
  assert.deepEqual(fs.readdirSync(dir), []);
  const file = path.join(tmp(), 'a-file');
  fs.writeFileSync(file, '');
  assert.equal(B.canHardlink(path.join(file, 'backups')), false);
});
