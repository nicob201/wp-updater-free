// Draws the state the bridge (server.js) sends and asks it to list or update.
const $ = id => document.getElementById(id);
const opened = new Set();     // expanded rows, by site id
const rowCache = new Map();   // site id → last HTML drawn (so unchanged rows aren't redrawn)
let state = null;
let connected = false;
let needsLog = true;
let logLines = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const TYPES = { core: 'Core', plugin: 'Plugin', theme: 'Theme' };
const CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

async function post(route, body) {
  const r = await fetch(route, {
    method: 'POST',
    headers: { 'X-WPU': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r) alert('No connection with the local server. Start it again.');
  else if (r.status === 409) alert('A check or an update is already running. Wait for it to finish.');
  else if (r.status === 400) alert('That site has nothing pending anymore. Click "Check for updates" and try again.');
  else if (!r.ok) alert(`The local server answered ${r.status}.`);
}

function update(ids, question) {
  if (confirm(question)) post('/api/update', { sites: ids });
}

// ---- Drawing ----

function indicator(el, ok, text) {
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('bad', ok === false);
  el.lastElementChild.textContent = text;
}

// Short summary under the site name: what will be updated
function names(items) {
  const n = items.map(i => i.name);
  return n.length > 3 ? `${n.slice(0, 3).join(', ')} +${n.length - 3}` : n.join(', ');
}

function rowHTML(s, canUpdate) {
  const open = opened.has(s.id);
  const updated = s.result.length ? `${s.result.length} updated` : '';
  let summary = '', cls, text;
  switch (s.status) {
    case 'checking': cls = 'st-gray st-checking'; text = 'Checking…'; break;
    case 'up-to-date': cls = 'st-ok'; text = 'Up to date'; summary = updated || 'Nothing pending'; break;
    case 'pending':
      cls = 'st-blue'; text = `${s.pending.length} pending`;
      summary = esc(names(s.pending));
      break;
    case 'queued': cls = 'st-gray'; text = 'Queued'; summary = 'Waiting for its turn'; break;
    case 'updating': {
      const what = s.downloading || (s.step === 'backup' ? 'backing up the database' : 'preparing');
      cls = 'st-run'; text = 'Updating';
      summary = `<span class="bar mini"><i style="width:${Math.round(s.progress * 100)}%"></i></span>${esc(what)}`;
      break;
    }
    case 'done': cls = 'st-ok'; text = 'Done'; summary = updated; break;
    case 'review': cls = 'st-err'; text = 'Check'; summary = esc(s.reason); break;
    case 'duplicate': cls = 'st-err'; text = 'Duplicate'; summary = esc(s.reason); break;
    default: cls = 'st-err'; text = 'Error'; summary = esc(s.reason);
  }
  const failed = s.status === 'review' || s.status === 'error';
  const can = canUpdate && s.pending.length > 0 && (s.status === 'pending' || s.status === 'review');
  return `
    <div class="row">
      <button class="toggle" type="button" aria-expanded="${open}" data-toggle="${esc(s.id)}">
        <span class="name">
          <span class="domain">${esc(s.url || s.path)}</span>
          <span class="summary${failed ? ' error' : ''}">${summary}</span>
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
  if (!parts.length) parts.push(`<p class="note">${s.reason ? esc(s.reason) : 'Nothing pending.'}</p>`);
  return parts.join('');
}

function listMessage(text) {
  rowCache.clear();
  delete $('sites').dataset.order;
  $('sites').innerHTML = `<p class="empty">${text}</p>`;
}

function drawList(sites, canUpdate) {
  const list = $('sites');
  if (!sites.length) {
    return listMessage(state.listing ? 'Looking for the sites…' : !state.config?.servers.length ? 'No servers yet.'
      : "Couldn't get the list of sites. Check the SSH connection.");
  }
  // If the set of sites changed everything is rebuilt; otherwise only the rows that changed (keeps focus)
  const order = sites.map(s => s.id).join('|');
  if (list.dataset.order !== order) {
    list.dataset.order = order;
    list.innerHTML = sites.map(s => `<article class="site" data-site="${esc(s.id)}"></article>`).join('');
    rowCache.clear();
  }
  for (const s of sites) {
    const html = rowHTML(s, canUpdate);
    if (rowCache.get(s.id) === html) continue;
    rowCache.set(s.id, html);
    const art = list.querySelector(`[data-site="${CSS.escape(s.id)}"]`);
    art.classList.toggle('open', opened.has(s.id));
    art.innerHTML = html;
  }
}

function drawProgress(r) {
  const box = $('progress');
  $('notice').hidden = !r?.interrupted;
  box.hidden = !r || r.interrupted;
  if (box.hidden) return;
  const total = r.sites.length;
  const current = r.current && state.sites[r.current];
  const finished = r.sites.filter(id => ['done', 'review'].includes(state.sites[id]?.status)).length;
  box.classList.toggle('finished', !r.active);
  box.classList.toggle('failed', !r.active && !!r.code);

  if (r.active) {
    $('progress-title').textContent = r.n ? `Updating ${r.n} of ${total}` : 'Preparing the update…';
    $('progress-detail').textContent = r.current ? `now: ${r.current}` : '';
    const partial = r.n ? (r.n - 1 + (current?.progress || 0)) / total : 0;
    $('progress-bar').style.width = `${Math.max(2, Math.round(partial * 100))}%`;
    if (r.durations.length) {
      const avg = r.durations.reduce((a, b) => a + b, 0) / r.durations.length;
      const min = Math.round((avg * (total - finished)) / 60000);
      $('progress-left').textContent = min < 1 ? '≈ less than 1 min' : `≈ ${min} min left`;
    } else $('progress-left').textContent = '';
  } else {
    const toCheck = r.sites.filter(id => ['review', 'error'].includes(state.sites[id]?.status)).length;
    $('progress-title').textContent = `Done: ${r.done.length} of ${total} updated`;
    $('progress-detail').textContent = [toCheck ? `${toCheck} to check.` : '',
      r.code ? `The update ended with an error (code ${r.code}): see the log.` : ''].join(' ').trim();
    $('progress-left').textContent = '';
    $('progress-bar').style.width = '100%';
  }
}

function render() {
  indicator($('srv'), connected, connected ? 'Local server OK' : 'Server stopped');
  if (!state) return;
  const r = state.run;
  const running = !!r?.active;
  const sites = Object.values(state.sites).filter(s => s.status !== 'excluded').sort((a, b) => a.id.localeCompare(b.id));
  const pending = sites.filter(s => s.status === 'pending');
  const servers = Object.values(state.servers);
  const ssh = servers.some(v => v.ssh === false) ? false : servers.length && servers.every(v => v.ssh) ? true : null;
  const canUpdate = connected && !running && !state.listing && ssh !== false;

  indicator($('ssh'), ssh, ssh === null ? 'Testing SSH…' : ssh ? 'SSH connected' : 'SSH disconnected');
  $('count').textContent = sites.length ? plural(sites.length, 'site', 'sites') : '';
  $('checked').textContent = state.listing ? 'Checking for updates…' : state.checked ? `Checked ${ago(state.checked)}` : '';
  $('check').disabled = !connected || state.listing || running;
  $('all').disabled = !canUpdate || !pending.length;
  document.title = running && r.n ? `(${r.n}/${r.sites.length}) WP Updater` : 'WP Updater';

  drawProgress(r);
  drawList(sites, canUpdate);
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

$('check').addEventListener('click', () => post('/api/list'));
$('all').addEventListener('click', () => {
  const ids = Object.values(state.sites).filter(s => s.status === 'pending').map(s => s.id);
  update(ids, ids.length === 1 ? 'Update 1 site?' : `Update ${ids.length} sites?`);
});
$('sites').addEventListener('click', e => {
  const button = e.target.closest('[data-update]');
  if (button) return update([button.dataset.update], `Update ${button.dataset.update}?`);
  const row = e.target.closest('[data-toggle]');
  if (!row) return;
  const id = row.dataset.toggle;
  opened.has(id) ? opened.delete(id) : opened.add(id);
  rowCache.delete(id);
  render();
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
