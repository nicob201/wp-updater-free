const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'test/fake-updater.sh');
const [A, B, C] = ['a', 'b', 'c'].map(p => `aaaaaaaa:/sites/${p}`);
const MAIN = { id: 'aaaaaaaa', name: 'Main', host: 'main.test', port: 22, user: 'u', path: '' };
const OTHER = { id: 'bbbbbbbb', name: 'Other', host: 'other.test', port: 22, user: 'u', path: '' };
const CONFIG = { servers: [MAIN], exclude: ['elementor', 'elementor-pro'] };
const procs = [];
const dirs = new Set();

// At the end: kill the servers and any detached runs left behind
test.after(() => {
  for (const p of procs) p.kill('SIGKILL');
  for (const d of dirs) {
    try { process.kill(-JSON.parse(fs.readFileSync(path.join(d, 'running.json'))).pid, 'SIGKILL'); } catch {}
  }
});

// Starts the bridge on a temp data dir; the config is written only for a new dir
async function start(env = {}, config = CONFIG) {
  const port = env.WPU_PORT || String(20000 + Math.floor(Math.random() * 10000));
  const dir = env.WPU_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  if (!env.WPU_DATA) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, WPU_SCRIPT: FAKE, ...env, WPU_PORT: port, WPU_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
  });
  procs.push(proc); dirs.add(dir);
  await new Promise((ok, fail) => {
    let buf = '';
    proc.stdout.on('data', d => { buf += d; if (/WP Updater: http:\/\/localhost:\d+\//.test(buf)) ok(); });
    proc.on('exit', c => fail(new Error('the server exited with ' + c)));
    setTimeout(() => fail(new Error('the server did not start')), 5000);
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'X-WPU': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, port, dir, proc, post };
}

// fetch can't set Host or Origin: plain http for that
function request(s, route, headers = {}, method = 'GET') {
  return new Promise((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, path: route, method, headers }, res => { res.resume(); ok(res.statusCode); });
    r.on('error', fail); r.end();
  });
}

// Opens a new SSE connection and reads it until cond(state) is true
async function waitState(s, cond, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${s.base}/api/events`, { signal: ctl.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!ev.startsWith('event: state')) continue;
        const e = JSON.parse(ev.split('\n').find(l => l.startsWith('data: ')).slice(6));
        if (cond(e)) return e;
      }
    }
    throw new Error('the event connection closed');
  } catch (err) {
    if (ctl.signal.aborted) throw new Error('timed out waiting for the state');
    throw err;
  } finally { clearTimeout(timer); ctl.abort(); }
}
const listed = e => e.checked !== null && !e.listing;

// ---- Security ----

test('rejects a foreign Host, a missing X-WPU header and a foreign Origin', async () => {
  const s = await start();
  assert.equal(await request(s, '/', { Host: 'evil.com' }), 403);
  assert.equal(await request(s, '/api/events', { Host: `evil.com:${s.port}` }), 403);
  assert.equal((await fetch(s.base + '/api/list', { method: 'POST' })).status, 403);
  assert.equal(await request(s, '/api/list', { 'X-WPU': '1', Origin: 'http://evil.com' }, 'POST'), 403);
  assert.ok([202, 409].includes(await request(s, '/api/list', { 'X-WPU': '1', Origin: `http://localhost:${s.port}` }, 'POST')));
  assert.equal((await fetch(s.base + '/')).status, 200);
});

test('creates the SSH key once and publishes the public half', async () => {
  const s = await start();
  const e = await waitState(s, e => !!e.publicKey);
  assert.match(e.publicKey, /^ssh-ed25519 \S+ wp-updater$/);
  assert.equal(fs.statSync(path.join(s.dir, 'ssh', 'id_ed25519')).mode & 0o777, 0o600);
  s.proc.kill('SIGKILL');
  const s2 = await start({ WPU_DATA: s.dir });
  assert.equal((await waitState(s2, e => !!e.publicKey)).publicKey, e.publicKey);
});

test('refuses to start with a broken config.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{x');
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WPU_PORT: '0', WPU_DATA: dir, WPU_SCRIPT: FAKE } });
  let err = ''; p.stderr.on('data', d => { err += d; });
  assert.equal(await new Promise(r => p.on('exit', r)), 1);
  assert.match(err, /config/i);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{x');   // never overwritten
});

// ---- Listing ----

