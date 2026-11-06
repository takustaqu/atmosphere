// @ts-expect-error no node types in this project
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain build script, without types
import { SHADERS, stripGlsl, stripSource } from '../scripts/strip-glsl.mjs';

const read = (file: string): string => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const shaders = (s: string) => [...s.matchAll(/^(?:export )?const \w+ = `([\s\S]*?)^`;/gm)].map((m) => m[1]);
const listed = SHADERS as Record<string, string[]>;

describe('stripGlsl', () => {
  it('takes out comments and indentation, and leaves the code', () => {
    expect(stripGlsl('  float a = 1.0;   // one\n  #define B 2 // two\n')).toBe('float a = 1.0;\n#define B 2\n');
  });

  it('keeps every line where it is', () => {
    expect(stripGlsl('// a\n/* b\n c */ float d;\n\nfloat e;\n')).toBe('\n\nfloat d;\n\nfloat e;\n');
  });

  it('leaves an interpolation alone, whatever is in it', () => {
    expect(stripGlsl('float a = ${(1 / N).toFixed(10)}; // b\nfloat c = ${x("//")};')).toBe('float a = ${(1 / N).toFixed(10)};\nfloat c = ${x("//")};');
  });

  it('does not take a division for a comment', () => {
    expect(stripGlsl('a = b / c / d;')).toBe('a = b / c / d;');
  });
});

describe('stripSource', () => {
  for (const file of Object.keys(listed)) {
    describe(file, () => {
      const source = read(file);
      const stripped = stripSource(file, source) as string;

      it('finds its shaders and only touches them', () => {
        const [a, b] = [shaders(source), shaders(stripped)];
        expect(b).toHaveLength(listed[file].length);
        let rest = stripped;
        for (const s of b) rest = rest.replace(s, '');
        let restOriginal = source;
        for (const s of a) restOriginal = restOriginal.replace(s, '');
        expect(rest).toBe(restOriginal);
      });

      it('keeps every line number of the source', () => {
        expect(stripped.split('\n').length).toBe(source.split('\n').length);
      });

      it('leaves the same tokens in each shader', () => {
        const tokens = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').split(/\s+/).filter(Boolean);
        const [a, b] = [shaders(source), shaders(stripped)];
        a.forEach((s, i) => expect(tokens(b[i])).toEqual(tokens(s)));
      });
    });
  }

  it('takes out most of the fragment shader', () => {
    const source = read('shaders/sky.ts');
    expect((stripSource('shaders/sky.ts', source) as string).length).toBeLessThan(source.length * 0.5);
  });

  it('knows every shader in src/, and finds none anywhere else', () => {
    const files = (readdirSync(new URL('../src/', import.meta.url), { recursive: true }) as string[])
      .map((f) => f.split('\\').join('/')).filter((f) => /\.tsx?$/.test(f));
    expect(files).toEqual(expect.arrayContaining(Object.keys(listed)));
    for (const file of files) expect(() => stripSource(file, read(file))).not.toThrow();
  });

  it('refuses a shader it does not know, a renamed one, or one gone missing', () => {
    expect(() => stripSource('renderer.ts', 'const FRAG = `\na\n`;\n')).toThrow(/expected no shader/);
    expect(() => stripSource('shaders/sky.ts', 'export const FRAG2 = `\na\n`;\n')).toThrow(/expected FRAG/);
    expect(() => stripSource('shaders/sky.ts', 'export const FRAG = 1;\n')).toThrow(/expected FRAG/);
    expect(() => stripSource('shaders/sky.ts', 'export const FRAG = `\na\n`;\nconst MORE = `b\n`;\n')).toThrow(/expected FRAG/);
    expect(() => stripSource('shaders/sky.ts', 'export const FRAG = `\na\n`;\nconst MORE = `b; // c`;\n')).toThrow(/expected FRAG/);
    expect(stripSource('shaders/sky.ts', 'export const FRAG = `\na; // b\n`;\n')).toBe('export const FRAG = `\na;\n`;\n');
  });
});
