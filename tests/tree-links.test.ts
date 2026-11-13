import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Parser from 'tree-sitter';
import { analyzeSource, parseTree } from '../src/core/analysis/syntax';
import { walkPython, pythonRoutes } from '../src/core/analysis/python-routes';
import { djangoFile } from '../src/core/analysis/django-routes';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { describeFile } from '../src/core/analysis/file-guide';

const linkNames = ['parent', 'nextSibling', 'previousSibling', 'nextNamedSibling', 'previousNamedSibling'] as const;
const require = createRequire(import.meta.url);
const bindingRequire = createRequire(require.resolve('tree-sitter'));
const { NodeMethods } = bindingRequire('node-gyp-build')(path.dirname(require.resolve('tree-sitter'))) as {
  NodeMethods: Record<typeof linkNames[number], (tree: Parser.Tree) => unknown>;
};
const extras = [
  { name: 'TypeScript comments', file: 'sample.ts', line: '// extra\n', tail: 'const value = 1;' },
  { name: 'Python comments', file: 'sample.py', line: '# extra\n', tail: 'value = 1\n' },
  { name: 'JavaScript HTML comments', file: 'sample.js', line: '<!-- extra\n', tail: 'const value = 1;' },
  { name: 'Python continuations', file: 'sample.py', line: '\\\n', tail: 'value = 1\n' },
];
const context = { projectId: 'project', fileId: 'file', fileHash: 'hash' };
afterEach(() => { vi.restoreAllMocks(); });

function watchNativeLinks() {
  return linkNames.map(name => ({ name, spy: vi.spyOn(NodeMethods, name) }));
}

describe('tree link answers from children', () => {
  it.each([
    ...['ts', 'tsx', 'js', 'py'].map(extension => ({ name: `empty ${extension}`, file: `sample.${extension}`, text: '' })),
    ...extras.flatMap(extra => [64, 65].map(count => ({
      name: `${extra.name}: ${count}`, file: extra.file, text: extra.line.repeat(count) + extra.tail,
    }))),
    { name: 'comments only', file: 'sample.py', text: '# extra\n'.repeat(65) },
    { name: 'TS decorators and nested comments', file: 'sample.ts',
      text: `@sealed\nexport class Example {\n${'// extra\n'.repeat(65)} method(a: number) { return [a, 2]; } }` },
    { name: 'JSX and unnamed siblings', file: 'sample.tsx',
      text: '// extra\n'.repeat(65) + 'export const View = () => <div title="x">{items.map(x => <b>{x}</b>)}text</div>;' },
    { name: 'Python decorators and f-strings', file: 'sample.py',
      text: '# extra\n'.repeat(65) + '@decorate\ndef greet(name):\n    return f"hello {name!r:>10}"\n' },
    { name: 'nested Python extras', file: 'sample.py', text: `values = [\n${'# extra\n'.repeat(65)}1, 2, 3]\n` },
    { name: 'ERROR nodes', file: 'sample.tsx', text: '// extra\n'.repeat(65) + 'const View = () => <div>{ @@@ }</div>;' },
    { name: 'MISSING nodes', file: 'sample.ts', text: '// extra\n'.repeat(65) + 'function f() { return (1; }' },
    { name: 'Python syntax error', file: 'sample.py', text: '# extra\n'.repeat(65) + 'def f():\n    return (1\n' },
  ])('matches all five links for $name', ({ name, file, text }) => {
    const root = parseTree(text, file);
    const nodes: Parser.SyntaxNode[] = [];
    const expected = new Map<number, Record<typeof linkNames[number], number | null>>();
    const pending: { parent: Parser.SyntaxNode | null; children: Parser.SyntaxNode[] }[] = [{ parent: null, children: [root] }];
    while (pending.length) {
      const { parent, children } = pending.pop()!;
      children.forEach((node, index) => {
        nodes.push(node);
        expected.set(node.id, {
          parent: parent?.id ?? null,
          previousSibling: children[index - 1]?.id ?? null,
          nextSibling: children[index + 1]?.id ?? null,
          previousNamedSibling: children.slice(0, index).findLast(sibling => sibling.isNamed)?.id ?? null,
          nextNamedSibling: children.slice(index + 1).find(sibling => sibling.isNamed)?.id ?? null,
        });
        pending.push({ parent: node, children: node.children });
      });
    }
    if (name === 'ERROR nodes') expect(nodes.some(node => node.isError)).toBe(true);
    if (name === 'MISSING nodes') expect(nodes.some(node => node.isMissing)).toBe(true);
    if (name.includes('syntax error')) expect(root.hasError).toBe(true);
    for (const node of nodes) {
      for (const link of linkNames) {
        const actual = node[link];
        expect(actual === null ? null : actual.id, `${node.type} at ${node.startIndex}: ${link}`).toBe(expected.get(node.id)![link]);
      }
    }
    const cursor = root.walk();
    const cursorIds = new Set<number>();
    do {
      cursorIds.add(cursor.currentNode.id);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          expect(cursorIds).toEqual(new Set(nodes.map(node => node.id)));
          return;
        }
      }
    } while (true);
  });
});

