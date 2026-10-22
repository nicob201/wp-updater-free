// Settings the user edits from the page: servers, excluded plugins/themes, excluded sites.
// Everything here ends up in ssh arguments or remote bash commands, so it's validated strictly:
// validate() throws an Error whose message is shown to the user as is.
const fs = require('node:fs');
const crypto = require('node:crypto');

const RE_ID = /^[a-f0-9]{8}$/;
const RE_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;   // hostname or IPv4, never starts with "-"
const RE_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const RE_PATH = /^(~|\/)[A-Za-z0-9._\/~-]*$/;
const RE_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SITE_ID = /^[a-f0-9]{8}:\/[A-Za-z0-9._\/~-]+$/;   // "<serverId>:<absolute path>"
const MAX_EXCLUDE = 200;

const defaults = () => ({ servers: [], exclude: [], excludedSites: [] });
const newId = () => crypto.randomBytes(4).toString('hex');
const list = (v, what) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${what} must be a list.`);
  return v;
};

function server(s) {
  if (!s || typeof s !== 'object') throw new Error('Each server must be an object.');
  const name = String(s.name ?? '').trim();
  if (!name || name.length > 60) throw new Error('Each server needs a name of up to 60 characters.');
  const bad = what => new Error(`Server "${name}": invalid ${what}.`);
  const id = s.id === undefined || s.id === '' ? newId() : s.id;
  if (!RE_ID.test(id)) throw bad('id');
  if (typeof s.host !== 'string' || !RE_HOST.test(s.host)) throw bad('host');
  const port = s.port === undefined || s.port === '' ? 22 : /^\d+$/.test(String(s.port)) ? Number(s.port) : NaN;
  if (!(port >= 1 && port <= 65535)) throw bad('port (1-65535)');
  if (typeof s.user !== 'string' || !RE_USER.test(s.user)) throw bad('user');
  const path = s.path ?? '';
  if (typeof path !== 'string' || (path && (!RE_PATH.test(path) || path.split('/').includes('..')))) throw bad('sites path');
  return { id, name, host: s.host, port, user: s.user, path };
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  const servers = list(input.servers, 'Servers').map(server);
  const seen = new Map();
  for (const s of servers) {
    const key = `${s.user}@${s.host}:${s.port}`;
    if (seen.has(key)) throw new Error(`"${seen.get(key)}" and "${s.name}" are the same server (${key}).`);
    seen.set(key, s.name);
  }

  const exclude = [...new Set(list(input.exclude, 'Excluded plugins and themes'))];
  for (const slug of exclude)
    if (typeof slug !== 'string' || !RE_SLUG.test(slug)) throw new Error(`"${slug}" is not a valid plugin or theme name (use its slug, e.g. elementor-pro).`);
  if (exclude.length > MAX_EXCLUDE) throw new Error(`At most ${MAX_EXCLUDE} excluded plugins and themes.`);

  const ids = new Set(servers.map(s => s.id));
  const excludedSites = [...new Set(list(input.excludedSites, 'Excluded sites'))];
  for (const id of excludedSites)
    if (typeof id !== 'string' || !SITE_ID.test(id)) throw new Error(`"${id}" is not a valid site.`);

  // Sites of a server that was just removed are dropped instead of rejected. Unknown keys (like the old
  // fullBackup switch) are dropped too
  return { servers, exclude, excludedSites: excludedSites.filter(id => ids.has(id.slice(0, 8))) };
}

function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return defaults();
    throw new Error(`Can't read the config file ${file}: ${err.message}`);
  }
  try { return validate(JSON.parse(text)); } catch (err) {
    throw new Error(`The config file ${file} is invalid: ${err.message}`);
  }
}

// Written to a temporary file and renamed: a crash halfway never leaves a cut config behind
function save(file, config) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

module.exports = { validate, load, save, newId, SITE_ID };
