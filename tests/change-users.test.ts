import { describe, expect, it } from 'vitest';
import type { FileChange, MapFile, MissingImport } from '../src/shared/contracts';
import type { MapLink } from '../src/renderer/map-layout';
import { changeUsers, gonePaths, staleImports } from '../src/renderer/change-users';

const file = (id: string): MapFile => ({ id, relativePath: `${id}.ts`, folder: '', start: false, entry: false, checked: 'full', reason: null });
const link = (fromFileId: string, toFileId: string, guess?: string): MapLink => ({ fromFileId, toFileId, guess,
  names: [], fileHash: 'hash', startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1, text: `import '${toFileId}'`, specifier: toFileId });
const change = (fileId: string | null, kind: FileChange['kind'] = 'modified'): FileChange => ({ fileId, kind, path: `${fileId}.ts`, oldPath: null });
const files = ['a', 'b', 'c', 'd', 'e'].map(file);

describe('files importing changed files', () => {
  it('keeps every import in input order with the original files, evidence and change kind', () => {
    const links = [link('a', 'b'), { ...link('a', 'b'), startLine: 3 }];
    const changes = [change('b', 'renamed')];
    const before = structuredClone({ files, links, changes });
    const users = changeUsers(files, links, changes);
    expect(users).toEqual([{ file: files[0], guessed: false, uses: [{ file: files[1], kind: 'renamed', links }] }]);
    expect(users[0].file).toBe(files[0]);
    expect(users[0].uses[0].file).toBe(files[1]);
    expect(users[0].uses[0].links[0]).toBe(links[0]);
    expect(users[0].uses[0].links[1]).toBe(links[1]);
    expect({ files, links, changes }).toEqual(before);
  });

  it('sorts users and their changed targets by path, independently of ids and input order', () => {
    const paths = files.map((item, index) => ({ ...item, relativePath: `${['z', 'y', 'x', 'b', 'a'][index]}.ts` }));
    const links = [link('a', 'd'), link('a', 'e'), link('b', 'd')];
    const changes = [change('d'), change('e', 'added')];
    const expected = [{ file: paths[1], guessed: false, uses: [{ file: paths[3], kind: 'modified', links: [links[2]] }] },
      { file: paths[0], guessed: false, uses: [{ file: paths[4], kind: 'added', links: [links[1]] }, { file: paths[3], kind: 'modified', links: [links[0]] }] }];
    expect(changeUsers(paths, links, changes)).toEqual(expected);
    expect(changeUsers(paths, [...links].reverse(), [...changes].reverse())).toEqual(expected);
  });

  it('omits files that only import unchanged files', () => {
    expect(changeUsers(files, [link('a', 'b')], [change('c')])).toEqual([]);
  });

  it('does not follow imports out of a changed file in reverse', () => {
    expect(changeUsers(files, [link('a', 'b')], [change('a')])).toEqual([]);
  });

  it('sorts settled users before guessed-only users and preserves both evidence orders', () => {
    const links = [link('a', 'd', 'candidate'), link('c', 'd', 'first guess'), link('c', 'd'),
      link('b', 'e', 'candidate'), link('c', 'd', 'second guess'), { ...link('c', 'd'), startLine: 4 }, link('a', 'e', '')];
    const users = changeUsers(files, links, [change('e'), change('d')]);
    expect(users.map(user => [user.file.id, user.guessed])).toEqual([['c', false], ['a', true], ['b', true]]);
    expect(users[0].uses[0].links).toEqual([links[2], links[5], links[1], links[4]]);
    const reversed = changeUsers(files, [...links].reverse(), [change('d'), change('e')]);
    expect(reversed.map(user => [user.file.id, user.guessed, user.uses.map(use => use.file.id)]))
      .toEqual(users.map(user => [user.file.id, user.guessed, user.uses.map(use => use.file.id)]));
    expect(reversed[0].uses[0].links).toEqual([links[5], links[2], links[4], links[1]]);
  });

  it('marks a user as settled even when another changed target is only guessed', () => {
    const links = [link('a', 'c', 'candidate'), link('a', 'b')];
    const users = changeUsers(files, links, [change('b'), change('c')]);
    expect(users).toEqual([{ file: files[0], guessed: false, uses: [
      { file: files[1], kind: 'modified', links: [links[1]] }, { file: files[2], kind: 'modified', links: [links[0]] },
    ] }]);
    expect(users[0].uses[1].links[0].guess).toBe('candidate');
  });

  it('includes a user that is itself changed', () => {
    expect(changeUsers(files, [link('a', 'b')], [change('a'), change('b')]).map(user => user.file.id)).toEqual(['a']);
  });

  it('drops self imports', () => {
    expect(changeUsers(files, [link('a', 'a')], [change('a')])).toEqual([]);
  });

  it('drops changes without a current file and links to or from missing files', () => {
    expect(changeUsers(files, [link('a', 'missing'), link('missing', 'b')],
      [change(null, 'deleted'), change('missing'), change('b')])).toEqual([]);
    expect(changeUsers(files, [link('a', 'b')], [change(null, 'deleted')])).toEqual([]);
  });

  it('only takes one step toward changed files', () => {
    expect(changeUsers(files, [link('a', 'b'), link('b', 'c')], [change('c')]).map(user => user.file.id)).toEqual(['b']);
  });

  it('returns no users without changes, links or files', () => {
    expect(changeUsers(files, [link('a', 'b')], [])).toEqual([]);
    expect(changeUsers(files, [], [change('b')])).toEqual([]);
    expect(changeUsers([], [link('a', 'b')], [change('b')])).toEqual([]);
  });
});

