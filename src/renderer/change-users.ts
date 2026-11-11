import type { ChangeKind, FileChange, MapFile } from '../shared/contracts';
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
