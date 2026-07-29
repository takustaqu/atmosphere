// Build the distributable package: ESM bundles + type declarations.
//
// The source `exports` point straight at .ts/.tsx, which only works for
// consumers whose bundler transpiles node_modules (Vite, esbuild). Next.js
// without transpilePackages, CRA and plain webpack exclude node_modules from
// transpilation, so the published package must ship plain ESM + .d.ts.
//
//   dist/index.js                     core bundle (no dependencies)
//   dist/react/index.js              React bindings; imports ../index.js
//   dist/react/atmosphere.css       styles for the React sample bindings
//   dist/types/**                     declarations emitted by tsc (see tsconfig.build.json)
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/index.js',
  sourcemap: true,
});

await build({
  entryPoints: ['examples/react/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/react/index.js',
  sourcemap: true,
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    // the wrapper imports the core via a relative path ('../../src'); in the
    // published layout that code lives in ../index.js as a separate bundle.
    // Rewriting instead of inlining keeps a single copy of the core classes,
    // so instanceof and module-level state agree across both entry points
    name: 'core-as-sibling-bundle',
    setup(b) {
      b.onResolve({ filter: /^\.\.\/\.\.\/src(\/index)?$/ }, () => ({
        path: '../index.js',
        external: true,
      }));
    },
  }],
});

await cp('examples/react/atmosphere.css', 'dist/react/atmosphere.css');
console.log('dist/ bundles written');
