// @ts-expect-error no node types in this project
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain build script, without types
import { stripGlsl, stripRenderer } from '../scripts/strip-glsl.mjs';

const source = readFileSync(new URL('../src/renderer.ts', import.meta.url), 'utf8');
const shaders = (s: string) => [...s.matchAll(/^const (?:VERT|FRAG|MORPH_FRAG) = `([\s\S]*?)^`;/gm)].map((m) => m[1]);

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

describe('stripRenderer', () => {
  const stripped = stripRenderer(source) as string;

  it('finds the three shaders and only touches them', () => {
    const [a, b] = [shaders(source), shaders(stripped)];
    expect(b).toHaveLength(3);
    expect(stripped.length).toBeLessThan(source.length * 0.5);
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

  it('refuses a source whose shaders it cannot find', () => {
    expect(() => stripRenderer('const FRAG = `a\n`;\n')).toThrow(/three shaders/);
  });
});
