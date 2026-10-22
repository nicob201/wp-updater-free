const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ROOT = path.join(__dirname, '..');
const BASE = { WPU_SERVER: 'abcd1234', WPU_HOST: 'example.com', WPU_PORT: '2222', WPU_USER: 'u1', WPU_KEY: '/k/id', WPU_KNOWN_HOSTS: '/k/known_hosts' };

// A fake `ssh` first in PATH: logs its args, prints FAKE_OUT / FAKE_ERR, exits FAKE_EXIT
function run(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-fake-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/bash\necho "$*" >> "$CALLS"\ncat > /dev/null\nprintf "%s" "$FAKE_OUT"\nprintf "%s" "$FAKE_ERR" >&2\nexit ${FAKE_EXIT:-0}\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ROOT, 'updater.sh'), ...args], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, ...BASE, ...env } });
  return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

// Runs the remote side for real, on this machine: a fake `ssh` executes the command locally,
// and fake `wp`, `mysqldump` and `curl` answer like the real ones
const LOCAL_BIN = {
  ssh: '#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -i|-p|-o) shift 2 ;; *) break ;; esac; done\nshift\n'
     + 'if [ "$*" = "bash -s" ]; then bash -s; else bash -c "$*"; fi\n',
  wp: '#!/bin/bash\necho "$*" >> "$WP_LOG"\ncase "$*" in\n'
    + '  "option get home --format=json") echo \'"https://example.com/blog/"\' ;;\n'
    + '  "option get home") echo "https://example.com/blog/" ;;\n'
    + '  "config get DB_NAME --format=json") echo \'"db_main"\' ;;\n'
    + '  "config get DB_HOST --format=json") echo \'"localhost"\' ;;\n'
    + '  "config get table_prefix --format=json") echo \'"wp_"\' ;;\n'
    + '  "core version") echo 6.6.2 ;;\n'
    + '  "core check-update --force-check --format=json") echo \'[{"version":"6.8.3","update_type":"major"}]\' ;;\n'
    // WP-CLI before 2.10 has no requires/requires_php fields: it fails with "Invalid field"
    + '  *" list --fields="*requires*) [ -z "$FAKE_OLD_WPCLI" ] || { echo "Error: Invalid field: requires." >&2; exit 1; }\n'
    + '    case "$*" in plugin*) printf %s \'[{"name":"akismet","status":"active","update":"available","version":"5.3","update_version":"5.5","requires":"6.0","requires_php":"7.2"},\'\n'
    + '      echo \'{"name":"contact-form-7","status":"inactive","update":"unavailable","version":"5.9","update_version":"6.2.3","requires":"7.1","requires_php":"8.3"}]\' ;; esac ;;\n'
    + '  "plugin list --update=available"*) echo \'[{"name":"akismet","status":"active","update":"available","version":"5.3","update_version":"5.5"}]\' ;;\n'
    + '  "config get "*) echo x ;;\n'
    + 'esac\n',
  mysqldump: '#!/bin/bash\necho "-- dump"\n[ -n "$FAKE_DUMP_BAD" ] || echo "-- Dump completed on 2026-10-21"\n',
  curl: '#!/bin/bash\necho "${FAKE_HTTP:-200}"\n',
};

function runLocal(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-local-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'site'));
  fs.writeFileSync(path.join(dir, 'site', 'wp-load.php'), '');
  for (const [name, body] of Object.entries(LOCAL_BIN)) fs.writeFileSync(path.join(dir, 'bin', name), body, { mode: 0o755 });
  const site = fs.realpathSync(path.join(dir, 'site'));
  const r = spawnSync('bash', [path.join(ROOT, 'updater.sh'), ...args.map(a => a === 'SITE' ? site : a)], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, ...BASE, WPU_PATH: site, WPU_BACKUPS: path.join(dir, 'backups'),
           WPU_EXCLUDE: 'elementor,elementor-pro', WP_LOG: path.join(dir, 'wp.log'), ...env } });
  return { ...r, site, id: `abcd1234:${site}`, backup: path.join(dir, 'backups', 'u1@example.com', 'example.com_blog'),
           wpLog: () => fs.readFileSync(path.join(dir, 'wp.log'), 'utf8') };
}

test('--json prints a valid site line with address, database, version and exclusions', () => {
  const r = runLocal(['--json']);
  const site = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(site, { site: r.id, url: 'https://example.com/blog/', db: { name: 'db_main', host: 'localhost', prefix: 'wp_' }, wp: '6.6.2',
    exclude: ['elementor', 'elementor-pro'], core: [{ version: '6.8.3', update_type: 'major' }],
    plugins: [{ name: 'akismet', status: 'active', update: 'available', version: '5.3', update_version: '5.5', requires: '6.0', requires_php: '7.2' },
              { name: 'contact-form-7', status: 'inactive', update: 'unavailable', version: '5.9', update_version: '6.2.3', requires: '7.1', requires_php: '8.3' }],
    themes: [] });
});

