const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const [A, B, C] = ['a', 'b', 'c'].map(p => `aaaaaaaa:/sites/${p}`);
const procs = [];
const dirs = new Set();

// At the end: kill the servers and any detached runs left behind
test.after(() => {
  for (const p of procs) p.kill('SIGKILL');
  for (const d of dirs) {
    try { process.kill(-JSON.parse(fs.readFileSync(path.join(d, 'running.json'))).pid, 'SIGKILL'); } catch {}
  }
});

async function start(env = {}) {
  const port = env.WPU_PORT || String(20000 + Math.floor(Math.random() * 10000));
  const dir = env.WPU_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, WPU_NO_OPEN: '1', WPU_SCRIPT: path.join(ROOT, 'test/fake-updater.sh'), ...env, WPU_PORT: port, WPU_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
  });
  procs.push(proc); dirs.add(dir);
  const token = await new Promise((ok, fail) => {
    let buf = '';
    proc.stdout.on('data', d => { buf += d; const m = buf.match(/WP Updater: \S+\?t=([0-9a-f]+)/); if (m) ok(m[1]); });
    proc.on('exit', c => fail(new Error('the server exited with ' + c)));
    setTimeout(() => fail(new Error('the server did not start')), 5000);
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'X-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, token, port, dir, proc, post };
}

// fetch can't change the Host header: plain http for that
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
    const r = await fetch(`${s.base}/api/events?t=${s.token}`, { signal: ctl.signal });
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

test('rejects a foreign Host, a missing token and a wrong token', async () => {
  const s = await start();
  assert.equal(await request(s, '/', { Host: 'evil.com' }), 403);
  assert.equal(await request(s, `/api/events?t=${s.token}`, { Host: `evil.com:${s.port}` }), 403);
  assert.equal((await fetch(s.base + '/api/events')).status, 403);
  assert.equal((await fetch(s.base + '/api/events?t=bad')).status, 403);
  assert.equal((await fetch(s.base + '/api/list', { method: 'POST' })).status, 403);
  assert.equal((await fetch(s.base + '/')).status, 200);
});

test('lists on start and reports SSH', async () => {
  const s = await start();
  const e = await waitState(s, e => e.checked !== null);
  assert.equal(e.ssh, true); assert.equal(e.sites[A].status, 'pending'); assert.equal(e.sites[B].status, 'up-to-date');
});

test('listing twice at once → 409', async () => {
  const s = await start({ FAKE_SLOW: '1' });   // already listing because of the start
  assert.equal((await s.post('/api/list')).status, 409);
});

test('without SSH: ssh=false and sites become errors, none left checking', async () => {
  const s = await start({ FAKE_SSH: 'bad' });   // like the real one: prints nothing and exits 255
  const e = await waitState(s, e => e.ssh === false && !e.listing);
  assert.deepEqual(Object.keys(e.sites), []); assert.equal(e.checked, null);
});

test('updates, ends done and lists again', async () => {
  const s = await start(); await waitState(s, e => e.checked !== null);
  assert.equal((await s.post('/api/update', { sites: [A] })).status, 202);
  const e = await waitState(s, e => e.run?.code === 0 && !e.listing && e.checked > e.run.start);
  assert.equal(e.sites[A].result.length, 1);   // the listing afterwards doesn't erase it
  assert.ok(!fs.existsSync(path.join(s.dir, 'running.json')));
});

test('validates sites', async () => {
  const s = await start(); await waitState(s, e => e.checked !== null);
  for (const d of [[], ['evil.com'], ['aaaaaaaa:/sites/a; rm -rf ~'], [B], 'a.test'])
    assert.equal((await s.post('/api/update', { sites: d })).status, 400, JSON.stringify(d));
  const r = await fetch(s.base + '/api/update', { method: 'POST', headers: { 'X-Token': s.token }, body: 'not json' });
  assert.equal(r.status, 400);
});

test('double click → a single run', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, e => e.checked !== null, 20000);
  const [r1, r2] = await Promise.all([s.post('/api/update', { sites: [A] }), s.post('/api/update', { sites: [A] })]);
  assert.deepEqual([r1.status, r2.status].sort(), [202, 409]);
});

