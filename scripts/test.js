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

const files = walk(path.join(__dirname, '..', 'src'));
const result = spawnSync('npx', ['tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
