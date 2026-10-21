// Local bridge between the page (public/) and updater.sh.
// Listens on 127.0.0.1 only, requires its own Host and, under /api, a token that changes on every start.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');
const { spawn, execFile, execFileSync } = require('node:child_process');
const S = require('./lib/state');

// The environment variables exist for the tests; normal use doesn't touch them
const PORT = Number(process.env.WPU_PORT || 8787);
const SCRIPT = path.resolve(process.env.WPU_SCRIPT || path.join(__dirname, 'updater.sh'));
const DATA = path.resolve(process.env.WPU_DATA || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const TOKEN = crypto.randomBytes(32).toString('hex');
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const FILES = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
const LOG = path.join(DATA, 'last-run.log');
const RUNNING = path.join(DATA, 'running.json');   // exists while an update runs
const RE_DOMAIN = /^[a-z0-9.-]+$/;

fs.mkdirSync(DATA, { recursive: true });
const state = S.newState();
const clients = new Set();
let listing = null;   // listing process in progress
let reader = null;    // interval that reads the update's log

// ---- Live events (Server-Sent Events) ----

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

let pendingSend = null;
function changed() {   // batches: at most one state push every 200 ms
  if (pendingSend) return;
  pendingSend = setTimeout(() => {
    pendingSend = null;
    const { log: _, ...withoutLog } = state;   // the full log goes only on connect; after that, line by line
    for (const c of clients) send(c, 'state', withoutLog);
  }, 200);
}

function log(line) { for (const c of clients) send(c, 'log', line); }

function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  send(res, 'state', state);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ---- Script ----

function list(options) {
  if (listing || state.run?.active) return false;
  const proc = spawn(SCRIPT, ['--json'], { cwd: path.dirname(SCRIPT) });
  listing = proc;
  S.startListing(state, options);
  changed();
  readline.createInterface({ input: proc.stdout }).on('line', l => { S.listingLine(state, l, Date.now()); log(l); changed(); });
  readline.createInterface({ input: proc.stderr }).on('line', l => { S.note(state, l); log(l); });
  const finish = code => {
    if (listing !== proc) return;
    listing = null;
    S.endListing(state, Date.now(), code);
    changed();
  };
  proc.on('close', code => finish(code ?? 1));
  proc.on('error', err => { S.note(state, `Could not run ${SCRIPT}: ${err.message}`); finish(1); });
  return true;
}

// The update runs detached from the bridge: if this window closes, it keeps going.
// The bridge only reads the log it writes.
function start(ids) {
  const now = Date.now();
  S.startRun(state, ids, now);
  fs.writeFileSync(LOG, '');   // emptied before reading: so the previous run's END isn't read again
  // The newline before END puts it on its own line even if the script dies in the middle of one
  const proc = spawn('sh', ['-c', '"$0" --apply "$@" > "$LOG" 2>&1; c=$?; printf "\\nEND code=%s\\n" "$c" >> "$LOG"', SCRIPT, ...ids],
    { cwd: path.dirname(SCRIPT), detached: true, stdio: 'ignore', env: { ...process.env, LOG } });
  proc.unref();
  fs.writeFileSync(RUNNING, JSON.stringify({ pid: proc.pid, sites: ids, start: now }));
  readLog();
  changed();
}

function readLog(offset = 0) {
  clearInterval(reader);
  let rest = '';
  const dec = new StringDecoder('utf8');
  reader = setInterval(() => {
    let fd;
    try { fd = fs.openSync(LOG, 'r'); } catch { return; }
    try {
      const { size } = fs.fstatSync(fd);
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (rest + dec.write(buf)).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        S.runLine(state, l, Date.now());
        log(l);
        if (l.startsWith('END code=')) finishRun();
      }
      changed();
    } finally { fs.closeSync(fd); }
  }, 300);
}

function finishRun() {
  clearInterval(reader);
  reader = null;
  try { fs.unlinkSync(RUNNING); } catch {}
  list();   // to confirm they ended up up to date
}

// Is that pid still our run? After a reboot, that number may belong to another process
function isOurs(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(SCRIPT); }
  catch { return false; }
}

// On start: if an update was left over, pick it up again. Returns true if it already took care of the listing.
function recover() {
  let r;
  try { r = JSON.parse(fs.readFileSync(RUNNING, 'utf8')); } catch { return false; }
  let text = '';
  try { text = fs.readFileSync(LOG, 'utf8'); } catch {}
  S.startRun(state, r.sites, r.start);
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  for (const l of complete.split('\n')) S.runLine(state, l, Date.now());
  // Everything replayed has the same time: those durations are useless for estimating the time left
  Object.assign(state.run, { durations: [], siteStart: null });

  if (!state.run.active) { finishRun(); return true; }                      // finished while the bridge was closed
  if (isOurs(r.pid)) { readLog(Buffer.byteLength(complete)); return true; }  // still running

  // Died without finishing: the site left halfway goes to review
  S.closeRun(state, null);
  state.run.interrupted = true;
  fs.unlinkSync(RUNNING);
  return false;
}

function update(req, res) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let ids;
    try { ids = JSON.parse(body).sites; } catch { return reply(res, 400); }
    if (state.run?.active || listing) return reply(res, 409);
    const valid = d => typeof d === 'string' && RE_DOMAIN.test(d) && state.sites[d]?.pending.length > 0
      && ['pending', 'review'].includes(state.sites[d].status);
    if (!Array.isArray(ids) || !ids.length || !ids.every(valid)) return reply(res, 400);
    start([...new Set(ids)]);
    reply(res, 202);
  });
}

function probeSSH() {
  execFile(SCRIPT, ['--probe'], { cwd: path.dirname(SCRIPT), timeout: 20000 }, err => {
    if (state.ssh !== !err) { state.ssh = !err; changed(); }
  });
}

// ---- HTTP ----

function reply(res, code) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(code)); }

function tokenOk(t) {
  const a = Buffer.from(String(t ?? '')), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (!HOSTS.includes(req.headers.host)) return reply(res, 403);   // stops another website from talking to localhost
  const url = new URL(req.url, 'http://local');

  if (!url.pathname.startsWith('/api/')) {
    const f = FILES[url.pathname];
    if (!f || req.method !== 'GET') return reply(res, 404);
    return fs.readFile(path.join(PUBLIC, f[0]), (err, buf) => {
      if (err) return reply(res, 404);
      res.writeHead(200, { 'Content-Type': `${f[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  if (!tokenOk(req.method === 'GET' ? url.searchParams.get('t') : req.headers['x-token'])) return reply(res, 403);
  if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res);
  if (req.method === 'POST' && url.pathname === '/api/list') return reply(res, list({ clearReview: true }) ? 202 : 409);
  if (req.method === 'POST' && url.pathname === '/api/update') return update(req, res);
  reply(res, 404);
});

// Started again while the bridge is already running: open the running one's page and exit
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  let token = '';
  try { token = fs.readFileSync(path.join(DATA, '.token'), 'utf8').trim(); } catch {}
  console.log('WP Updater is already running.');
  if (process.env.WPU_NO_OPEN) process.exit(0);
  execFile('open', [`http://127.0.0.1:${PORT}/?t=${token}`], () => process.exit(0));
});

server.listen(PORT, '127.0.0.1', () => {
  const tokenFile = path.join(DATA, '.token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`WP Updater: ${url}`);
  console.log('Close this window to stop it. An update in progress keeps going.');
  probeSSH();
  setInterval(probeSSH, 60000);
  if (!recover()) list();
  if (!process.env.WPU_NO_OPEN) execFile('open', [url]);
});
