import { describe, expect, it } from 'vitest';
import { describePythonFile } from '../src/core/analysis/python-file-guide';
import { analyzeSource } from '../src/core/analysis/syntax';
import type { ProjectFile } from '../src/shared/contracts';
const id = 'selected';
const hash = 'a'.repeat(64);
function setup(text: string, path = 'pkg/main.py', sources: Record<string, string> = {}, stop = () => false) {
  const files: ProjectFile[] = Object.entries({ [path]: text, ...sources }).map(([relativePath, value]) => ({ id: relativePath === path ? id : relativePath, relativePath, size: Buffer.byteLength(value) }));
  const analysis = analyzeSource(text, path, { projectId: 'p', fileId: id, fileHash: hash });
  const reads: { path: string; maxBytes: number }[] = [];
  const result = () => describePythonFile(text, path, id, hash, analysis, files, {
    shouldStop: stop,
    readFile: async (file: ProjectFile, maxBytes: number) => {
      reads.push({ path: file.relativePath, maxBytes });
      const value = sources[file.relativePath];
      if (value === undefined || Buffer.byteLength(value) > maxBytes) throw new Error('unreadable');
      return { text: value, hash: 'b'.repeat(64) };
    },
  });
  return { result, analysis, reads };
}

describe('Python static file guide', () => {
  it.each(['pkg/__init__.py', 'pkg/__main__.py', 'tests/test_sample.py'])('uses a file-role candidate for %s instead of a generic module role', async path => {
    const special = await setup('x = 1\n', path).result();
    const generic = await setup('x = 1\n', 'pkg/plain.py').result();
    expect(special.role.label).not.toBe(generic.role.label);
    expect(special.role.basis.text).toBeTruthy();
  });
  it('does not infer React or Nest roles from Python names, decorators, comments or strings', async () => {
    const result = await setup('@Controller()\nclass AppModule:\n    pass\ndef useState():\n    return "React NestJS"\n').result();
    expect(result.role.label).not.toMatch(/React|Nest|Next/);
    expect(result.exports).toEqual([]);
    for (const fn of result.functions) expect(fn).toMatchObject({ hooks: [], stores: [], stops: [] });
  });
  it('links decorated function and method chunks to analyzer symbols using exact evidence', async () => {
    const text = '# 😀\n@decorate\ndef run():\n    pass\nclass C:\n    @decorate\n    def method(self):\n        pass\n';
    const fixture = setup(text);
    const guide = await fixture.result();
    for (const symbol of fixture.analysis.symbols) {
      expect(guide.functions.some(fn => fn.symbolId === symbol.id)).toBe(true);
      const item = guide.chunks.find(item => item.symbolId === symbol.id)!;
      expect(item).toBeDefined();
      expect(item.chunk.functionRange).toEqual({ startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
      expect(item.chunk.range).toMatchObject({ fileId: id, fileHash: hash });
    }
  });
  it('collects only three own-body calls and counts omitted calls without nested or header calls', async () => {
    const text = '@decorate(header())\ndef run(value=default()):\n    one()\n    two()\n    three()\n    four()\n    def inner():\n        nested()\n    class C:\n        hidden()\n    callback = lambda: ignored()\n';
    const fixture = setup(text);
    const guide = await fixture.result();
    const symbol = fixture.analysis.symbols.find(symbol => symbol.name === 'run')!;
    expect(guide.functions.find(fn => fn.symbolId === symbol.id)).toMatchObject({ calls: ['one', 'two', 'three'], callsOmitted: 1, hooks: [], stores: [], stops: [] });
  });
  it('resolves a safe relative import to the exact registered file', async () => {
    const fixture = setup('from .helper import run\n', 'pkg/main.py', { 'pkg/__init__.py': '', 'pkg/helper.py': 'def run():\n    pass\n' });
    const result = await fixture.result();
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({ status: 'project', target: { fileId: 'pkg/helper.py', relativePath: 'pkg/helper.py' } });
  });
  it('excludes unevaluated local annotations while retaining assignment value calls', async () => {
    const fixture = setup('def run():\n    value: annotation_only() = actual_call()\n    later: another_annotation()\n');
    const result = await fixture.result();
    expect(result.functions[0].calls).toEqual(['actual_call']);
  });
  it('does not turn future annotations into a dependency or perform a read for it', async () => {
    const fixture = setup('from __future__ import annotations\n');
    const result = await fixture.result();
    expect(result.imports).toEqual([]);
    expect(result.external).toEqual([]);
    expect(fixture.reads).toEqual([]);
  });
  it('does not choose between colliding package and module paths', async () => {
    const result = await setup('from .helper import run\n', 'pkg/main.py', { 'pkg/__init__.py': '', 'pkg/helper.py': '', 'pkg/helper/__init__.py': '' }).result();
    expect(result.imports[0]).toMatchObject({ status: 'ambiguous', target: null });
  });
  it.each(['helper = replacement\n', 'exec(code)\n'])('does not assert a project dependency through unsafe initializer %j', async initializer => {
    const result = await setup('from . import helper\n', 'pkg/main.py', { 'pkg/__init__.py': initializer, 'pkg/helper.py': '' }).result();
    expect(result.imports[0].status).not.toBe('project');
    expect(result.imports[0].target).toBeNull();
  });
  it('does not assert a target when its registered initializer cannot be read', async () => {
    const analysis = analyzeSource('from .helper import run\n', 'pkg/main.py', { projectId: 'p', fileId: id, fileHash: hash });
    const result = await describePythonFile('from .helper import run\n', 'pkg/main.py', id, hash, analysis,
      [{ id, relativePath: 'pkg/main.py', size: 24 }, { id: 'init', relativePath: 'pkg/__init__.py', size: 1 }, { id: 'helper', relativePath: 'pkg/helper.py', size: 0 }],
      { shouldStop: () => false, readFile: async () => { throw new Error('denied'); } });
    expect(result.imports[0].status).not.toBe('project');
    expect(result.imports[0].target).toBeNull();
  });
  it('bounds lazy dependency reads and leaves excess imports unresolved', async () => {
    const sources: Record<string, string> = { 'pkg/__init__.py': '' };
    const imports: string[] = [];
    for (let index = 0; index < 35; index++) {
      sources[`pkg/p${index}/__init__.py`] = '';
      sources[`pkg/p${index}/helper.py`] = '';
      imports.push(`import pkg.p${index}.helper`);
    }
    const fixture = setup(imports.join('\n'), 'pkg/main.py', sources);
    const result = await fixture.result();
    expect(fixture.reads.length).toBeLessThanOrEqual(30);
    expect(result.limitations.length + result.importsOmitted).toBeGreaterThan(0);
  });
  it('shares the one-MiB dependency byte budget across initializer reads', async () => {
    const padding = '#' + 'x'.repeat(600_000) + '\n';
    const fixture = setup('import pkg.first.helper\nimport pkg.second.helper\n', 'pkg/main.py', {
      'pkg/__init__.py': '', 'pkg/first/__init__.py': padding, 'pkg/first/helper.py': '',
      'pkg/second/__init__.py': padding, 'pkg/second/helper.py': '',
    });
    const result = await fixture.result();
    expect(result.imports.every(item => item.status === 'project')).toBe(false);
    expect(fixture.reads.every(read => read.maxBytes <= 1024 * 1024)).toBe(true);
    expect(result.limitations.length).toBeGreaterThan(0);
  });
  it('keeps a good neighboring function guide while reporting malformed source', async () => {
    const fixture = setup('def good():\n    work()\n@@@\n');
    const result = await fixture.result();
    const symbol = fixture.analysis.symbols.find(symbol => symbol.name === 'good')!;
    expect(result.functions.find(fn => fn.symbolId === symbol.id)?.calls).toEqual(['work']);
    expect(result.limitations.length).toBeGreaterThan(0);
  });
  it('checks cancellation before dependency reads', async () => {
    const fixture = setup('from .helper import run\n', 'pkg/main.py', { 'pkg/__init__.py': '', 'pkg/helper.py': '' }, () => true);
    await expect(fixture.result()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.reads).toEqual([]);
  });
});
