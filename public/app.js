// Draws the state the bridge (server.js) sends, in two views: Sites (#) and Settings (#settings).
const $ = id => document.getElementById(id);
const opened = new Set();   // expanded rows, by site id
let drawn = new WeakMap();  // element → last HTML drawn (so unchanged parts aren't redrawn and keep focus)
let state = null;
let connected = false;
let needsLog = true;
let logLines = [];
let editing = null;         // id of the server in the form; null for a new one
const picked = new Set();   // sites chosen in the backup panel
let saving = Promise.resolve();

// Same patterns as lib/config.js, for instant feedback: the bridge checks everything again
const RE_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const RE_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const TYPES = { core: 'Core', plugin: 'Plugin', theme: 'Theme' };
const CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';
const OFFLINE = 'No connection with the local server. Start it again.';
// The hosting only fills in its usual port and says where each value is: it isn't saved
const HOSTINGS = {
  hostinger: [65002, 'hPanel → Advanced → SSH Access: turn SSH on and add the key under SSH keys. The same page shows the IP (host), port and username.'],
  cpanel: [22, 'cPanel → Security → SSH Access → Manage SSH Keys: import the key, then authorize it. Host is your domain, user is your cPanel username. Some hosts use another port or must turn on shell access first: ask yours.'],
  siteground: [18765, "Site Tools → Devs → SSH Keys Manager: import the key. Its SSH Credentials, in the key's menu, show the host, username and port."],
  other: [22, 'Add the key to ~/.ssh/authorized_keys of the account that owns the sites, e.g. with ssh-copy-id.'],
};
const ONBOARDING = `
  <div class="list onboarding">
    <h2>Connect your first server</h2>
    <ol class="steps">
      <li><strong>Copy your SSH key and add it to your server</strong>
        <span>Settings shows the key. Add it to the SSH keys of the account that owns your sites.</span></li>
      <li><strong>Add the server</strong>
        <span>Its host, port and that account's user. Test the connection, then save.</span></li>
    </ol>
    <a class="button primary" href="#settings">Open Settings</a>
  </div>`;

function setHTML(el, html) {
  if (drawn.get(el) === html) return;
  drawn.set(el, html);
  el.innerHTML = html;
}

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

