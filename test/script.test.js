const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A fake `ssh` first in PATH logs the options the real script called it with, and fails
function runWithFakeSsh(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-fake-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/bash\necho "$*" >> "$SSH_CALLS"\ncat > /dev/null\nexit 255\n', { mode: 0o755 });
  spawnSync(path.join(__dirname, '..', 'updater.sh'), args,
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SSH_CALLS: calls }, timeout: 10000 });
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
}

test('--json never asks for a password or hangs: BatchMode and timeouts on every ssh', () => {
  const calls = [...runWithFakeSsh(['--json']), ...runWithFakeSsh(['--json', 'x.test'])];
  assert.ok(calls.length >= 2, 'the script did not call ssh');
  for (const c of calls)
    for (const o of ['BatchMode=yes', 'ConnectTimeout=10', 'ServerAliveInterval=15'])
      assert.ok(c.includes(o), `missing ${o} in: ${c}`);
});