test('lists on start and reports SSH per server', async () => {
  const s = await start();
  const e = await waitState(s, e => listed(e) && e.servers.aaaaaaaa.ssh !== null);
  assert.equal(e.servers.aaaaaaaa.ssh, true); assert.equal(e.sites[A].status, 'pending'); assert.equal(e.sites[B].status, 'up-to-date');
  assert.equal(e.sites[A].url, 'https://a.aaaaaaaa.test');
});

test('listing twice at once → 409', async () => {
  const s = await start({ FAKE_SLOW: '1' });   // already listing because of the start
  assert.equal((await s.post('/api/list')).status, 409);
});

test('without SSH: ssh=false with the reason, and nothing is left checking', async () => {
  const s = await start({ FAKE_SSH: 'bad' });   // like the real one: prints nothing and exits 255
  const e = await waitState(s, e => e.servers.aaaaaaaa.ssh === false && !e.listing);
  assert.match(e.servers.aaaaaaaa.message, /connect/);
  assert.deepEqual(Object.keys(e.sites), []); assert.equal(e.checked, null);
});

test('lists every configured server', async () => {
  const s = await start({}, { ...CONFIG, servers: [MAIN, OTHER] });
  const e = await waitState(s, listed);
  assert.equal(e.sites['aaaaaaaa:/sites/a'].status, 'pending'); assert.equal(e.sites['bbbbbbbb:/sites/a'].status, 'pending');
});

test('excluded sites are never analyzed', async () => {
  const s = await start({}, { ...CONFIG, excludedSites: [B] });
  await waitState(s, listed);
  const e = await waitState(s, () => true);   // first state of a new connection carries the log
  assert.equal(e.sites[B].status, 'excluded');
  assert.ok(!e.log.some(l => l.startsWith('=====') && l.endsWith(B)), 'B was analyzed');
});

// ---- Settings ----

// Docker on Linux with another uid, or a folder Colima doesn't share: data/ exists but can't be written
const ROOT_USER = process.getuid?.() === 0 && 'root writes anywhere';
async function readOnly(s, fn) {
  fs.chmodSync(s.dir, 0o555);
  try { await fn(); } finally { fs.chmodSync(s.dir, 0o755); }
}

test("saving settings in a data folder that can't be written says so and keeps the bridge running", { skip: ROOT_USER }, async () => {
  const s = await start();
  await waitState(s, listed);
  await readOnly(s, async () => {
    const r = await s.post('/api/config', CONFIG);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /can't write to the data folder/i);
  });
  assert.equal(s.proc.exitCode, null, 'the bridge stopped');
  assert.equal((await s.post('/api/config', CONFIG)).status, 200);
});

test("an update in a data folder that can't be written is refused and starts nothing", { skip: ROOT_USER }, async () => {
  const s = await start();
  await waitState(s, listed);
  await readOnly(s, async () => {
    const r = await s.post('/api/update', { sites: [A] });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /can't write to the data folder/i);
  });
  const e = await waitState(s, () => true);
  assert.equal(e.run, null);
  assert.equal(e.sites[A].status, 'pending');
  assert.equal(s.proc.exitCode, null, 'the bridge stopped');
});

test('POST /api/config: 400 with a message, 200 saves and lists again', async () => {
  const s = await start();
  await waitState(s, listed);
  const bad = await s.post('/api/config', { ...CONFIG, servers: [{ ...MAIN, host: '-oProxyCommand=x' }] });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /host/i);
  const ok = await s.post('/api/config', { ...CONFIG, servers: [MAIN, { ...OTHER, id: undefined }] });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8'));
  assert.equal(saved.servers.length, 2); assert.match(saved.servers[1].id, /^[a-f0-9]{8}$/);
  const e = await waitState(s, e => listed(e) && Object.keys(e.sites).some(id => id.startsWith(saved.servers[1].id)));
  assert.equal(e.config.servers.length, 2);
});

test('saving settings restarts a running listing and is refused during an update', async () => {   // Review Focus 4
  const s = await start({ FAKE_SLOW: '1' });
  assert.equal((await s.post('/api/config', { ...CONFIG, excludedSites: [C] })).status, 200);
  const e = await waitState(s, listed, 20000);
  assert.equal(e.sites[C].status, 'excluded'); assert.equal(e.sites[A].status, 'pending');
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 202);
  const r = await s.post('/api/config', CONFIG);
  assert.equal(r.status, 409); assert.match((await r.json()).error, /update is running/);
});

