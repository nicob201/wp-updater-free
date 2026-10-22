// Local bridge between the page (public/) and updater.sh: settings, live state and runs.
// Only answers requests addressed to localhost, and POSTs need a header no other website can send.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');
const { spawn, execFile, execFileSync } = require('node:child_process');
const S = require('./lib/state');
const C = require('./lib/config');
const B = require('./lib/backups');

// Docker sets WPU_BIND/WPU_DATA/WPU_SSH_DIR; the tests set the rest
const PORT = Number(process.env.WPU_PORT || 8787);
const BIND = process.env.WPU_BIND || '127.0.0.1';
const PUBLIC_PORT = Number(process.env.WPU_PUBLIC_PORT || PORT);   // the port the browser sees (Docker can map another one)
const SCRIPT = path.resolve(process.env.WPU_SCRIPT || path.join(__dirname, 'updater.sh'));
const DATA = path.resolve(process.env.WPU_DATA || path.join(__dirname, 'data'));
const SSH_DIR = path.resolve(process.env.WPU_SSH_DIR || path.join(DATA, 'ssh'));
const RUNNER = path.join(__dirname, 'lib', 'run.js');
const PUBLIC = path.join(__dirname, 'public');
const KEY = path.join(SSH_DIR, 'id_ed25519');
const CONFIG = path.join(DATA, 'config.json');
const BACKUPS = path.join(DATA, 'backups');
const LOG = path.join(DATA, 'last-run.log');
const RUNNING = path.join(DATA, 'running.json');   // exists while an update or a backup runs
const PLAN = path.join(DATA, 'run-plan.json');
const HOSTS = [`127.0.0.1:${PUBLIC_PORT}`, `localhost:${PUBLIC_PORT}`];
const ORIGINS = HOSTS.map(h => `http://${h}`);
const URL_SHOWN = `http://localhost:${PUBLIC_PORT}/`;
const FILES = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };

// A broken config.json stops the start instead of being replaced: it's the user's file
let config;
try { config = C.load(CONFIG); } catch (err) { console.error(`Can't start: ${err.message}`); process.exit(1); }
fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(KEY)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'wp-updater', '-f', KEY]);

const state = S.newState();
state.publicKey = fs.readFileSync(`${KEY}.pub`, 'utf8').trim();
applyConfig(config);
state.hardlinks = B.canHardlink(BACKUPS);
const clients = new Set();
let listing = [];     // listing processes in progress, one per server
let listingGen = 0;   // a restarted listing ignores what the killed one still prints
let measuring = { ids: [], procs: [] };   // the --sizes processes in progress, one per server
let sizesGen = 0;
let reader = null;    // interval that reads the run's log

function applyConfig(c) {
  config = c;
  state.config = c;
  const servers = {};
  for (const s of c.servers) servers[s.id] = state.servers[s.id] || { ssh: null, message: null, rsync: null };
  state.servers = servers;
}

// What updater.sh needs to work on one server
function envFor(srv) {
  const skip = config.excludedSites.filter(id => id.startsWith(`${srv.id}:`)).map(id => id.slice(9));
  return { WPU_SERVER: srv.id, WPU_HOST: srv.host, WPU_PORT: String(srv.port), WPU_USER: srv.user, WPU_PATH: srv.path,
           WPU_KEY: KEY, WPU_KNOWN_HOSTS: path.join(SSH_DIR, 'known_hosts'), WPU_EXCLUDE: config.exclude.join(','),
           WPU_SKIP: skip.join(':'), WPU_BACKUPS: BACKUPS };
}

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

// One listing per server, all at once. restart: kill the one in progress (listing only reads, it's safe to cut)
function list({ clearReview = false, restart = false } = {}) {
  if (state.run?.active || (listing.length && !restart)) return false;
  for (const p of listing) try { process.kill(-p.pid); } catch {}
  const gen = ++listingGen;
  const mine = () => gen === listingGen;
  S.startListing(state, { clearReview, servers: config.servers.map(s => s.id) });
  changed();
  listing = [];
  let left = config.servers.length, failed = false;
  if (!left) { S.endListing(state, Date.now(), 0); changed(); return true; }

  for (const srv of config.servers) {
    const proc = spawn('bash', [SCRIPT, '--json'], { cwd: path.dirname(SCRIPT), detached: true, env: { ...process.env, ...envFor(srv) } });
    listing.push(proc);
    readline.createInterface({ input: proc.stdout }).on('line', l => { if (mine()) { S.listingLine(state, l, Date.now()); log(l); changed(); } });
    readline.createInterface({ input: proc.stderr }).on('line', l => { if (mine()) { S.note(state, l); log(l); } });
    let closed = false;
    const finish = code => {
      if (closed || !mine()) return;
      closed = true;
      failed ||= code !== 0;
      if (--left) return;
      listing = [];
      S.endListing(state, Date.now(), failed ? 1 : 0);
      refreshBackups();
      changed();
    };
    proc.on('close', code => finish(code ?? 1));
    proc.on('error', err => { if (mine()) S.note(state, `Could not run ${SCRIPT}: ${err.message}`); finish(1); });
  }
  return true;
}

