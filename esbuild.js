const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 is bundled. Its optional native add-ons are loaded inside try/catch and
  // fall back to pure JavaScript, so they stay external and are not shipped.
  external: ['vscode', 'cpu-features', '*.node'],
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
