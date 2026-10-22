// Turns what updater.sh prints into the state the page draws.
// Every function mutates `state` and never throws on odd lines
// (PHP notices, truncated JSON, blank lines): it ignores them.

const MAX_LOG = 500;
const RE_SITE = /^===== \[\d+\/\d+\] (\S+)$/;
const RE_STEP = /^== (\S+): (.*)$/;
const RE_END = /^END code=(\d+)$/;
const RE_DOWNLOAD = /\/(plugin|theme)\/([^/]+?)\.\d[^/]*\.zip/;

function newState() {
  return { checked: null, listing: false, servers: {}, sites: {}, run: null, log: [], config: null, publicKey: '' };
}

// Site id = "<server id>:<path on the server>"; server ids are always 8 characters
// Full backups live apart from the update status: lastFull is the copy on disk ({ date, bytes }), size what a
// copy would take, backup the site's part in the current or last backup run, and backupNote why it can't be copied
function newSite(id) {
  return { id, server: id.slice(0, 8), path: id.slice(9), url: null, db: null, wp: null, status: 'checking',
           pending: [], skipped: [], unavailable: [], result: [], step: null, downloading: null, progress: 0, reason: null,
           lastFull: null, size: null, backup: null, backupNote: null };
}

function note(state, line) {
  state.log.push(line);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function readJSON(line) {
  if (!line.startsWith('{')) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// Two installs that share a database (same name, host and table prefix) are copies of one site:
// updating either runs update-db on the live database. Same for two installs with the same address.
// Both are flagged and left alone until the user excludes one of them.
const DUP_POOL = ['pending', 'up-to-date', 'duplicate'];
function markDuplicates(state) {
  const pool = Object.values(state.sites).filter(s => DUP_POOL.includes(s.status));
  const dbKey = s => s.db && `${s.server}|${s.db.name}|${s.db.host}|${s.db.prefix}`;
  const urlKey = s => s.url && s.url.toLowerCase().replace(/\/+$/, '');
  const mate = (s, key) => key(s) && pool.find(o => o !== s && key(o) === key(s));
  for (const s of pool) {
    const db = mate(s, dbKey), url = mate(s, urlKey);
    if (db) Object.assign(s, { status: 'duplicate', reason: `Shares its database with ${db.url || db.path}` });
    else if (url) Object.assign(s, { status: 'duplicate', reason: `Same address as ${url.path}` });
    else if (s.status === 'duplicate') Object.assign(s, { status: s.pending.length ? 'pending' : 'up-to-date', reason: null });
  }
}

const toItem = type => p => ({ type, name: p.name, active: p.status !== 'inactive', current: p.version, next: p.update_version });
const newer = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }) > 0;
// wp core check-update may offer the branch's minor update and a major one; wp core update installs the highest
const newest = core => [...core].sort((a, b) => String(b.version).localeCompare(String(a.version), 'en', { numeric: true })).slice(0, 1);
// No "update" field: an older WP-CLI, asked for available updates only
const canUpdate = p => !p.update || p.update === 'available';
// WP-CLI marks an update "unavailable" when the new version needs a newer WordPress or PHP. The site's
// WordPress version is known; PHP is the other reason (the one WP-CLI runs with over SSH)
const toUnavailable = (type, wp) => p => ({ type, name: p.name, current: p.version, next: p.update_version,
  needs: p.requires && newer(p.requires, wp) ? `WordPress ${p.requires}` : p.requires_php ? `PHP ${p.requires_php}` : null });