// What's on disk for each site, and which can't be backed up because another site (of any server with the
// same user@host) would use the same folder: the same address, or http:// and https:// of one host
function refreshBackups() {
  const dir = s => {
    const srv = config.servers.find(x => x.id === s.server);
    return srv && s.url && s.status !== 'excluded' && `${srv.user}@${srv.host}/${B.folderName(s.url)}`;
  };
  const sites = Object.values(state.sites);
  for (const s of sites) {
    const srv = config.servers.find(x => x.id === s.server);
    s.lastFull = srv && s.url ? B.readFull(BACKUPS, srv, s.url) : null;
    const mate = dir(s) && sites.find(o => o !== s && dir(o) === dir(s));
    s.backupNote = mate ? `Shares its backup folder with ${mate.url}` : null;
  }
}

// rsync is only known when the probe got through: without a connection it stays null
function probe(srv, done) {
  execFile('bash', [SCRIPT, '--probe'], { cwd: path.dirname(SCRIPT), timeout: 20000, env: { ...process.env, ...envFor(srv) } },
    (err, stdout) => err ? done(false, String(stdout).trim() || 'No response', null) : done(true, null, !/^no-rsync$/m.test(stdout)));
}

function probeAll() {
  for (const srv of config.servers) probe(srv, (ssh, message, rsync) => {
    if (!config.servers.includes(srv)) return;   // settings changed meanwhile: a newer probe is coming
    const st = state.servers[srv.id];
    if (st.ssh !== ssh || st.message !== message || st.rsync !== rsync) { Object.assign(st, { ssh, message, rsync }); changed(); }
  });
}

// A measuring replaces the one in progress: what that one didn't measure yet ends as unknown
function measure(ids) {
  for (const p of measuring.procs) try { process.kill(-p.pid); } catch {}
  S.endSizes(state, measuring.ids);
  const gen = ++sizesGen;
  const mine = () => gen === sizesGen;
  measuring = { ids, procs: [] };
  S.startSizes(state, ids);
  for (const srv of config.servers) {
    const own = ids.filter(id => id.startsWith(`${srv.id}:`));
    if (!own.length) continue;
    const proc = spawn('bash', [SCRIPT, '--sizes', ...own.map(id => id.slice(9))],
      { cwd: path.dirname(SCRIPT), detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...envFor(srv) } });
    measuring.procs.push(proc);
    readline.createInterface({ input: proc.stdout }).on('line', l => { if (mine()) { S.sizeLine(state, l); changed(); } });
    proc.on('error', () => {});   // 'close' follows
    proc.on('close', () => { if (mine()) { S.endSizes(state, own); changed(); } });
  }
  changed();
}

// Runs (updates and backups) go detached from the bridge (lib/run.js, one server after another): if the
// bridge stops, they keep going. The bridge only reads the log they write.
function start(ids, kind = 'update') {
  const now = Date.now();
  const groups = config.servers
    .map(srv => ({ env: envFor(srv), paths: ids.filter(id => id.startsWith(`${srv.id}:`)).map(id => id.slice(9)) }))
    .filter(g => g.paths.length);
  // Written before the run is marked as started: if data/ can't be written, nothing has changed
  fs.writeFileSync(PLAN, JSON.stringify({ script: SCRIPT, mode: kind === 'backup' ? '--backup' : '--apply', groups }));
  fs.writeFileSync(LOG, '');   // emptied before reading: so the previous run's END isn't read again
  S.startRun(state, ids, now, kind);
  // The newline before END puts it on its own line even if the script dies in the middle of one
  const proc = spawn('sh', ['-c', '"$0" "$1" "$2" > "$LOG" 2>&1; c=$?; printf "\\nEND code=%s\\n" "$c" >> "$LOG"', process.execPath, RUNNER, PLAN],
    { cwd: __dirname, detached: true, stdio: 'ignore', env: { ...process.env, LOG } });
  proc.unref();
  fs.writeFileSync(RUNNING, JSON.stringify({ pid: proc.pid, sites: ids, start: now, kind }));
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
  // After an update, a listing confirms the sites ended up up to date. A backup only changed what's on
  // disk, unless the bridge started while it ran: then nothing was listed yet
  if (state.run.kind === 'update' || state.checked === null) list();
  else { refreshBackups(); changed(); }
}

// Is that pid still our run? After a reboot (or a container restart) that number may belong to another process
function isOurs(pid) {
  try {
    const proc = `/proc/${pid}/cmdline`;   // Linux / Docker, where `ps` may not exist
    const cmd = fs.existsSync(proc) ? fs.readFileSync(proc, 'utf8') : execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes(RUNNER);
  } catch { return false; }
}