describe('imports still naming gone paths', () => {
  const missing = (fromFileId: string, names: string[], startUtf16 = 0): MissingImport => ({
    fromFileId, names, startUtf16, endUtf16: startUtf16 + 10, startLine: 1, endLine: 1,
    fileHash: 'hash', text: "import './gone'", specifier: './gone',
  });
  const deleted = (path: string): FileChange => ({ path, kind: 'deleted', fileId: null, oldPath: null });
  const renamed = (oldPath: string, path = 'new.ts'): FileChange => ({ path, oldPath, kind: 'renamed', fileId: 'new' });

  it('matches deleted and renamed paths in name order, retaining evidence and displayed paths', () => {
    const item = missing('a', ['old.ts', 'gone.ts', 'old.ts', 'other.ts']);
    const changes = [deleted('gone.ts'), renamed('old.ts')];
    const before = structuredClone({ files, item, changes });
    const result = staleImports(files, [item], changes);
    expect(result).toEqual([{ from: files[0], link: item, gone: [
      { path: 'old.ts', kind: 'renamed' }, { path: 'gone.ts', kind: 'deleted' },
    ] }]);
    expect(result[0].link).toBe(item);
    expect(result[0].from).toBe(files[0]);
    expect({ files, item, changes }).toEqual(before);
  });

  it('omits unrelated names and importers absent from the map', () => {
    expect(staleImports(files, [missing('a', ['other.ts']), missing('unknown', ['gone.ts'])], [deleted('gone.ts')])).toEqual([]);
  });

  it('does not match a deleted or renamed path now occupied by another change', () => {
    const changes = [deleted('gone.ts'), renamed('old.ts'),
      { ...change('replacement', 'added'), path: 'gone.ts' }, { ...change('replacement', 'untracked'), path: 'old.ts' }];
    expect(gonePaths(changes).size).toBe(0);
    expect(gonePaths([...changes].reverse()).size).toBe(0);
    expect(staleImports(files, [missing('a', ['gone.ts', 'old.ts'])], changes)).toEqual([]);
  });

  it('sorts by importer path and then source position independently of input order', () => {
    const imports = [missing('b', ['gone.ts']), missing('a', ['gone.ts'], 20), missing('a', ['gone.ts'], 3)];
    const expected = [imports[2], imports[1], imports[0]];
    expect(staleImports(files, imports, [deleted('gone.ts')]).map(item => item.link)).toEqual(expected);
    expect(staleImports([...files].reverse(), [...imports].reverse(), [deleted('gone.ts')]).map(item => item.link)).toEqual(expected);
  });

  it('collects only deletions and old rename paths', () => {
    expect([...gonePaths([deleted('gone.ts'), renamed('old.ts')])]).toEqual([
      ['gone.ts', { path: 'gone.ts', kind: 'deleted' }], ['old.ts', { path: 'old.ts', kind: 'renamed' }],
    ]);
    expect(gonePaths([change('a'), change('b', 'added')]).size).toBe(0);
    expect(gonePaths([]).size).toBe(0);
  });

  it.each(['NFC', 'NFD'] as const)('matches both Unicode forms, deduplicates by NFC, and preserves Git spelling (%s)', form => {
    const path = '한글.ts'.normalize(form);
    const other = path.normalize(form === 'NFC' ? 'NFD' : 'NFC');
    for (const changed of [deleted(path), renamed(path)]) {
      const result = staleImports(files, [missing('a', [other, path])], [changed]);
      expect(result[0].gone).toEqual([{ path, kind: changed.kind }]);
      // The import names the path in the other form only.
      expect(staleImports(files, [missing('a', [other])], [changed])[0].gone).toEqual([{ path, kind: changed.kind }]);
      expect([...gonePaths([changed]).keys()]).toEqual([path.normalize('NFC')]);
      const replacement = { ...change('replacement', 'added'), path: other };
      expect(staleImports(files, [missing('a', [path])], [changed, replacement])).toEqual([]);
    }
  });

  it('keeps case distinctions', () => {
    expect(staleImports(files, [missing('a', ['Gone.ts'])], [deleted('gone.ts')])).toEqual([]);
    expect(gonePaths([deleted('Gone.ts'), { ...change('replacement', 'added'), path: 'gone.ts' }]).size).toBe(1);
  });
});