// The bridge refuses POSTs without X-WPU: no other website can add that header
const post = (route, body) => fetch(route, {
  method: 'POST',
  headers: { 'X-WPU': '1', 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).catch(() => null);

async function act(route, body) {
  const r = await post(route, body);
  if (!r) alert(OFFLINE);
  else if (r.status === 409) alert('A check, an update or a backup is already running. Wait for it to finish.');
  else if (r.status === 400) alert('That site has nothing pending anymore. Click "Check for updates" and try again.');
  else if (!r.ok) alert((await r.json().catch(() => ({}))).error || `The local server answered ${r.status}.`);
}

// Settings calls: the bridge's answer, or { error } with a message to show
async function ask(route, body) {
  const r = await post(route, body);
  if (!r) return { error: OFFLINE };
  const data = await r.json().catch(() => ({}));
  return r.ok ? data : { error: data.error || `The local server answered ${r.status}.` };
}

// Every change sends the whole config. Changes run one after another, each on top of what the
// previous one saved, so two quick clicks can't undo each other. Resolves to true if it was saved.
function save(change, errorEl) {
  saving = saving.then(async () => {
    errorEl.textContent = '';
    const r = await ask('/api/config', change(structuredClone(state.config)));
    if (r.error) { errorEl.textContent = r.error; drawn = new WeakMap(); }   // redrawn: controls go back to the saved config
    else state.config = r.config;
    render();
    return !r.error;
  });
  return saving;
}

function update(ids, question) {
  if (confirm(question)) act('/api/update', { sites: ids });
}

const sshOk = s => state.servers[s.server]?.ssh !== false;
const updatable = () => Object.values(state.sites).filter(s => s.status === 'pending' && sshOk(s));

// ---- Sites view ----

function indicator(el, ok, text) {
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('bad', ok === false);
  el.lastElementChild.textContent = text;
}

function sshHTML(st) {
  const [cls, text] = st.ssh === true ? ['ok', 'SSH OK'] : st.ssh === false ? ['bad', 'SSH failed'] : ['', 'Testing SSH…'];
  return `<span class="indicator ${cls}"><i class="dot"></i><span>${text}</span></span>`;
}

// Short summary under the site name: what will be updated
function names(items) {
  const n = items.map(i => i.name);
  return n.length > 3 ? `${n.slice(0, 3).join(', ')} +${n.length - 3}` : n.join(', ');
}

const STEPS = { backup: 'backing up the database', files: 'copying files' };
const BACKUP_STEPS = { database: STEPS.backup, files: STEPS.files };
// What updater.sh says when a copy fails, in plain words (the live log has the details)
const BACKUP_REASONS = { 'backup failed (database)': "couldn't copy the database", 'backup failed (files)': "couldn't copy the files",
                         'backup failed (address)': "couldn't read the site's address",
                         'backup failed (folder)': "couldn't replace its previous backup. Close any window open in its backup folder and try again" };
const backupReason = b => esc(BACKUP_REASONS[b.reason] || b.reason);

function rowHTML(s, canUpdate) {
  const open = opened.has(s.id);
  const updated = s.result.length ? `${s.result.length} updated` : '';
  const cant = s.unavailable.length ? ` · ${s.unavailable.length} can't be updated here` : '';
  let summary = '', cls, text;
  switch (s.status) {
    case 'checking': cls = 'st-gray st-checking'; text = 'Checking…'; break;
    case 'up-to-date': cls = 'st-ok'; text = 'Up to date'; summary = (updated || 'Nothing pending') + cant; break;
    case 'pending':
      cls = 'st-blue'; text = `${s.pending.length} pending`;
      summary = esc(names(s.pending)) + cant;
      break;
    case 'queued': cls = 'st-gray'; text = 'Queued'; summary = 'Waiting for its turn'; break;
    case 'updating': {
      const what = s.downloading || STEPS[s.step] || 'preparing';
      cls = 'st-run'; text = 'Updating';
      summary = `<span class="bar mini"><i style="width:${Math.round(s.progress * 100)}%"></i></span>${esc(what)}`;
      break;
    }
    case 'done': cls = 'st-ok'; text = 'Done'; summary = updated; break;
    case 'review': cls = 'st-err'; text = 'Check'; summary = esc(s.reason); break;
    case 'duplicate': cls = 'st-err'; text = 'Duplicate'; summary = esc(s.reason); break;
    default: cls = 'st-err'; text = 'Error'; summary = esc(s.reason);
  }
  let failed = ['review', 'error', 'duplicate'].includes(s.status);
  // During a backup the status column shows the copy; the update status comes back when it ends
  const b = state.run?.active && state.run.kind === 'backup' ? s.backup : null;
  // (a site to check or a duplicate can be copied too: its progress isn't an error)
  if (b?.status === 'queued') [cls, text, summary, failed] = ['st-gray', 'Queued', 'Waiting for its turn', false];
  else if (b?.status === 'copying') [cls, text, summary, failed] = ['st-run', 'Backing up', BACKUP_STEPS[b.step] || 'preparing', false];
  else if (b?.status === 'done') [cls, text] = ['st-ok', 'Backed up'];
  else if (b?.status === 'failed') [cls, text, summary, failed] = ['st-err', 'Backup failed', backupReason(b), true];
  // Afterwards a failed copy stays in view until the next backup
  const backupFailed = !b && s.backup?.status === 'failed' ? `<span class="summary error">Backup failed: ${backupReason(s.backup)}</span>` : '';
  const can = canUpdate && s.pending.length > 0 && (s.status === 'pending' || s.status === 'review');
  return `
    <div class="row">
      <button class="toggle" type="button" aria-expanded="${open}" data-toggle="${esc(s.id)}">
        <span class="name">
          <span class="title"><span class="domain">${esc(s.url || s.path)}</span>${s.wp ? `<span class="badge">WP ${esc(s.wp)}</span>` : ''}</span>
          <span class="summary${failed ? ' error' : ''}">${summary}</span>${backupFailed}
        </span>
        <span class="site-status ${cls}"><i class="dot"></i>${text}</span>
        ${CHEVRON}
      </button>
      <span class="action">${can ? `<button class="button secondary small" type="button" data-update="${esc(s.id)}">Update</button>` : ''}</span>
    </div>
    ${open ? `<div class="details">${detailsHTML(s)}</div>` : ''}`;
}

function detailsHTML(s) {
  const parts = [];
  if (s.result.length) {
    parts.push(`<div><h3>What was updated</h3><div class="table"><table>
      <tr><th>Name</th><th>Before</th><th>Now</th></tr>
      ${s.result.map(r => `<tr><td>${esc(r.name)}</td><td class="version">${esc(r.before)}</td><td class="version next">${esc(r.after)}</td></tr>`).join('')}
    </table></div></div>`);
  }
  if (s.pending.length || s.skipped.length) {
    const row = (i, skipped) => `<tr${skipped ? ' class="skipped"' : ''}>
      <td>${TYPES[i.type] || esc(i.type)}</td><td>${esc(i.name)}</td><td>${i.active ? 'active' : 'inactive'}</td>
      <td class="version">${esc(i.current)}</td>${skipped ? '<td>excluded</td>' : `<td class="version next">${esc(i.next)}</td>`}</tr>`;
    parts.push(`<div><h3>Pending</h3><div class="table"><table>
      <tr><th>Type</th><th>Name</th><th>Status</th><th>Current</th><th>New</th></tr>
      ${s.pending.map(i => row(i, false)).join('')}${s.skipped.map(i => row(i, true)).join('')}
    </table></div><p class="note">+ translations, if any</p></div>`);
  }
  // Updates WP-CLI won't apply: the new version needs a newer WordPress or PHP than this site has
  if (s.unavailable.length) {
    parts.push(`<div><h3>Can't update here</h3><div class="table"><table>
      <tr><th>Type</th><th>Name</th><th>Current</th><th>New</th><th>Why</th></tr>
      ${s.unavailable.map(i => `<tr><td>${TYPES[i.type] || esc(i.type)}</td><td>${esc(i.name)}</td><td class="version">${esc(i.current)}</td>
        <td class="version">${esc(i.next)}</td><td>${i.needs ? `Needs ${esc(i.needs)}` : 'Not available on this server'}</td></tr>`).join('')}
    </table></div></div>`);
  }
  if (!parts.length) parts.push(`<p class="note">${s.reason ? esc(s.reason) : 'Nothing pending.'}</p>`);
  return parts.join('');
}

function groupHeadHTML(srv, st) {
  return `
    <span class="group-name"><strong>${esc(srv.name)}</strong><span class="mono muted">${esc(`${srv.user}@${srv.host}`)}</span></span>
    ${sshHTML(st)}
    ${st.ssh === false && st.message ? `<p class="group-error">${esc(st.message)}</p>` : ''}`;
}

// The sites of each server, in the order of the settings
const byServer = sites => state.config.servers.map(srv =>
  ({ srv, sites: sites.filter(s => s.server === srv.id).sort((a, b) => a.id.localeCompare(b.id)) }));

// One card per server
function drawList(sites, canUpdate) {
  const list = $('sites');
  const groups = byServer(sites);
  // If the set of servers or sites changed everything is rebuilt; otherwise only what changed (keeps focus)
  const order = groups.length ? groups.map(g => [g.srv.id, ...g.sites.map(s => s.id)].join(' ')).join('|') : 'none';
  if (list.dataset.order !== order) {
    list.dataset.order = order;
    list.innerHTML = groups.length ? groups.map(g => `
      <section class="list group" data-server="${g.srv.id}">
        <header class="group-head"></header>
        ${g.sites.length ? g.sites.map(s => `<article class="site" data-site="${esc(s.id)}"></article>`).join('') : '<p class="empty"></p>'}
      </section>`).join('') : ONBOARDING;
  }
  for (const g of groups) {
    const box = list.querySelector(`[data-server="${g.srv.id}"]`);
    const st = state.servers[g.srv.id] || {};
    setHTML(box.querySelector('.group-head'), groupHeadHTML(g.srv, st));
    if (!g.sites.length) {
      box.querySelector('.empty').textContent = state.listing ? 'Looking for the sites…'
        : st.ssh === false ? "Couldn't connect to this server." : 'No WordPress sites found';
    }
    for (const s of g.sites) {
      const art = box.querySelector(`[data-site="${CSS.escape(s.id)}"]`);
      art.classList.toggle('open', opened.has(s.id));
      setHTML(art, rowHTML(s, canUpdate && st.ssh !== false));
    }
  }
}

function drawProgress(r) {
  const box = $('progress');
  const backup = r?.kind === 'backup';
  $('notice').hidden = !r?.interrupted;
  $('notice').textContent = `The last ${backup ? 'backup' : 'update'} stopped before finishing. Check the log.`;
  box.hidden = !r || r.interrupted;
  if (box.hidden) return;
  const total = r.sites.length;
  const current = r.current && state.sites[r.current];
  const ended = s => (backup ? ['done', 'failed'].includes(s?.backup?.status) : ['done', 'review'].includes(s?.status));
  const finished = r.sites.filter(id => ended(state.sites[id])).length;
  box.classList.toggle('finished', !r.active);
  box.classList.toggle('failed', !r.active && !!r.code);

  if (r.active) {
    $('progress-title').textContent = r.n ? `${backup ? 'Backing up' : 'Updating'} ${r.n} of ${total}`
      : backup ? 'Preparing the backup…' : 'Preparing the update…';
    $('progress-detail').textContent = r.current ? `now: ${current?.url || r.current}` : '';
    const partial = r.n ? (r.n - 1 + (backup ? 0 : current?.progress || 0)) / total : 0;
    $('progress-bar').style.width = `${Math.max(2, Math.round(partial * 100))}%`;
    if (r.durations.length) {
      const avg = r.durations.reduce((a, b) => a + b, 0) / r.durations.length;
      const min = Math.round((avg * (total - finished)) / 60000);
      $('progress-left').textContent = min < 1 ? '≈ less than 1 min' : `≈ ${min} min left`;
    } else $('progress-left').textContent = '';
  } else if (backup) {
    const failed = r.sites.filter(id => state.sites[id]?.backup?.status === 'failed').length;
    $('progress-title').textContent = `Done: ${r.done.length} of ${total} backed up`;
    $('progress-detail').textContent = failed ? `${failed} failed.` : r.code ? `The backup ended with an error (code ${r.code}): see the log.` : '';
    $('progress-left').textContent = '';
    $('progress-bar').style.width = '100%';
  } else {
    const toCheck = r.sites.filter(id => ['review', 'error'].includes(state.sites[id]?.status)).length;
    $('progress-title').textContent = `Done: ${r.done.length} of ${total} updated`;
    $('progress-detail').textContent = [toCheck ? `${toCheck} to check.` : '',
      r.code ? `The update ended with an error (code ${r.code}): see the log.` : ''].join(' ').trim();
    $('progress-left').textContent = '';
    $('progress-bar').style.width = '100%';
  }
}

function renderSites() {
  const r = state.run;
  const running = !!r?.active;
  const sites = Object.values(state.sites).filter(s => s.status !== 'excluded');
  const canUpdate = connected && !running && !state.listing;
  const excluded = state.config.excludedSites.length;

  $('count').textContent = sites.length ? plural(sites.length, 'site', 'sites') : '';
  $('checked').textContent = state.listing ? 'Checking for updates…' : state.checked ? `Checked ${ago(state.checked)}` : '';
  $('check').disabled = !connected || state.listing || running || !state.config.servers.length;
  $('all').disabled = !canUpdate || !updatable().length;
  $('excluded').hidden = !excluded;
  $('excluded').firstElementChild.textContent = `${plural(excluded, 'site', 'sites')} excluded`;

  drawProgress(r);
  drawBackups(sites, canUpdate);
  drawList(sites, canUpdate);
}

// ---- Full backups ----

// Decimal units, the ones disks and hosts show. A value that rounds to 1000 goes up a unit (not "1000 MB")
function size(n) {
  if (n >= 999.5e6) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 999.5e3) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
const day = iso => new Date(iso).toLocaleDateString();

// Why a site can't be copied, or '' (the bridge checks the same)
function cantBackUp(s) {
  const st = state.servers[s.server] || {};
  if (s.status === 'error' || !s.url) return "Couldn't check this site.";
  if (st.ssh === false) return "Can't connect to this server.";
  if (st.rsync === false) return 'rsync is missing on this server.';
  return s.backupNote || '';
}

// Only informs: never reads as a warning for someone who doesn't make copies
function backupsText(sites) {
  const dates = sites.filter(s => s.lastFull).map(s => s.lastFull.date).sort();
  if (!dates.length) return 'No full backups yet. You can make one whenever you want.';
  const never = sites.length - dates.length;
  return `Oldest full backup: ${day(dates[0])}${never ? ` · ${never} never backed up` : ''}`;
}

// The rows, under their server's name like in Settings; drawBackups fills in each one's size and last copy
function backupListHTML(groups) {
  const row = s => {
    const why = cantBackUp(s);
    const main = `<span class="item-main"><span class="domain">${esc(s.url || s.path)}</span>${why ? `<span class="mono muted">${esc(why)}</span>` : ''}</span>`;
    const box = why ? '<span class="no-check"></span>' : `<input type="checkbox" data-backup="${esc(s.id)}">`;
    const tag = why ? 'div' : 'label';
    return `<${tag} class="item${why ? ' off' : ''}" data-row="${esc(s.id)}">${box}${main}<span class="backup-size"></span><span class="backup-last"></span></${tag}>`;
  };
  return groups.map(g => `<div class="site-group"><h3>${esc(g.srv.name)}</h3>${g.sites.map(row).join('')}</div>`).join('')
    || '<p class="help">No sites to back up.</p>';
}

// No size yet (not measured, or the measuring couldn't start): blank, it isn't being measured
function sizeText(s) {
  const st = s.size?.status;
  return cantBackUp(s) ? '' : st === 'done' ? `about ${size(s.size.bytes)}` : st === 'measuring' ? 'measuring…' : st === 'error' ? 'unknown' : '';
}

function backupTotal(chosen) {
  if (!chosen.length) return '';
  const known = chosen.filter(s => s.size?.status === 'done');
  const waiting = chosen.some(s => s.size?.status === 'measuring') ? ' (still measuring)' : '';
  let t = `A full copy of ${plural(chosen.length, 'site', 'sites')}`;
  t += known.length ? `: about ${size(known.reduce((a, s) => a + s.size.bytes, 0))}${waiting} on this computer` : waiting;
  t += '. The first copy of a site takes the longest.';
  // Without hardlinks the new copy can't share the unchanged files with the previous one until it replaces it
  if (!state.hardlinks && chosen.some(s => s.lastFull)) t += " While it's copied, a site that already has a full backup needs room for both.";
  return t;
}

function drawBackups(sites, free) {
  const panel = $('backup-panel');
  // Hidden during the first listing, before the copies are read, and while no site's address is known: the copies
  // are found by address (no server and the welcome shows, or the bridge restarted during a run and nothing was listed yet)
  $('backups').hidden = (state.listing && state.checked === null) || !sites.some(s => s.url);
  if ($('backups').hidden) panel.hidden = true;
  $('backups-text').textContent = backupsText(sites);
  $('backup-open').disabled = !free || !sites.length;
  $('backup-open').setAttribute('aria-expanded', String(!panel.hidden));
  if (panel.hidden) return;

  const groups = byServer(sites).filter(g => g.sites.length);
  const shown = groups.flatMap(g => g.sites);
  const ok = new Set(shown.filter(s => !cantBackUp(s)).map(s => s.id));
  for (const id of picked) if (!ok.has(id)) picked.delete(id);
  const list = $('backup-list');
  // Rebuilt only when the rows change; sizes come in one by one while the user ticks, so they're filled in
  // without replacing the checkboxes (keeps focus and clicks)
  const rows = JSON.stringify(groups.map(g => [g.srv.name, g.sites.map(s => [s.id, s.url, cantBackUp(s)])]));
  if (list.dataset.rows !== rows) {
    list.dataset.rows = rows;
    list.innerHTML = backupListHTML(groups);
  }
  for (const s of shown) {
    const row = list.querySelector(`[data-row="${CSS.escape(s.id)}"]`);
    row.querySelector('.backup-size').textContent = sizeText(s);
    row.querySelector('.backup-last').textContent = s.lastFull ? day(s.lastFull.date) : 'never';
  }
  for (const box of list.querySelectorAll('[data-backup]')) box.checked = picked.has(box.dataset.backup);
  Object.assign($('backup-all'), { checked: ok.size > 0 && picked.size === ok.size, indeterminate: picked.size > 0 && picked.size < ok.size, disabled: !ok.size });
  const chosen = sites.filter(s => picked.has(s.id));
  $('backup-total').textContent = backupTotal(chosen);
  $('backup-start').textContent = `Back up ${plural(chosen.length, 'site', 'sites')}`;
  $('backup-start').disabled = !free || !chosen.length;
}

// ---- Settings view ----

function serverListHTML(c) {
  if (!c.servers.length) return '<p class="help">No servers yet.</p>';
  return c.servers.map(s => `
    <div class="item">
      <span class="item-main"><strong>${esc(s.name)}</strong>
        <span class="mono muted">${esc(`${s.user}@${s.host}:${s.port}`)} · ${esc(s.path || 'Home folder')}</span></span>
      ${sshHTML(state.servers[s.id] || {})}
      <span class="item-actions">
        <button class="button secondary small" type="button" data-edit="${s.id}" aria-label="Edit ${esc(s.name)}">Edit</button>
        <button class="button secondary small" type="button" data-delete="${s.id}" aria-label="Delete ${esc(s.name)}">Delete</button>
      </span>
    </div>`).join('');
}

function chipsHTML(c) {
  if (!c.exclude.length) return '<p class="help">Nothing excluded yet.</p>';
  return c.exclude.map(slug =>
    `<span class="chip">${esc(slug)}<button type="button" data-unexclude="${esc(slug)}" aria-label="Remove ${esc(slug)}">×</button></span>`).join('');
}

// Every site found on each server, excluded ones included (a site excluded before this listing has no url yet)
function excludedSitesHTML(c) {
  if (!c.servers.length) return '<p class="help">Add a server first.</p>';
  const ids = [...new Set([...Object.keys(state.sites), ...c.excludedSites])].sort();
  return c.servers.map(srv => {
    const rows = ids.filter(id => id.startsWith(`${srv.id}:`)).map(id => {
      const url = state.sites[id]?.url, path = id.slice(9);
      return `
        <label class="item">
          <span class="item-main"><span class="domain">${esc(url || path)}</span>${url ? `<span class="mono muted">${esc(path)}</span>` : ''}</span>
          <span class="check"><input type="checkbox" data-exclude-site="${esc(id)}"${c.excludedSites.includes(id) ? ' checked' : ''}> Exclude</span>
        </label>`;
    }).join('');
    return `<div class="site-group"><h3>${esc(srv.name)}</h3>${rows || `<p class="help">${state.listing ? 'Looking for the sites…' : 'No sites found.'}</p>`}</div>`;
  }).join('');
}

function renderSettings() {
  const locked = !!state?.run?.active;
  $('locked').hidden = !locked;
  $('locked').textContent = `Settings are locked while ${state?.run?.kind === 'backup' ? 'a backup' : 'an update'} is running.`;
  $('settings-fields').disabled = locked || !connected || !state;
  if (!state) return;
  const c = state.config;
  if ($('key').value !== state.publicKey) $('key').value = state.publicKey;
  setHTML($('server-list'), serverListHTML(c));
  setHTML($('chips'), chipsHTML(c));
  setHTML($('excluded-sites'), excludedSitesHTML(c));
}

function formServer() {
  const f = $('server-form').elements;
  return { name: f.name.value.trim(), host: f.host.value.trim(), port: f.port.value.trim(), user: f.user.value.trim(), path: f.path.value.trim() };
}

function serverProblem(s) {
  if (!s.name) return 'Give the server a name.';
  if (!RE_HOST.test(s.host)) return 'Invalid host: use a name like example.com or an IP address.';
  if (!/^\d+$/.test(s.port) || s.port < 1 || s.port > 65535) return 'Invalid port (1-65535).';
  if (!RE_USER.test(s.user)) return 'Invalid user: letters, numbers, ".", "_" and "-" only.';
  return '';
}

function openForm(srv) {
  const form = $('server-form');
  editing = srv?.id ?? null;
  form.reset();
  if (srv) for (const k of ['name', 'host', 'port', 'user', 'path']) form.elements[k].value = srv[k];
  hostingHelp();
  $('form-title').textContent = srv ? `Edit ${srv.name}` : 'Add server';
  $('form-error').textContent = $('test-result').textContent = '';
  form.hidden = false;
  $('add-server').hidden = true;
  form.elements.name.focus();
}

function hostingHelp() {
  const h = HOSTINGS[$('server-form').elements.hosting.value];
  $('hosting-help').hidden = !h;
  $('hosting-help').textContent = h?.[1] ?? '';
  return h;
}

function closeForm() {
  $('server-form').hidden = true;
  $('add-server').hidden = false;
  editing = null;
}

// ---- Both views ----

function render() {
  indicator($('srv'), connected, connected ? 'Local server OK' : 'Server stopped');
  const settings = location.hash === '#settings';
  $('view-sites').hidden = settings;
  $('view-settings').hidden = !settings;
  for (const [el, on] of [[$('to-sites'), !settings], [$('to-settings'), settings]])
    on ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current');
  renderSettings();
  if (!state) return;
  const r = state.run;
  document.title = r?.active && r.n ? `(${r.n}/${r.sites.length}) WP Updater` : 'WP Updater';
  renderSites();
}

// ---- Live log ----

function addLog(lines) {
  const pre = $('log-text');
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  logLines = logLines.concat(lines).slice(-500);
  pre.textContent = logLines.join('\n');
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

// ---- Events ----

window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });

$('check').addEventListener('click', () => act('/api/list'));
$('all').addEventListener('click', () => {
  const ids = updatable().map(s => s.id);
  update(ids, ids.length === 1 ? 'Update 1 site?' : `Update ${ids.length} sites?`);
});
$('sites').addEventListener('click', e => {
  const button = e.target.closest('[data-update]');
  if (button) {
    const s = state.sites[button.dataset.update];
    return update([s.id], `Update ${s.url || s.path}?`);
  }
  const row = e.target.closest('[data-toggle]');
  if (!row) return;
  const id = row.dataset.toggle;
  opened.has(id) ? opened.delete(id) : opened.add(id);
  render();
});

$('backup-open').addEventListener('click', async () => {
  const panel = $('backup-panel');
  panel.hidden = !panel.hidden;
  picked.clear();
  $('backup-error').textContent = '';
  render();
  if (panel.hidden) return;
  // Measured only when the panel opens, so listing and updating never wait for it
  const ids = Object.values(state.sites).filter(s => s.status !== 'excluded' && !cantBackUp(s)).map(s => s.id);
  const r = ids.length ? await ask('/api/sizes', { sites: ids }) : {};
  if (r.error) $('backup-error').textContent = r.error;
});
$('backup-cancel').addEventListener('click', () => { $('backup-panel').hidden = true; picked.clear(); render(); });
$('backup-list').addEventListener('change', e => {
  const id = e.target.dataset.backup;
  if (!id) return;
  e.target.checked ? picked.add(id) : picked.delete(id);
  render();
});
$('backup-all').addEventListener('change', e => {
  for (const box of $('backup-list').querySelectorAll('[data-backup]')) e.target.checked ? picked.add(box.dataset.backup) : picked.delete(box.dataset.backup);
  render();
});
$('backup-start').addEventListener('click', async () => {
  $('backup-error').textContent = '';
  const r = await ask('/api/backup', { sites: [...picked] });
  if (r.error) { $('backup-error').textContent = r.error; return; }
  $('backup-panel').hidden = true;
  picked.clear();
  render();
});

$('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(state.publicKey).then(() => {
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 2000);
  }, () => $('key').select());   // no clipboard access: leave it selected to copy by hand
});

