// Turns what updater.sh prints into the state the page draws.
// Every function mutates `state` and never throws on odd lines
// (PHP notices, truncated JSON, blank lines): it ignores them.

const MAX_LOG = 500;
const RE_SITE = /^===== \[(\d+)\/\d+\] (\S+)$/;
const RE_STEP = /^== (\S+): (.*)$/;
const RE_END = /^END code=(\d+)$/;
const RE_DOWNLOAD = /\/(plugin|theme)\/([^/]+?)\.\d[^/]*\.zip/;

function newState() {
  return { checked: null, listing: false, ssh: null, sites: {}, run: null, log: [] };
}

function newSite(id) {
  return { id, status: 'checking', pending: [], skipped: [], result: [],
           step: null, downloading: null, progress: 0, reason: null };
}

function note(state, line) {
  state.log.push(line);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function readJSON(line) {
  if (!line.startsWith('{')) return null;
  try { return JSON.parse(line); } catch { return null; }
}

const toItem = type => p => ({ type, name: p.name, active: p.status !== 'inactive', current: p.version, next: p.update_version });

function listingLine(state, line, now) {
  note(state, line);
  const d = readJSON(line);
  if (!d) return;

  if (Array.isArray(d.sites)) {
    state.listing = true;
    const sites = {};
    for (const id of d.sites) {
      const s = state.sites[id] || newSite(id);
      if (s.status !== 'review') s.status = 'checking';   // review stays until the next run
      sites[id] = s;
    }
    state.sites = sites;
    return;
  }

  const s = state.sites[d.site];
  if (!s) return;
  if (d.error) { Object.assign(s, { status: 'error', reason: String(d.error), pending: [], skipped: [] }); return; }

  const exclude = Array.isArray(d.exclude) ? d.exclude : [];
  const all = [
    ...(Array.isArray(d.core) ? d.core.slice(0, 1) : []).map(c =>
      ({ type: 'core', name: 'WordPress', active: true, current: d.wp, next: c.version })),
    ...(Array.isArray(d.plugins) ? d.plugins : []).map(toItem('plugin')),
    ...(Array.isArray(d.themes) ? d.themes : []).map(toItem('theme')),
  ];
  s.pending = all.filter(i => !exclude.includes(i.name));
  s.skipped = all.filter(i => exclude.includes(i.name));
  if (s.status !== 'review') { s.status = s.pending.length ? 'pending' : 'up-to-date'; s.reason = null; }
}

// When a listing starts everything goes to "checking" (except review): if the listing fails silently,
// nothing is left showing stale pending updates as if they were current
// clearReview: when the user checks by hand they've already seen the warning; the automatic listing
// after a run doesn't clear it, so a broken site isn't hidden
function startListing(state, { clearReview = false } = {}) {
  state.listing = true;
  for (const s of Object.values(state.sites)) {
    if (s.status === 'review' && !clearReview) continue;
    s.status = 'checking';
    s.reason = null;
  }
}

function endListing(state, now, code = 0) {
  state.listing = false;
  if (code === 0) state.checked = now;
  for (const s of Object.values(state.sites))
    if (s.status === 'checking') Object.assign(s, { status: 'error', reason: 'no response', pending: [], skipped: [] });
}

function startRun(state, ids, now) {
  state.run = { active: true, sites: [...ids], current: null, n: 0, start: now,
                siteStart: null, durations: [], done: [], code: null, interrupted: false };
  for (const id of ids) {
    const s = state.sites[id] || (state.sites[id] = newSite(id));
    Object.assign(s, { status: 'queued', result: [], step: null, downloading: null, progress: 0, reason: null });
  }
}

function runLine(state, line, now) {
  note(state, line);
  const r = state.run;
  if (!r) return;
  let m;

  if ((m = line.match(RE_SITE))) {
    r.n = Number(m[1]); r.current = m[2]; r.siteStart = now;
    const s = state.sites[m[2]] || (state.sites[m[2]] = newSite(m[2]));
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
// goes to review and the ones still queued go back to their previous status, untouched
function closeRun(state, code) {
  const r = state.run;
  Object.assign(r, { code, active: false, current: null });
  for (const id of r.sites) {
    const s = state.sites[id];
    if (!s) continue;
    if (s.status === 'updating')
      Object.assign(s, { status: 'review', reason: 'the update stopped halfway', step: null, downloading: null });
    else if (s.status === 'queued') s.status = s.pending.length ? 'pending' : 'up-to-date';
  }
}

module.exports = { newState, note, startListing, listingLine, endListing, startRun, runLine, closeRun };