function listingLine(state, line, now) {
  note(state, line);
  const d = readJSON(line);
  if (!d) return;

  // What a server has: its sites become exactly these; the excluded ones aren't analyzed
  if (typeof d.server === 'string' && Array.isArray(d.sites)) {
    state.listing = true;
    const ids = d.sites.map(p => `${d.server}:${p}`);
    const skipped = new Set(Array.isArray(d.skipped) ? d.skipped.map(p => `${d.server}:${p}`) : []);
    for (const s of Object.values(state.sites))
      if (s.server === d.server && !ids.includes(s.id)) delete state.sites[s.id];
    for (const id of ids) {
      const s = state.sites[id] || (state.sites[id] = newSite(id));
      if (skipped.has(id)) Object.assign(s, { status: 'excluded', pending: [], skipped: [], unavailable: [], reason: null });
      else if (s.status !== 'review') s.status = 'checking';   // review stays until the next run
    }
    markDuplicates(state);
    return;
  }

  const s = state.sites[d.site];
  if (!s || s.status === 'excluded') return;
  if (d.error) { Object.assign(s, { status: 'error', reason: String(d.error), pending: [], skipped: [], unavailable: [] }); markDuplicates(state); return; }
  s.url = typeof d.url === 'string' ? d.url : null;
  s.db = d.db && typeof d.db === 'object' ? d.db : null;
  s.wp = typeof d.wp === 'string' ? d.wp : null;

  const exclude = Array.isArray(d.exclude) ? d.exclude : [];
  const plugins = Array.isArray(d.plugins) ? d.plugins : [], themes = Array.isArray(d.themes) ? d.themes : [];
  const all = [
    ...(Array.isArray(d.core) ? newest(d.core) : []).map(c =>
      ({ type: 'core', name: 'WordPress', active: true, current: d.wp, next: c.version })),
    ...plugins.filter(canUpdate).map(toItem('plugin')),
    ...themes.filter(canUpdate).map(toItem('theme')),
  ];
  const unavailable = p => p.update === 'unavailable';
  s.unavailable = [...plugins.filter(unavailable).map(toUnavailable('plugin', d.wp)),
                   ...themes.filter(unavailable).map(toUnavailable('theme', d.wp))];
  s.pending = all.filter(i => !exclude.includes(i.name));
  s.skipped = all.filter(i => exclude.includes(i.name));
  if (s.status !== 'review') { s.status = s.pending.length ? 'pending' : 'up-to-date'; s.reason = null; }
  markDuplicates(state);
}

// When a listing starts everything goes to "checking" (except review): if the listing fails silently,
// nothing is left showing stale pending updates as if they were current
// clearReview: when the user checks by hand they've already seen the warning; the automatic listing
// after a run doesn't clear it, so a broken site isn't hidden
// servers: the ids still configured; sites of any other server are dropped
function startListing(state, { clearReview = false, servers = null } = {}) {
  state.listing = true;
  for (const s of Object.values(state.sites)) {
    if (servers && !servers.includes(s.server)) { delete state.sites[s.id]; continue; }
    if (s.status === 'excluded' || (s.status === 'review' && !clearReview)) continue;
    s.status = 'checking';
    s.reason = null;
  }
}

function endListing(state, now, code = 0) {
  state.listing = false;
  if (code === 0) state.checked = now;
  for (const s of Object.values(state.sites))
    if (s.status === 'checking') Object.assign(s, { status: 'error', reason: 'no response', pending: [], skipped: [], unavailable: [] });
  markDuplicates(state);
}

// kind 'backup' copies the sites: their update status, pending updates and result stay as they are.
// A new backup run clears what the last one left on every site
function startRun(state, ids, now, kind = 'update') {
  state.run = { active: true, kind, sites: [...ids], current: null, n: 0, start: now,
                siteStart: null, durations: [], done: [], code: null, interrupted: false };
  if (kind === 'backup') for (const s of Object.values(state.sites)) s.backup = null;
  for (const id of ids) {
    const s = state.sites[id] || (state.sites[id] = newSite(id));
    if (kind === 'backup') s.backup = { status: 'queued', step: null, reason: null };
    else Object.assign(s, { status: 'queued', result: [], step: null, downloading: null, progress: 0, reason: null });
  }
}

function backupLine(state, r, line, now) {
  let m;
  if ((m = line.match(RE_SITE))) {
    r.n += 1; r.current = m[1]; r.siteStart = now;
    const s = state.sites[m[1]] || (state.sites[m[1]] = newSite(m[1]));
    s.backup = { status: 'copying', step: null, reason: null };
    return;
  }
  if ((m = line.match(RE_END))) { closeRun(state, Number(m[1])); return; }
  const s = r.current && state.sites[r.current];
  if (!s || !(m = line.match(RE_STEP)) || m[1] !== s.id) return;
  const t = m[2];
  if (t === 'database backup') s.backup.step = 'database';
  else if (t === 'copying files') s.backup.step = 'files';
  else if (t === 'OK') {
    s.backup = { status: 'done', step: null, reason: null };
    r.done.push(s.id);
    if (r.siteStart !== null) { r.durations.push(now - r.siteStart); r.siteStart = null; }
  } else s.backup = { status: 'failed', step: null, reason: t };
}

