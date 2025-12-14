import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const outdir = '../static';
const isWatch = process.argv.includes('--watch');

// Ensure output directory exists
mkdirSync(outdir, { recursive: true });

// Copy static files
copyFileSync('src/index.html', `${outdir}/index.html`);
copyFileSync('src/styles.css', `${outdir}/styles.css`);

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: `${outdir}/bundle.js`,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  minify: !isWatch,
  loader: {
    '.css': 'css',
  },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete!');
}