$('add-server').addEventListener('click', () => openForm(null));
$('cancel').addEventListener('click', closeForm);
$('server-form').addEventListener('input', () => { $('form-error').textContent = $('test-result').textContent = ''; });
$('server-form').elements.hosting.addEventListener('change', () => {
  const h = hostingHelp();
  if (h) $('server-form').elements.port.value = h[0];
});
$('server-form').addEventListener('submit', async e => {
  e.preventDefault();
  const s = { ...formServer(), id: editing ?? undefined };
  const problem = serverProblem(s);
  $('form-error').textContent = problem;
  if (problem) return;
  const ok = await save(c => {
    const srv = { ...s, port: Number(s.port) };
    c.servers = s.id ? c.servers.map(o => (o.id === s.id ? srv : o)) : [...c.servers, srv];
    return c;
  }, $('form-error'));
  if (ok) closeForm();
});
$('test').addEventListener('click', async () => {
  const s = formServer();
  const out = $('test-result');
  const problem = serverProblem({ ...s, name: 'test' });
  $('form-error').textContent = problem;
  out.className = 'test-result';
  out.textContent = problem ? '' : 'Testing…';
  if (problem) return;
  const r = await ask('/api/test', { host: s.host, port: Number(s.port), user: s.user, path: s.path });
  out.textContent = r.error || r.message;
  out.classList.add(r.ok ? 'ok' : 'bad');
});
$('server-list').addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-delete]');
  if (edit) openForm(state.config.servers.find(s => s.id === edit.dataset.edit));
  if (!del) return;
  const srv = state.config.servers.find(s => s.id === del.dataset.delete);
  if (!confirm(`Delete the server "${srv.name}"? Nothing changes on the server itself.`)) return;
  if (editing === srv.id) closeForm();
  save(c => ({ ...c, servers: c.servers.filter(s => s.id !== srv.id) }), $('server-error'));
});

