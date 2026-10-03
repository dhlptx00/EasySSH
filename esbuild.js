const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/**
 * Pageant support (Windows): ssh2 runs util/pagent.exe next to its own lib folder.
 * Bundled, __dirname is dist/, so point it at dist/pagent.exe and copy the helper there.
 */
const pageant = {
  name: 'ssh2-pageant',
  setup(build) {
    build.onLoad({ filter: /[\\/]ssh2[\\/]lib[\\/]agent\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const from = "resolve(__dirname, '..', 'util/pagent.exe')";
      if (!source.includes(from)) throw new Error('ssh2 agent.js changed: update the Pageant path rewrite in esbuild.js');
      return { contents: source.replace(from, "resolve(__dirname, 'pagent.exe')"), loader: 'js' };
    });
    build.onEnd(async () => {
      const helper = require.resolve('ssh2/util/pagent.exe');
      await fs.promises.mkdir('dist', { recursive: true });
      await fs.promises.copyFile(helper, path.join('dist', 'pagent.exe'));
    });
  },
};

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
  plugins: [pageant],
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