function runLine(state, line, now) {
  note(state, line);
  const r = state.run;
  if (!r) return;
  if (r.kind === 'backup') return backupLine(state, r, line, now);
  let m;

  // Counted here, not read from the line: one run spans one script call per server
  if ((m = line.match(RE_SITE))) {
    r.n += 1; r.current = m[1]; r.siteStart = now;
    const s = state.sites[m[1]] || (state.sites[m[1]] = newSite(m[1]));
    Object.assign(s, { status: 'updating', step: null, downloading: null, progress: 0 });
    return;
  }
  if ((m = line.match(RE_END))) { closeRun(state, Number(m[1])); return; }

  const s = r.current && state.sites[r.current];
  if (!s) return;
  const stepSize = 1 / (s.pending.length + 2);

  if ((m = line.match(RE_STEP)) && m[1] === s.id) {
    const t = m[2];
    if (t === 'database backup') s.step = 'backup';
    else if (t === 'copying files') s.step = 'files';
    else if (t === 'updating') { s.step = 'updating'; s.progress = stepSize; }
    else {
      if (t !== 'OK') s.reason = s.status === 'review' ? `${s.reason} · ${t}` : t;
      // The script checks the site even if the update failed: an OK doesn't hide an earlier error
      s.status = t === 'OK' && s.status !== 'review' ? 'done' : 'review';
      if (s.status === 'done') { s.progress = 1; r.done.push(s.id); }
      s.step = null; s.downloading = null;
      if (t === 'OK' && r.siteStart !== null) { r.durations.push(now - r.siteStart); r.siteStart = null; }
    }
    return;
  }

  if (line.startsWith('Downloading update from')) {
    const d = line.match(RE_DOWNLOAD);
    if (d) s.downloading = d[2];
    s.progress = Math.min(0.95, s.progress + stepSize);
    return;
  }

  const f = line.split('\t');
  if (f.length === 4 && f[3] === 'Updated') {
    const p = s.pending.find(i => i.name === f[0]);
    s.result.push({ type: p ? p.type : 'plugin', name: f[0], before: f[1], after: f[2] });
    return;
  }
  if (line === 'Success: WordPress updated successfully.') {
    const p = s.pending.find(i => i.type === 'core');
    if (p) s.result.push({ type: 'core', name: 'WordPress', before: p.current, after: p.next });
  }
}

// Closes the run (with END, or with code null if it died without END): the site left halfway
// goes to review and the ones still queued go back to their previous status, untouched.
// In a backup run the site left halfway failed (its previous copy is still there), and the queued ones had no part
function closeRun(state, code) {
  const r = state.run;
  Object.assign(r, { code, active: false, current: null });
  for (const id of r.sites) {
    const s = state.sites[id];
    if (!s) continue;
    if (r.kind === 'backup') {
      if (s.backup?.status === 'copying') s.backup = { status: 'failed', step: null, reason: 'the backup stopped halfway' };
      else if (s.backup?.status === 'queued') s.backup = null;
    } else if (s.status === 'updating')
      Object.assign(s, { status: 'review', reason: 'the update stopped halfway', step: null, downloading: null });
    else if (s.status === 'queued') s.status = s.pending.length ? 'pending' : 'up-to-date';
  }
}

// Sizes are measured apart from any run, and never go into the log
function startSizes(state, ids) {
  for (const id of ids) if (state.sites[id]) state.sites[id].size = { status: 'measuring' };
}

function sizeLine(state, line) {
  const d = readJSON(line);
  const s = d && state.sites[d.site];
  if (!s) return;
  if (Number.isSafeInteger(d.bytes) && d.bytes >= 0) s.size = { status: 'done', bytes: d.bytes };
  else if (d.error) s.size = { status: 'error' };
}

// A measuring that ended without an answer for a site (dead server, killed) leaves its size unknown
function endSizes(state, ids) {
  for (const id of ids) if (state.sites[id]?.size?.status === 'measuring') state.sites[id].size = { status: 'error' };
}

module.exports = { newState, note, startListing, listingLine, endListing, startRun, runLine, closeRun, startSizes, sizeLine, endSizes };
