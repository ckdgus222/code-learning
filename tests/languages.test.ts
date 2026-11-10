import { describe, expect, it } from 'vitest';
import { languageOf, type SourceLanguage } from '../src/shared/languages';
import { codeFile } from '../src/core/analysis/project-map';

const cases: [string, SourceLanguage][] = [
  ...['ts', 'tsx', 'mts', 'cts'].flatMap(extension => [
    [`src/main.${extension}`, 'typescript'], [`src/main.${extension.toUpperCase()}`, 'typescript'],
  ] as [string, SourceLanguage][]),
  ...['js', 'jsx', 'mjs', 'cjs'].flatMap(extension => [
    [`src/main.${extension}`, 'javascript'], [`src/main.${extension.toUpperCase()}`, 'javascript'],
  ] as [string, SourceLanguage][]),
  ['a.test.tsx', 'typescript'], ['types.d.ts', 'typescript'], ['.config.ts', 'typescript'], ['.ts', 'typescript'],
  ['main.py', 'python'], ['MAIN.PY', 'python'], ['main.go', 'text'], ['README.md', 'text'], ['Dockerfile', 'text'],
  ['.gitignore', 'text'], ['v1.2/readme', 'text'], ['a.', 'text'],
  ['src.ts/readme', 'text'], ['src.ts\\readme', 'text'], ['', 'text'],
];

describe('languageOf', () => {
  it.each(cases)('identifies %s as %s', (file, expected) => {
    expect(languageOf(file)).toBe(expected);
  });

  it.each(cases)('codeFile is true exactly for TypeScript and JavaScript: %s', file => {
    expect(['typescript', 'javascript'].includes(languageOf(file))).toBe(codeFile.test(file));
  });
});
