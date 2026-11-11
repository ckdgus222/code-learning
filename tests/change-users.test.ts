import { describe, expect, it } from 'vitest';
import type { FileChange, MapFile } from '../src/shared/contracts';
import type { MapLink } from '../src/renderer/map-layout';
import { changeUsers } from '../src/renderer/change-users';

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
