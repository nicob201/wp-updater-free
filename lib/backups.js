// What the full backups on disk say. updater.sh writes them; this only reads.
// Layout: <root>/<user>@<host>/<folder named after the address>/full-backup/backup.json
const fs = require('node:fs');
const path = require('node:path');

// The same rule as site_dir in updater.sh: https://example.com/blog/ → example.com_blog
const folderName = url => url.replace(/^.*?:\/\//, '').replace(/[/:]/g, '_').replace(/_+$/, '');

// { date, bytes } of the site's full backup, or null if there's none (or it can't be read)
function readFull(root, srv, url) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, `${srv.user}@${srv.host}`, folderName(url), 'full-backup', 'backup.json'), 'utf8'));
    return typeof r.date === 'string' && Number.isSafeInteger(r.bytes) ? { date: r.date, bytes: r.bytes } : null;
  } catch { return null; }
}

// Without hardlinks a new copy can't share the unchanged files with the previous one (Docker Desktop's
// bind mounts have them, on Windows too)
function canHardlink(dir) {
  const a = path.join(dir, '.hardlink-check'), b = `${a}.2`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(a, '');
    fs.linkSync(a, b);
    return true;
  } catch { return false; } finally {
    for (const f of [a, b]) try { fs.rmSync(f, { force: true }); } catch {}
  }
}

module.exports = { folderName, readFull, canHardlink };