// On start: if a run was left over, pick it up again. Returns true if it already took care of the listing.
function recover() {
  let r;
  try { r = JSON.parse(fs.readFileSync(RUNNING, 'utf8')); } catch { return false; }
  let text = '';
  try { text = fs.readFileSync(LOG, 'utf8'); } catch {}
  S.startRun(state, r.sites, r.start, r.kind || 'update');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  for (const l of complete.split('\n')) S.runLine(state, l, Date.now());
  // Everything replayed has the same time: those durations are useless for estimating the time left
  Object.assign(state.run, { durations: [], siteStart: null });

  if (!state.run.active) { finishRun(); return true; }                      // finished while the bridge was closed
  if (isOurs(r.pid)) { readLog(Buffer.byteLength(complete)); return true; }  // still running

  // Died without finishing: the site left halfway goes to review (or, in a backup, failed)
  S.closeRun(state, null);
  state.run.interrupted = true;
  fs.unlinkSync(RUNNING);
  return false;
}

// ---- API ----

function update(res, body) {
  if (state.run?.active || listing.length) return reply(res, 409);
  const ids = body?.sites;
  const valid = id => typeof id === 'string' && C.SITE_ID.test(id) && config.servers.some(s => s.id === id.slice(0, 8))
    && state.sites[id]?.pending.length > 0 && ['pending', 'review'].includes(state.sites[id].status);
  if (!Array.isArray(ids) || !ids.length || !ids.every(valid)) return reply(res, 400);
  start([...new Set(ids)]);
  reply(res, 202);
}

// Why nothing else can start now, or null
function busy() {
  if (state.run?.active) return `${state.run.kind === 'backup' ? 'A backup' : 'An update'} is running. Try again when it finishes.`;
  return listing.length ? 'The sites are being checked. Try again when it finishes.' : null;
}

// Copying only reads: duplicates can be copied. A site needs its address (its folder is named after it),
// a server that answers and has rsync, and a folder of its own
function backup(res, body) {
  if (busy()) return json(res, 409, { error: busy() });
  const ids = body?.sites;
  const valid = id => {
    const s = typeof id === 'string' && C.SITE_ID.test(id) && state.sites[id];
    const srv = s && config.servers.find(x => x.id === s.server) && state.servers[s.server];
    return !!srv && srv.ssh !== false && srv.rsync !== false && !!s.url
      && !['excluded', 'checking', 'error'].includes(s.status) && s.backupNote === null;
  };
  if (!Array.isArray(ids) || !ids.length || !ids.every(valid)) return json(res, 400, { error: "These sites can't be backed up right now." });
  start([...new Set(ids)], 'backup');
  reply(res, 202);
}

function sizes(res, body) {
  if (busy()) return json(res, 409, { error: busy() });
  const ids = body?.sites;
  const valid = id => typeof id === 'string' && C.SITE_ID.test(id) && !!state.sites[id] && config.servers.some(s => s.id === id.slice(0, 8));
  if (!Array.isArray(ids) || !ids.length || !ids.every(valid)) return json(res, 400, { error: "These sites can't be measured." });
  measure([...new Set(ids)]);
  reply(res, 202);
}

function saveConfig(res, body) {
  if (state.run?.active) return json(res, 409, { error: busy() });
  let next;
  try { next = C.validate(body); } catch (err) { return json(res, 400, { error: err.message }); }
  C.save(CONFIG, next);
  applyConfig(next);
  list({ clearReview: true, restart: true });
  probeAll();
  changed();
  json(res, 200, { config: next });
}

function testServer(res, body) {
  let srv;
  try { [srv] = C.validate({ servers: [{ ...body, name: 'test', id: '00000000' }] }).servers; }
  catch (err) { return json(res, 400, { error: err.message }); }
  probe(srv, (ok, message, rsync) =>
    json(res, 200, { ok, message: !ok ? message : rsync ? 'OK' : "OK, but rsync is missing: full backups won't work on this server." }));
}

// ---- HTTP ----

function reply(res, code) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(code)); }
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

function withBody(req, res, handle) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return reply(res, 400); }
    // A handler that throws (data/ can't be written, say) answers 500 instead of stopping the bridge
    try { handle(res, data); } catch (err) {
      console.error(err);
      json(res, 500, { error: err.syscall ? `Can't write to the data folder (${err.code}). See Troubleshooting in the README.` : err.message });
    }
  });
}

const server = http.createServer((req, res) => {
  if (!HOSTS.includes(req.headers.host)) return reply(res, 403);   // stops DNS rebinding: other websites can't talk to localhost
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

  if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res);
  // A form on another website can't add a custom header without CORS, and CORS is never enabled here
  if (req.method !== 'POST' || req.headers['x-wpu'] !== '1' || (req.headers.origin && !ORIGINS.includes(req.headers.origin)))
    return reply(res, 403);
  if (url.pathname === '/api/list') return reply(res, list({ clearReview: true }) ? 202 : 409);
  if (url.pathname === '/api/update') return withBody(req, res, update);
  if (url.pathname === '/api/backup') return withBody(req, res, backup);
  if (url.pathname === '/api/sizes') return withBody(req, res, sizes);
  if (url.pathname === '/api/config') return withBody(req, res, saveConfig);
  if (url.pathname === '/api/test') return withBody(req, res, testServer);
  reply(res, 404);
});

server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`WP Updater is already running: ${URL_SHOWN}`);
  process.exit(0);
});

server.listen(PORT, BIND, () => {
  console.log(`WP Updater: ${URL_SHOWN}`);
  probeAll();
  setInterval(probeAll, 60000);
  if (!recover()) list();
});