test('POST /api/test reports the probe result', async () => {
  const s = await start();
  const ok = await s.post('/api/test', { host: 'new.test', port: 22, user: 'u' });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, message: 'OK' });
  assert.equal((await s.post('/api/test', { host: 'new.test', port: 0, user: 'u' })).status, 400);
  const s2 = await start({ FAKE_SSH: 'bad' });
  const bad = await (await s2.post('/api/test', { host: 'new.test', port: 22, user: 'u' })).json();
  assert.equal(bad.ok, false); assert.match(bad.message, /connect/);
});

test('POST /api/test says OK and warns when rsync is missing', async () => {
  const s = await start({ FAKE_NO_RSYNC: '1' });
  const r = await (await s.post('/api/test', { host: 'new.test', port: 22, user: 'u' })).json();
  assert.equal(r.ok, true); assert.match(r.message, /rsync is missing/);
  const e = await waitState(s, e => e.servers.aaaaaaaa.ssh === true);
  assert.equal(e.servers.aaaaaaaa.rsync, false);
});

// ---- Updates ----

test('updates, ends done and lists again', async () => {
  const s = await start(); await waitState(s, listed);
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 202);
  const e = await waitState(s, e => e.run?.code === 0 && !e.listing && e.checked > e.run.start);
  assert.equal(e.sites[A].result.length, 1);   // the listing afterwards doesn't erase it
  assert.ok(!fs.existsSync(path.join(s.dir, 'running.json')));
});

test('one update covers two servers', async () => {
  const s = await start({}, { ...CONFIG, servers: [MAIN, OTHER] }); await waitState(s, listed);
  assert.equal((await s.post('/api/update', { sites: ['aaaaaaaa:/sites/a', 'bbbbbbbb:/sites/a'] })).status, 202);
  // "done" only lasts until the automatic listing after the run; the result stays
  const e = await waitState(s, e => e.run?.code === 0 && !e.listing && e.checked > e.run.start);
  assert.equal(e.run.n, 2); assert.equal(e.run.done.length, 2);
  assert.equal(e.sites['aaaaaaaa:/sites/a'].result.length, 1); assert.equal(e.sites['bbbbbbbb:/sites/a'].result.length, 1);
});


test('validates sites', async () => {
  const s = await start(); await waitState(s, listed);
  for (const d of [[], ['evil.com'], ['aaaaaaaa:/sites/a; rm -rf ~'], [B], ['zzzzzzzz:/sites/a'], 'a.test'])
    assert.equal((await s.post('/api/update', { sites: d })).status, 400, JSON.stringify(d));
  const r = await fetch(s.base + '/api/update', { method: 'POST', headers: { 'X-WPU': '1' }, body: 'not json' });
  assert.equal(r.status, 400);
});

test('duplicates cannot be updated', async () => {
  const s = await start({ FAKE_DUP: '1' });
  const e = await waitState(s, listed);
  assert.equal(e.sites[A].status, 'duplicate');
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 400);
});

test('double click → a single run', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  const [r1, r2] = await Promise.all([s.post('/api/update', { sites: [A] }), s.post('/api/update', { sites: [A] })]);
  assert.deepEqual([r1.status, r2.status].sort(), [202, 409]);
});

test('reloading the page mid-run brings the real state', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  await s.post('/api/update', { sites: [A] });
  const e = await waitState(s, e => e.run?.current === A);   // new SSE connection
  assert.equal(e.run.active, true); assert.equal(e.sites[A].status, 'updating');
});

test('killing the bridge does not stop the update, and it reattaches on return', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  await s.post('/api/update', { sites: [A] });
  await waitState(s, e => e.run?.current === A);
  const { pid } = JSON.parse(fs.readFileSync(path.join(s.dir, 'running.json')));
  s.proc.kill('SIGKILL');
  assert.doesNotThrow(() => process.kill(pid, 0));   // the run is still alive
  const s2 = await start({ WPU_DATA: s.dir, WPU_PORT: s.port, FAKE_SLOW: '1' });
  const e = await waitState(s2, e => e.run?.code === 0, 20000);
  assert.equal(e.sites[A].result.length, 1);
});