test('--json still lists with a WP-CLI too old to say what an update needs', () => {
  const r = runLocal(['--json'], { FAKE_OLD_WPCLI: '1' });
  const site = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(site.plugins, [{ name: 'akismet', status: 'active', update: 'available', version: '5.3', update_version: '5.5' }]);
  assert.doesNotMatch(r.stderr, /Invalid field/);
});

test('--apply backs up the database, saves the versions and updates with the exclusions', () => {
  const r = runLocal(['--apply', 'SITE']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [`===== [1/1] ${r.id}`, `== ${r.id}: database backup`, `== ${r.id}: updating`, `== ${r.id}: OK`]);
  assert.match(require('node:zlib').gunzipSync(fs.readFileSync(path.join(r.backup, 'database.sql.gz'))).toString(), /Dump completed/);
  assert.ok(fs.existsSync(path.join(r.backup, 'versions-before.txt')));
  assert.match(r.wpLog(), /^plugin update --all --exclude=elementor,elementor-pro$/m);
  assert.match(r.wpLog(), /^theme update --all --exclude=elementor,elementor-pro$/m);
});

test('--apply backs up only the database, even with the old WPU_FULL_BACKUP set', () => {
  const r = runLocal(['--apply', 'SITE'], { WPU_FULL_BACKUP: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /copying files/);
  assert.ok(!fs.existsSync(path.join(r.backup, 'files')));
});

test('--apply never updates a site whose database backup is incomplete', () => {
  const r = runLocal(['--apply', 'SITE'], { FAKE_DUMP_BAD: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /database backup incomplete, not updated/);
  assert.doesNotMatch(r.stdout, /updating/);
  assert.doesNotMatch(r.wpLog(), /update --all|core update/);
  assert.ok(!fs.existsSync(path.join(r.backup, 'database.sql.gz')));
});

test('every ssh call is non-interactive and uses the configured key, port and host', () => {
  const calls = [...run(['--probe']).calls, ...run(['--json'], { FAKE_OUT: '/home/u1/a\n' }).calls];
  assert.ok(calls.length >= 3);
  for (const c of calls) for (const o of ['-i /k/id', '-p 2222', 'IdentitiesOnly=yes', 'UserKnownHostsFile=/k/known_hosts',
      'StrictHostKeyChecking=accept-new', 'BatchMode=yes', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'u1@example.com'])
    assert.ok(c.includes(o), `missing ${o} in: ${c}`);
});

test('--probe explains each failure', () => {   // Review Focus 3
  const cases = [
    [{ FAKE_EXIT: '255', FAKE_ERR: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@' }, /host key has changed/],
    [{ FAKE_EXIT: '255', FAKE_ERR: 'u1@example.com: Permission denied (publickey).' }, /rejected the key/],
    [{ FAKE_EXIT: '255', FAKE_ERR: 'ssh: connect to host example.com port 2222: Connection refused' }, /Can't connect/],
    [{ FAKE_OUT: 'uid=0\nhas-wp\nhas-dump\n' }, /root/],
    [{ FAKE_OUT: 'uid=1000\nhas-dump\n' }, /WP-CLI/],
    [{ FAKE_OUT: 'uid=1000\nhas-wp\n' }, /mysqldump/],
  ];
  for (const [env, msg] of cases) { const r = run(['--probe'], env); assert.equal(r.status, 1, JSON.stringify(env)); assert.match(r.stdout, msg); }
  const ok = run(['--probe'], { FAKE_OUT: 'uid=1000\nhas-wp\nhas-dump\nhas-rsync\n' });
  assert.equal(ok.status, 0); assert.equal(ok.stdout.trim(), 'OK');
});

test('--probe says OK and notes a missing rsync', () => {
  const r = run(['--probe'], { FAKE_OUT: 'uid=1000\nhas-wp\nhas-dump\n' });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), 'OK\nno-rsync');
});

test('--json: first line lists discovered sites; excluded and unsafe paths are not analyzed', () => {
  const r = run(['--json'], { FAKE_OUT: '/home/u1/a\n/home/u1/b c\n/home/u1/old\n', WPU_SKIP: '/home/u1/old' });
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { server: 'abcd1234', sites: ['/home/u1/a', '/home/u1/old'], skipped: ['/home/u1/old'] });
  assert.deepEqual(lines.filter(l => l.startsWith('=====')), ['===== [1/1] abcd1234:/home/u1/a']);
});

test('--json searches the remote home by default, or the configured sites path', () => {
  assert.match(run(['--json']).calls[0], / find ~ -maxdepth 5 /);   // unquoted, so the remote shell expands it
  assert.match(run(['--json'], { WPU_PATH: '/var/www' }).calls[0], / find \/var\/www -maxdepth 5 /);
});

test('--json without a connection prints nothing and exits 255', () => {
  const r = run(['--json'], { FAKE_EXIT: '255' });
  assert.equal(r.stdout, ''); assert.equal(r.status, 255);
});

test('refuses to run without connection settings', () => {
  assert.equal(run(['--json'], { WPU_HOST: '' }).status, 2);
});

test('shell scripts keep LF line endings on every platform', () => {   // Review Focus 1
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /eol=lf/);
  for (const f of execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'))
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('\r'), f);
});
