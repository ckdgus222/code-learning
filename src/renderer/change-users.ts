import type { ChangeKind, FileChange, MapFile, MissingImport } from '../shared/contracts';
import type { MapLink } from './map-layout';

/** One changed file that a file imports, with those imports as evidence: settled ones before guesses. */
export interface ChangedUse { file: MapFile; kind: ChangeKind; links: MapLink[] }
/** A file that imports changed files. `guessed`: none of those imports is settled. */
export interface ChangeUser { file: MapFile; guessed: boolean; uses: ChangedUse[] }

export function changeUsers(files: MapFile[], links: MapLink[], changes: FileChange[]): ChangeUser[] {
  const fileOf = new Map(files.map(file => [file.id, file]));
  const changed = new Map(changes.flatMap(change => change.fileId !== null && fileOf.has(change.fileId)
    ? [[change.fileId, change.kind] as const] : []));
  const users = new Map<string, { file: MapFile; guessed: boolean; uses: Map<string, { use: ChangedUse; guesses: MapLink[] }> }>();
  for (const link of links) {
    const file = fileOf.get(link.fromFileId);
    const kind = changed.get(link.toFileId);
    if (!file || kind === undefined || link.fromFileId === link.toFileId) continue;
    let user = users.get(file.id);
    if (!user) {
      user = { file, guessed: true, uses: new Map() };
      users.set(file.id, user);
    }
    let evidence = user.uses.get(link.toFileId);
    if (!evidence) {
      evidence = { use: { file: fileOf.get(link.toFileId)!, kind, links: [] }, guesses: [] };
      user.uses.set(link.toFileId, evidence);
    }
    if (link.guess !== undefined) {
      evidence.guesses.push(link);
      continue;
    }
    evidence.use.links.push(link);
    user.guessed = false;
  }
  return [...users.values()].map(user => ({ file: user.file, guessed: user.guessed,
    uses: [...user.uses.values()].map(({ use, guesses }) => ({ ...use, links: [...use.links, ...guesses] }))
      .sort((a, b) => a.file.relativePath.localeCompare(b.file.relativePath)),
  })).sort((a, b) => Number(a.guessed) - Number(b.guessed) || a.file.relativePath.localeCompare(b.file.relativePath));
}

/** An import still naming a deleted file or a rename's old path. */
export interface StaleImport { from: MapFile; link: MissingImport; gone: { path: string; kind: 'deleted' | 'renamed' }[] }

/**
 * Paths are compared by their NFC form: macOS may keep a Korean name decomposed (NFD) on disk while git records it
 * composed, so the map's path and git's path of one file can differ in spelling. Case is kept.
 */
const key = (path: string) => path.normalize('NFC');

/** Paths the comparison says are gone, by their comparison key; each keeps the spelling git gave it for display. */
export function gonePaths(changes: FileChange[]): Map<string, { path: string; kind: 'deleted' | 'renamed' }> {
  const current = new Set(changes.filter(change => change.kind !== 'deleted').map(change => key(change.path)));
  const gone = new Map<string, { path: string; kind: 'deleted' | 'renamed' }>();
  for (const change of changes) {
    if (change.kind === 'deleted') gone.set(key(change.path), { path: change.path, kind: 'deleted' });
    if (change.oldPath !== null) gone.set(key(change.oldPath), { path: change.oldPath, kind: 'renamed' });
  }
  for (const name of current) gone.delete(name);
  return gone;
}

/** The imports that found no file and are looked for at a gone path, by importer path and then position. */
export function staleImports(files: MapFile[], missing: MissingImport[], changes: FileChange[]): StaleImport[] {
  const gone = gonePaths(changes);
  // Most comparisons delete nothing; the names of every missing import are not worth normalising then.
  if (!gone.size) return [];
  const fileOf = new Map(files.map(file => [file.id, file]));
  const stale: StaleImport[] = [];
  for (const link of missing) {
    const from = fileOf.get(link.fromFileId);
    if (!from) continue;
    const keys = [...new Set(link.names.map(key))];
    const matches = keys.flatMap(name => gone.has(name) ? [gone.get(name)!] : []);
    if (!matches.length) continue;
    stale.push({ from, link, gone: matches });
  }
  return stale.sort((a, b) => a.from.relativePath.localeCompare(b.from.relativePath) || a.link.startUtf16 - b.link.startUtf16);
}
