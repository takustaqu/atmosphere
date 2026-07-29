// Build the GitHub Pages site into _site/.
//
// The examples are served exactly as they are checked in, so their
// `<script type="module" src="../../build/<name>/main.js">` must keep
// resolving. That tag is relative to examples/<name>/index.html, so the
// bundles have to sit two levels up in build/<name>/ — hence the nesting:
//
//   _site/index.html                     landing page (site/index.html)
//   _site/assets/site.js                 landing page script (site/main.ts)
//   _site/build/playground/main.js       <- ../../build/playground/main.js
//   _site/build/controller/main.js       <- ../../build/controller/main.js
//   _site/examples/playground/index.html
//   _site/examples/controller/index.html
//
// Keeping the same layout means the examples need no build-time rewriting and
// stay openable from the repo checkout with `pnpm playground`.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await rm('_site', { recursive: true, force: true });
await mkdir('_site', { recursive: true });

// Same esbuild settings as scripts/build.mjs, minus sourcemaps: nothing debugs
// against the deployed site, and minify keeps the shader-heavy bundles small.
const common = { bundle: true, format: 'esm', target: 'es2022', minify: true };

for (const name of ['playground', 'controller']) {
  await build({
    ...common,
    entryPoints: [`examples/${name}/main.ts`],
    outfile: `_site/build/${name}/main.js`,
  });
  await cp(`examples/${name}/index.html`, `_site/examples/${name}/index.html`);
}

// The landing page is the site's root, so a missing one has to fail loudly:
// skipping it would deploy a Pages site whose entry point 404s, and the
// workflow would still report success.
for (const f of ['site/index.html', 'site/main.ts']) {
  if (!existsSync(f)) throw new Error(`build-site: ${f} is missing`);
}

await build({
  ...common,
  entryPoints: ['site/main.ts'],
  outfile: '_site/assets/site.js',
});

// ── the hero's typeface ───────────────────────────────────
// Zen Old Mincho is a Japanese face, so the whole thing is hundreds of
// kilobytes and Google's unicode-range split still pulls several subsets for
// a handful of kanji. The hero's copy is a closed set, though, so ask for
// exactly its characters and get one small file instead.
//
// The character list is derived from scenes.ts rather than written out here:
// hard-coding it would silently drop a glyph the first time the copy is
// edited, and a missing glyph in 40px type is not subtle.
const scenesBundle = '_site/assets/.scenes.mjs';
await build({ ...common, minify: false, entryPoints: ['site/scenes.ts'], outfile: scenesBundle });
const { SCENES } = await import(pathToFileURL(resolve(scenesBundle)).href);
await rm(scenesBundle);

const glyphs = [...new Set(SCENES.flatMap((s) => [...s.ja, ...s.en]))].sort().join('');
const fontTag =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho'
  + `&text=${encodeURIComponent(glyphs)}&display=swap">`;

const html = await readFile('site/index.html', 'utf8');
if (!html.includes('<!--ZEN_OLD_MINCHO-->')) {
  throw new Error('build-site: the ZEN_OLD_MINCHO token is gone from site/index.html');
}
await writeFile('_site/index.html', html.replace('<!--ZEN_OLD_MINCHO-->', fontTag));
console.log(`hero subset: ${glyphs.length} glyphs`);

console.log('_site/ written');