test('a dead run without END → interrupted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: 999999, sites: [A], start: 1 }));
  fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: updating\n`);
  const s = await start({ WPU_DATA: dir });
  const e = await waitState(s, e => e.run !== null);
  assert.equal(e.run.interrupted, true); assert.ok(!fs.existsSync(path.join(dir, 'running.json')));
});

test('a live pid that is not the run (e.g. after a reboot) counts as interrupted', async () => {
  const intruder = spawn('sleep', ['30']);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
    fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: intruder.pid, sites: [A], start: 1 }));
    fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: updating\n`);
    const s = await start({ WPU_DATA: dir });
    const e = await waitState(s, e => e.run !== null);
    assert.equal(e.run.interrupted, true); assert.equal(e.run.active, false);
  } finally { intruder.kill(); }
});

test('reattaching does not count fake durations for the time left', async () => {
  const s = await start({ FAKE_SLOW: '0.5' }); await waitState(s, listed, 20000);
  await s.post('/api/update', { sites: [A, C] });
  await waitState(s, e => e.run?.current === C, 20000);
  s.proc.kill('SIGKILL');
  const s2 = await start({ WPU_DATA: s.dir, WPU_PORT: s.port, FAKE_SLOW: '0.5' });
  const e = await waitState(s2, e => e.run?.code === 0, 20000);
  assert.ok(e.run.durations.every(d => d >= 1000), JSON.stringify(e.run.durations));
});

test('if the script dies mid-line, the end is still detected', async () => {
  const s = await start({ FAKE_CUT: '1' }); await waitState(s, listed);
  await s.post('/api/update', { sites: [A] });
  const e = await waitState(s, e => e.run?.code === 1, 8000);
  assert.equal(e.run.active, false); assert.equal(e.sites[A].status, 'review');
});

test('"Check for updates" clears an old review', async () => {
  const s = await start({ FAKE_CUT: '1' }); await waitState(s, listed);
  await s.post('/api/update', { sites: [A] });
  await waitState(s, e => e.run?.code === 1 && !e.listing && e.checked > e.run.start);
  assert.equal((await s.post('/api/list')).status, 202);
  const e = await waitState(s, e => !e.listing && e.sites[A].status !== 'checking' && e.sites[A].status !== 'review', 15000);
  assert.equal(e.sites[A].status, 'pending');
});

// ---- Startup ----

test('a relative WPU_SCRIPT works too', async () => {
  const s = await start({ WPU_SCRIPT: 'test/fake-updater.sh' });
  const e = await waitState(s, e => listed(e) && e.servers.aaaaaaaa.ssh !== null);
  assert.equal(e.servers.aaaaaaaa.ssh, true); assert.equal(e.sites[A].status, 'pending');
});

test('if already running, it does not start another and exits 0', async () => {
  const s = await start();
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WPU_PORT: s.port, WPU_DATA: s.dir, WPU_SCRIPT: FAKE } });
  let out = ''; p.stdout.on('data', d => { out += d; });
  assert.equal(await new Promise(r => p.on('exit', r)), 0);
  assert.match(out, /WP Updater is already running: http:\/\/localhost:\d+\//);
});

test('the full log travels only in the first state of each connection', async () => {
  const s = await start();
  const r = await fetch(`${s.base}/api/events`);
  const dec = new TextDecoder(); let buf = ''; const states = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      if (ev.startsWith('event: state')) states.push(JSON.parse(ev.split('\n').find(l => l.startsWith('data: ')).slice(6)));
    }
    if (states.length >= 2) break;
  }
  assert.ok(Array.isArray(states[0].log)); assert.equal('log' in states[1], false);
});

// ---- Full backups ----

test('POST /api/sizes measures the chosen sites', async () => {
  const s = await start(); await waitState(s, listed);
  assert.equal((await s.post('/api/sizes', { sites: [A, B] })).status, 202);
  const e = await waitState(s, e => e.sites[A].size?.status === 'done' && e.sites[B].size?.status === 'done');
  assert.deepEqual(e.sites[A].size, { status: 'done', bytes: 2400000000 });
  assert.deepEqual(e.sites[B].size, { status: 'done', bytes: 700000000 });
  assert.equal(e.sites[C].size, null);
  for (const sites of [[], ['aaaaaaaa:/x;y'], ['cccccccc:/sites/a']]) assert.equal((await s.post('/api/sizes', { sites })).status, 400, JSON.stringify(sites));
});