$('exclude-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('exclude-input');
  const slug = input.value.trim().toLowerCase();
  if (!slug) return;
  if (!RE_SLUG.test(slug)) {
    $('exclude-error').textContent = `"${slug}" is not a valid plugin or theme name (use its slug, e.g. elementor-pro).`;
    return;
  }
  if (await save(c => ({ ...c, exclude: [...c.exclude, slug] }), $('exclude-error'))) input.value = '';
});
$('chips').addEventListener('click', e => {
  const slug = e.target.closest('[data-unexclude]')?.dataset.unexclude;
  if (slug) save(c => ({ ...c, exclude: c.exclude.filter(x => x !== slug) }), $('exclude-error'));
});
$('excluded-sites').addEventListener('change', e => {
  const id = e.target.dataset.excludeSite, on = e.target.checked;
  if (id) save(c => ({ ...c, excludedSites: on ? [...c.excludedSites, id] : c.excludedSites.filter(x => x !== id) }), $('sites-error'));
});

// The browser reconnects on its own if the bridge restarts
const source = new EventSource('/api/events');
source.onopen = () => { connected = true; needsLog = true; render(); };
source.onerror = () => { connected = false; render(); };
source.addEventListener('state', e => {
  state = JSON.parse(e.data);
  if (needsLog) { logLines = []; addLog(state.log || []); needsLog = false; }
  render();
});
source.addEventListener('log', e => addLog([JSON.parse(e.data)]));
setInterval(render, 30000);
render();
