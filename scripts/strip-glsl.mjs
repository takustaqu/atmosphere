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
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Every shader in src/, by the file it is in (its path from src/). A shader is
 * a template literal opened at the end of a `const NAME = ` line and closed by
 * a line of its own; one turning up in any other file, or under another name,
 * or one of these going missing, has to fail loudly rather than ship unstripped
 */
export const SHADERS = {
  'shaders/vert.ts': ['VERT'],
  'shaders/sky.ts': ['FRAG'],
  'shaders/morph.ts': ['MORPH_FRAG'],
};

const SHADER = /^((?:export )?const (\w+) = `)$([\s\S]*?)^(`;)/gm;
const OPENED = /^(?:export )?(?:const|let|var) \w+ = `/gm;

/** a file of src/ with its shaders stripped: exactly the ones SHADERS lists for it, and none in any other */
export function stripSource(file, source) {
  const want = SHADERS[file] ?? [];
  const found = [];
  const out = source.replace(SHADER, (_, open, name, body, close) => {
    found.push(name);
    return open + stripGlsl(body) + close;
  });
  if (found.join() !== want.join() || (source.match(OPENED)?.length ?? 0) !== found.length) {
    throw new Error(`strip-glsl: expected ${want.join(', ') || 'no shader'} in src/${file}, found ${found.join(', ') || 'none'}`);
  }
  return out;
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** the esbuild plugin: every file of src/ goes through stripSource */
export const stripShaders = {
  name: 'strip-shaders',
  setup(b) {
    b.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (!args.path.startsWith(SRC)) return undefined;
      const file = relative(SRC, args.path).split(sep).join('/');
      return {
        contents: stripSource(file, await readFile(args.path, 'utf8')),
        loader: args.path.endsWith('x') ? 'tsx' : 'ts',
      };
    });
  },
};