test('reloading the page mid-run brings the real state', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, e => e.checked !== null, 20000);
  await s.post('/api/update', { sites: [A] });
  const e = await waitState(s, e => e.run?.current === A);   // new SSE connection
  assert.equal(e.run.active, true); assert.equal(e.sites[A].status, 'updating');
});

test('killing the bridge does not stop the update, and it reattaches on return', async () => {
  const s = await start({ FAKE_SLOW: '1' }); await waitState(s, e => e.checked !== null, 20000);
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
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: 999999, sites: [A], start: 1 }));
  fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: updating\n`);
  const s = await start({ WPU_DATA: dir });
  const e = await waitState(s, e => e.run !== null);
  assert.equal(e.run.interrupted, true); assert.ok(!fs.existsSync(path.join(dir, 'running.json')));
});

test('a relative WPU_SCRIPT works too', async () => {
  const s = await start({ WPU_SCRIPT: 'test/fake-updater.sh' });
  const e = await waitState(s, e => e.checked !== null && e.ssh !== null);
  assert.equal(e.ssh, true); assert.equal(e.sites[A].status, 'pending');
});

test('if already running, it does not start another, keeps the token and exits 0', async () => {
  const s = await start();
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WPU_NO_OPEN: '1', WPU_PORT: s.port, WPU_DATA: s.dir, WPU_SCRIPT: path.join(ROOT, 'test/fake-updater.sh') } });
  let out = ''; p.stdout.on('data', d => { out += d; });
  const code = await new Promise(r => p.on('exit', r));
  assert.equal(code, 0); assert.match(out, /WP Updater is already running\./);
  assert.equal(fs.readFileSync(path.join(s.dir, '.token'), 'utf8'), s.token);
});

test('if the script dies mid-line, the end is still detected', async () => {
  const s = await start({ FAKE_CUT: '1' }); await waitState(s, e => e.checked !== null);
  await s.post('/api/update', { sites: [A] });
  const e = await waitState(s, e => e.run?.code === 1, 8000);
  assert.equal(e.run.active, false); assert.equal(e.sites[A].status, 'review');
});

test('a live pid that is not the run (e.g. after a reboot) counts as interrupted', async () => {
  const intruder = spawn('sleep', ['30']);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
    fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ pid: intruder.pid, sites: [A], start: 1 }));
    fs.writeFileSync(path.join(dir, 'last-run.log'), `===== [1/1] ${A}\n== ${A}: updating\n`);
    const s = await start({ WPU_DATA: dir });
    const e = await waitState(s, e => e.run !== null);
    assert.equal(e.run.interrupted, true); assert.equal(e.run.active, false);
  } finally { intruder.kill(); }
});

test('reattaching does not count fake durations for the time left', async () => {
  const s = await start({ FAKE_SLOW: '0.5' }); await waitState(s, e => e.checked !== null, 20000);
  await s.post('/api/update', { sites: [A, C] });
  await waitState(s, e => e.run?.current === C, 20000);
  s.proc.kill('SIGKILL');
  const s2 = await start({ WPU_DATA: s.dir, WPU_PORT: s.port, FAKE_SLOW: '0.5' });
  const e = await waitState(s2, e => e.run?.code === 0, 20000);
  assert.ok(e.run.durations.every(d => d >= 1000), JSON.stringify(e.run.durations));
});

test('the full log travels only in the first state of each connection', async () => {
  const s = await start();
  const r = await fetch(`${s.base}/api/events?t=${s.token}`);
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

test('"Check for updates" clears an old review', async () => {
  const s = await start({ FAKE_CUT: '1' }); await waitState(s, e => e.checked !== null);
  await s.post('/api/update', { sites: [A] });
  await waitState(s, e => e.run?.code === 1 && !e.listing && e.checked > e.run.start);
  assert.equal((await s.post('/api/list')).status, 202);
  const e = await waitState(s, e => !e.listing && e.sites[A].status !== 'checking' && e.sites[A].status !== 'review', 15000);
  assert.equal(e.sites[A].status, 'pending');
});
