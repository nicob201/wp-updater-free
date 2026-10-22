// Runs one update or backup across several servers, one after another: node lib/run.js <plan.json>
// server.js starts it detached, so it keeps going if the bridge stops; its output goes to the run log.
// Plan: { script, mode: '--apply' | '--backup', groups: [{ env: { WPU_*… }, paths: [site paths] }] }
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let failed = false;
for (const g of plan.groups) {
  const r = spawnSync('bash', [plan.script, plan.mode || '--apply', ...g.paths], { stdio: 'inherit', env: { ...process.env, ...g.env } });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