test('measuring again replaces the measuring in progress', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  assert.equal((await s.post('/api/sizes', { sites: [A, B] })).status, 202);
  assert.equal((await s.post('/api/sizes', { sites: [B] })).status, 202);
  // A was left unmeasured; B is measured by the new one, and the old one's end doesn't touch it
  const e = await waitState(s, e => e.sites[A].size?.status === 'error');
  assert.deepEqual(e.sites[B].size, { status: 'measuring' });
  assert.deepEqual((await waitState(s, e => e.sites[B].size?.status !== 'measuring')).sites[B].size, { status: 'done', bytes: 700000000 });
});

test('POST /api/backup copies, leaves the update status alone and does not list again', async () => {
  const s = await start(); const before = await waitState(s, listed);
  assert.equal(before.hardlinks, true);
  assert.equal((await s.post('/api/backup', { sites: [A] })).status, 202);
  const e = await waitState(s, e => e.run?.kind === 'backup' && e.run.code === 0);
  assert.equal(e.sites[A].status, 'pending'); assert.equal(e.sites[A].backup.status, 'done');
  assert.deepEqual(e.sites[A].lastFull, { date: '2026-10-22T12:00:00Z', bytes: 123 });
  assert.equal(e.sites[B].lastFull, null);
  assert.equal(e.checked, before.checked); assert.equal(e.listing, false);
  assert.ok(!fs.existsSync(path.join(s.dir, 'running.json')));
});

test("POST /api/backup refuses what it can't copy", async () => {
  const s = await start({}, { ...CONFIG, excludedSites: [B] }); await waitState(s, listed);
  for (const sites of [[], ['zzzzzzzz:/sites/a'], ['cccccccc:/sites/a'], [B], ['aaaaaaaa:/sites/a;rm'], [A, B]])
    assert.equal((await s.post('/api/backup', { sites })).status, 400, JSON.stringify(sites));
  assert.equal((await s.post('/api/backup', {})).status, 400);
  const s2 = await start({ FAKE_NO_RSYNC: '1' }); await waitState(s2, e => listed(e) && e.servers.aaaaaaaa.rsync === false);
  const r = await s2.post('/api/backup', { sites: [A] });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /can't be backed up/);
});

test("sites that share a backup folder can't be backed up", async () => {   // Review Focus 3
  const s = await start({ FAKE_DUP_URL: '1' });   // c answers http:// of a's address
  const e = await waitState(s, listed);
  assert.equal(e.sites[A].backupNote, 'Shares its backup folder with http://a.aaaaaaaa.test');
  assert.equal(e.sites[C].backupNote, 'Shares its backup folder with https://a.aaaaaaaa.test');
  assert.equal(e.sites[B].backupNote, null);
  assert.notEqual(e.sites[C].status, 'duplicate');   // not the same address for the updates, but the same folder
  assert.equal((await s.post('/api/backup', { sites: [A] })).status, 400);
  assert.equal((await s.post('/api/backup', { sites: [B] })).status, 202);
});

test('backups and sizes are refused during an update', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 202);
  assert.equal((await s.post('/api/backup', { sites: [A] })).status, 409);
  assert.equal((await s.post('/api/sizes', { sites: [A] })).status, 409);
});

test('during a backup nothing else starts', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, listed, 20000);
  assert.equal((await s.post('/api/backup', { sites: [A] })).status, 202);
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 409);
  assert.equal((await s.post('/api/list')).status, 409);
  assert.equal((await s.post('/api/backup', { sites: [B] })).status, 409);
  const r = await s.post('/api/config', CONFIG);
  assert.equal(r.status, 409); assert.match((await r.json()).error, /A backup is running/);
});

test('a dead backup run without END → interrupted, and the site keeps its update status', async () => {   // Review Focus 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: 999999, sites: [A], start: 1, kind: 'backup' }));
  fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: copying files\n`);
  const s = await start({ WPU_DATA: dir });
  const e = await waitState(s, e => e.run !== null && listed(e));
  assert.equal(e.run.interrupted, true); assert.equal(e.run.kind, 'backup');
  assert.equal(e.sites[A].backup.status, 'failed'); assert.equal(e.sites[A].status, 'pending');
});

test('a backup run that ended while the bridge was closed still lists the sites', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: 999999, sites: [A], start: 1, kind: 'backup' }));
  fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: copying files\n== ${A}: OK\n\nEND code=0\n`);
  const s = await start({ WPU_DATA: dir });
  const e = await waitState(s, e => e.run?.code === 0 && listed(e));
  assert.equal(e.sites[A].status, 'pending'); assert.equal(e.sites[A].backup.status, 'done');
});
