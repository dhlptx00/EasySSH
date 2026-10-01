const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = walk(path.join(__dirname, '..', 'src')).sort();
// Run tsx's CLI with this same node binary. Spawning `npx` needs a shell on
// Windows (npx is a .cmd shim) and fails there with ENOENT.
const tsx = require.resolve('tsx/cli');
const result = spawnSync(process.execPath, [tsx, '--test', ...files], { stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exit(result.status === null ? 1 : result.status);