describe('tree link threshold (4.1-1)', () => {
  it.each(extras)('uses native links at 64 and indexed links at 65 for $name', ({ file, line, tail }) => {
    const spies = watchNativeLinks();
    // Keep both trees alive and alternate them: their cached decisions must stay separate.
    const roots = [64, 65].map(count => parseTree(line.repeat(count) + tail, file));
    for (const index of [0, 1, 0, 1]) {
      const node = roots[index].children.at(-1)!;
      expect(node.text.trim()).toBe(tail.trim());
      for (const { name, spy } of spies) {
        spy.mockClear();
        void node[name];
        if (index === 0) expect(spy, name).toHaveBeenCalled();
        else expect(spy, name).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    ['unnamed punctuation', `const values = [${'/* extra */'.repeat(64)},${'/* extra */'.repeat(64)}];`],
    ['different depths', `${'// extra\n'.repeat(64)}function f() {\n${'// extra\n'.repeat(64)}return 1; }`],
    ['separate child lists', `function f() {\n${'// extra\n'.repeat(64)}}\nfunction g() {\n${'// extra\n'.repeat(64)}}`],
  ])('does not join runs across %s', (_name, text) => {
    const root = parseTree(text, 'sample.ts');
    expect(root.hasError).toBe(false);
    const spies = watchNativeLinks();
    for (const { name, spy } of spies) {
      void root.children.at(-1)![name];
      expect(spy, name).toHaveBeenCalled();
    }
  });

  it.each([
    ['sample.py', '#\n'], ['sample.ts', '//\n'], ['sample.js', '//\n'],
  ])('keeps runs through skipped text in %s', (file, comment) => {
    // Error recovery turns each `@` line into an extra ERROR node between the comment runs.
    const root = parseTree((comment.repeat(64) + '@\n').repeat(64) + 'x\n', file);
    const spies = watchNativeLinks();
    for (const { name, spy } of spies) {
      void root.children.at(-1)![name];
      expect(spy, name).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['sample.py', '#\n', '(\n'], ['sample.py', '', '(\n'], ['sample.ts', '//\n', '(\n'], ['sample.js', '', '(\n'],
  ])('counts every child of a flat ERROR node in %s', (file, comment, opener) => {
    // Unclosed brackets make one ERROR node whose children alternate between comments and the brackets.
    const tail = (comment.repeat(64) + opener).repeat(64) + 'x\n';
    const root = parseTree(tail, file);
    const node = root.descendantForIndex(tail.length - 2);
    const spies = watchNativeLinks();
    for (const { name, spy } of spies) {
      void node[name];
      expect(spy, name).not.toHaveBeenCalled();
    }
  });

  it('counts at most 64 children of an ERROR node as short', () => {
    const root = parseTree('('.repeat(63) + 'x', 'sample.py');
    expect(root.descendantsOfType('ERROR').length).toBeGreaterThan(0);
    const spies = watchNativeLinks();
    void root.descendantForIndex(63).parent;
    expect(spies[0].spy).toHaveBeenCalled();
  });

  it('counts adjacent extras of different kinds in the same run', () => {
    const root = parseTree('# extra\n\\\n'.repeat(32) + '# extra\nvalue = 1\n', 'sample.py');
    expect(root.hasError).toBe(false);
    const spies = watchNativeLinks();
    for (const { name, spy } of spies) {
      void root.children.at(-1)![name];
      expect(spy, name).not.toHaveBeenCalled();
    }
  });
});

describe('native link guards for analysis (4.2)', () => {
  it.each(extras)('avoids all five native links for $name', async ({ file, line }) => {
    const python = file.endsWith('.py');
    const text = line.repeat(65) + (python
      ? 'from fastapi import FastAPI\nfrom django.urls import path\napp = FastAPI()\n@app.get("/hello")\ndef hello():\n    return "hello"\nurlpatterns = [path("hello/", hello)]\n'
      : `import express from 'express';\nconst app = express();\nexport function hello() { return 'hello'; }\napp.get('/hello', hello);\nclass Service {\n${line.repeat(65)}run() { return hello(); } }`);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tree-links-')));
    try {
      await writeFile(path.join(root, file), text);
      const files = [{ id: 'file', relativePath: file, size: Buffer.byteLength(text) }];
      const spies = watchNativeLinks();
      const analysis = analyzeSource(text, file, context);
      expect(analysis.symbols.some(symbol => symbol.name === 'hello')).toBe(true);
      for (const { name, spy } of spies) expect(spy, `analyzeSource: ${name}`).not.toHaveBeenCalled();
      if (python) {
        const walk = walkPython(text, file, 100_000);
        expect(walk.complete).toBe(true);
        expect(pythonRoutes(files[0], walk, 'hash', 1000).routes).toHaveLength(1);
        expect(djangoFile(files[0], walk, 'hash', { entries: 5000, views: 20000 }).entries).toHaveLength(1);
        for (const { name, spy } of spies) expect(spy, `Python readers: ${name}`).not.toHaveBeenCalled();
      }
      const map = await buildProjectMap(root, 'project', files, []);
      expect(map.files).toHaveLength(1);
      expect(map.symbols.length).toBeGreaterThan(0);
      expect(map.limited).toBe(false);
      for (const { name, spy } of spies) expect(spy, `buildProjectMap: ${name}`).not.toHaveBeenCalled();
      const routes = await findProjectRoutes(root, 'project', files);
      expect(routes.routes.some(route => route.path === '/hello')).toBe(true);
      expect(routes.limited).toBe(false);
      for (const { name, spy } of spies) expect(spy, `findProjectRoutes: ${name}`).not.toHaveBeenCalled();
      if (python) return;
      expect(describeFile(text, file, 'file', 'hash', analysis, files).functions.length).toBeGreaterThan(0);
      for (const { name, spy } of spies) expect(spy, `describeFile: ${name}`).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
