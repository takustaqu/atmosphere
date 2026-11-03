// Take the comments and the indentation out of the shaders as they are bundled.
//
// Two thirds of the fragment shader's source is its comments. A minifier leaves
// the inside of a template literal alone, so without this every page that loads
// the sky downloads them, parses them as a string and hands them to the driver
// for every variant it compiles. The checked-in source keeps them, and so do
// `pnpm playground` and the tests, which load it as it is.
//
// Every line stays where it is, blank if nothing is left of it: a line number in
// a driver's error, or in a stack trace through the source map, is still the
// source's. It costs a byte a line, and next to nothing once compressed.
import { readFile } from 'node:fs/promises';

/** the body of a shader's template literal, `${...}` left as it stands */
export function stripGlsl(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    if (src.startsWith('${', i)) {
      let depth = 0, j = i + 1;
      do {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      } while (depth > 0 && j < src.length);
      out += src.slice(i, j);
      i = j;
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += ' ' + src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += src[i++];
    }
  }
  return out.replace(/^[ \t]+|[ \t]+$/gm, '');
}

const SHADERS = /^(const (?:VERT|FRAG|MORPH_FRAG) = `)([\s\S]*?)(^`;)/gm;

/** renderer.ts with its three shaders stripped. A fourth, or one renamed, has to fail loudly */
export function stripRenderer(source) {
  let found = 0;
  const out = source.replace(SHADERS, (_, open, body, close) => {
    found++;
    return open + stripGlsl(body) + close;
  });
  if (found !== 3 || /^const \w+ = `$/gm.test(out.replace(SHADERS, ''))) {
    throw new Error(`strip-glsl: expected renderer.ts's three shaders, found ${found}`);
  }
  return out;
}

/** the esbuild plugin */
export const stripShaders = {
  name: 'strip-shaders',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]renderer\.ts$/ }, async (args) => ({
      contents: stripRenderer(await readFile(args.path, 'utf8')),
      loader: 'ts',
    }));
  },
};
