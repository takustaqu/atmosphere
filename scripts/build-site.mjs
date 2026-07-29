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
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

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

await cp('site/index.html', '_site/index.html');
await build({
  ...common,
  entryPoints: ['site/main.ts'],
  outfile: '_site/assets/site.js',
});

console.log('_site/ written');
