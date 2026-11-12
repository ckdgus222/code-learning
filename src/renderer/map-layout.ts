import { languageOf } from '../shared/languages';
import type { CallSite, CodeStep, CodeSymbol, Evidence, MapFile, MapFunction, MapImport, MapUnresolvedReason, ProjectMap, SourceView } from '../shared/contracts';

export const unresolvedLabels: Record<MapUnresolvedReason, string> = {
  'not-found': '찾지 못함(파일이 없거나 탐색 목록에서 제외됨)', ambiguous: '후보 여럿', outside: '프로젝트 밖',
  'not-static': '정적 import 아님(동적 import·require)', syntax: 'import 문에 구문 오류',
  unavailable: '대상을 지금 확인할 수 없음(삭제·제외·링크)',
  unreadable: '경로 글을 그대로 읽을 수 없음(빈 경로·이스케이프 문자)',
};

export interface ImportCycle {
  /** The files in the loop, sorted by relativePath. */
  files: MapFile[];
  /** Every edge inside the group, including repeated imports, in map.edges order. */
  imports: ProjectMap['edges'];
}

/** Find strongly connected groups with two iterative depth-first walks (Kosaraju). */
export function importCycles(map: ProjectMap): ImportCycle[] {
  const files = new Map(map.files.map(file => [file.id, file]));
  const outgoing = new Map(map.files.map(file => [file.id, [] as string[]]));
  const incoming = new Map(map.files.map(file => [file.id, [] as string[]]));
  for (const edge of map.edges) {
    if (!files.has(edge.fromFileId) || !files.has(edge.toFileId)) continue;
    outgoing.get(edge.fromFileId)!.push(edge.toFileId);
    incoming.get(edge.toFileId)!.push(edge.fromFileId);
  }

  const visited = new Set<string>();
  const finished: string[] = [];
  // Seed every file so disconnected parts are visited too. Exit frames record postorder.
  const walk = map.files.map(file => ({ id: file.id, exit: false }));
  while (walk.length) {
    const current = walk.pop()!;
    if (current.exit) { finished.push(current.id); continue; }
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    walk.push({ id: current.id, exit: true });
    for (const id of outgoing.get(current.id)!) {
      if (!visited.has(id)) walk.push({ id, exit: false });
    }
  }

  const componentOf = new Map<string, ImportCycle>();
  const components: ImportCycle[] = [];
  const pending: string[] = [];
  let component: ImportCycle = { files: [], imports: [] };
  // Walk reversed edges in decreasing finish order; each new root starts one component.
  while (finished.length || pending.length) {
    if (!pending.length) {
      const root = finished.pop()!;
      if (componentOf.has(root)) continue;
      component = { files: [], imports: [] };
      components.push(component);
      componentOf.set(root, component);
      pending.push(root);
    }
    const id = pending.pop()!;
    component.files.push(files.get(id)!);
    for (const source of incoming.get(id)!) {
      if (componentOf.has(source)) continue;
      componentOf.set(source, component);
      pending.push(source);
    }
  }

  for (const edge of map.edges) {
    const group = componentOf.get(edge.fromFileId);
    if (group && group === componentOf.get(edge.toFileId)) group.imports.push(edge);
  }
  // A group of two or more always has imports inside it; a lone file has one only when it imports itself.
  const cycles = components.filter(group => group.imports.length > 0);
  for (const group of cycles) group.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return cycles.sort((a, b) => b.files.length - a.files.length || a.files[0].relativePath.localeCompare(b.files[0].relativePath));
}

export interface MapBox {
  id: string;
  kind: 'file' | 'folder';
  folder: string;
  label: string;
  /** Set for a file box; a folder box stands for `count` files. */
  file?: MapFile;
  count: number;
  x: number;
  y: number;
}
/** One import behind an arrow; a guess keeps the reason it could not be settled. */
export type MapLink = ProjectMap['edges'][number] & { guess?: string };

/** Guesses are only drawn; map.edges remains the list of settled imports. */
export function guessedLinks(map: ProjectMap): MapLink[] {
  const files = new Map(map.files.map(file => [file.id, file]));
  const paths = new Map(map.files.map(file => [file.relativePath, file]));
  const links: MapLink[] = [];
  for (const item of map.unresolved) {
    const source = files.get(item.fromFileId);
    if (!source || languageOf(source.relativePath) !== 'python') continue;
    if (item.reason !== 'ambiguous' && item.reason !== 'not-found') continue;
    const { reason, reasonText, candidates, ...imported } = item;
    for (const path of candidates) {
      const target = paths.get(path);
      if (!target || target.id === source.id) continue;
      links.push({ ...imported, toFileId: target.id, names: [], guess: reasonText ?? '후보 여럿' });
    }
  }
  return links;
}

export function arrowCounts(arrow: MapArrow): { sure: number; guessed: number } {
  const guessed = arrow.items.filter(item => item.guess !== undefined).length;
  return { sure: arrow.items.length - guessed, guessed };
}

/** Shared by the drawing and connection lists so both describe the same imports. */
export function arrowLabel(arrow: MapArrow): string | null {
  const { sure, guessed } = arrowCounts(arrow);
  if (sure && guessed) return `import ${sure}개 · 추정 ${guessed}개`;
  if (guessed) return guessed === 1 ? '추정' : `추정 ${guessed}개`;
  return sure > 1 ? `import ${sure}개` : null;
}

/** `back` when the arrow runs right to left, against the column order: the folders may use each other. */
export interface MapArrow { id: string; source: string; target: string; back: boolean; items: MapLink[] }

/** The arrows touching one box, and the boxes at their other ends. */
export function linkedArrows(arrows: MapArrow[], id: string):
  { arrows: MapArrow[]; linked: Set<string>; uses: number; usedBy: number } {
  const touching = arrows.filter(arrow => arrow.source === id || arrow.target === id);
  const linked = new Set(touching.map(arrow => arrow.source === id ? arrow.target : arrow.source));
  return { arrows: touching, linked,
    uses: touching.filter(arrow => arrow.source === id).length,
    usedBy: touching.filter(arrow => arrow.target === id).length };
}

const COLUMN_WIDTH = 320;
// Room between stacked boxes for an arrow inside one folder.
const ROW_HEIGHT = 112;
export const FILE_VIEW_LIMIT = 80;
// List larger direct-file groups: hundreds of arrows proved unreadable in excalidraw measurements.
export const BIG_FOLDER_LIMIT = 30;
export const NEIGHBOR_LIMIT = 20;
export const NEIGHBOR_ROW_HEIGHT = 160;
export const folderName = (folder: string) => folder || '(최상위 폴더)';

/** Full names distinguish boxes in accessible labels and other path-based displays. */
export function boxName(box: MapBox): string {
  if (box.file) return box.file.relativePath;
  if (box.id.startsWith('files:')) return `${folderName(box.folder)} 바로 아래 파일`;
  return folderName(box.folder);
}

/** The opened area a box sits in, and its name inside that area. */
export function boxPlace(box: MapBox): { area: string; short: string } {
  if (box.file) return { area: box.file.folder, short: box.file.relativePath.split('/').at(-1)! };
  if (box.id.startsWith('files:')) return { area: box.folder, short: '바로 아래 파일' };
  const parts = box.folder.split('/');
  return { area: parts.slice(0, -1).join('/'), short: `${parts.at(-1)}/` };
}

/** `a/b/c` → `a`, `a/b`, `a/b/c`; the root folder `''` has none. */
const ancestorsOf = (folder: string) => folder ? folder.split('/').map((_part, index, parts) => parts.slice(0, index + 1).join('/')) : [];

/** Only real areas and direct-file groups can be opened. The root area is always open. */
export function expandableIds(map: ProjectMap): Set<string> {
  const folders = new Set<string>();
  const parents = new Set<string>();
  for (const file of map.files) {
    ancestorsOf(file.folder).forEach((folder, index, ancestors) => {
      folders.add(folder);
      parents.add(index ? ancestors[index - 1] : '');
    });
  }
  const ids = new Set([...folders].map(folder => `folder:${folder}`));
  for (const file of map.files) {
    if (!file.folder || parents.has(file.folder)) ids.add(`files:${file.folder}`);
  }
  return ids;
}

/** Count only files directly inside each folder, including the root. */
export function foldersWithFiles(map: ProjectMap): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of map.files) counts.set(file.folder, (counts.get(file.folder) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([folder, count]) => ({ folder, count }));
}

/** Count distinct neighbours, including files outside the chosen folder. */
export function folderFileList(map: ProjectMap, folder: string): { file: MapFile; uses: number; usedBy: number }[] {
  const neighbours = new Map(map.files.filter(file => file.folder === folder)
    .map(file => [file.id, { file, uses: new Set<string>(), usedBy: new Set<string>() }]));
  for (const edge of map.edges) {
    if (edge.fromFileId === edge.toFileId) continue;
    neighbours.get(edge.fromFileId)?.uses.add(edge.toFileId);
    neighbours.get(edge.toFileId)?.usedBy.add(edge.fromFileId);
  }
  return [...neighbours.values()].map(({ file, uses, usedBy }) => ({ file, uses: uses.size, usedBy: usedBy.size }))
    .sort((a, b) => b.usedBy - a.usedBy || b.uses - a.uses || a.file.relativePath.localeCompare(b.file.relativePath));
}

/** Find direct files exposed by the same ancestor and file-group rules as visibleGraph. */
export function shownBigFolder(opened: ReadonlySet<string>, folders: { folder: string; count: number }[],
  expandable: Set<string>): string | null {
  return [...folders].sort((a, b) => a.folder.localeCompare(b.folder)).find(({ folder, count }) =>
    count > BIG_FOLDER_LIMIT && ancestorsOf(folder).every(path => opened.has(`folder:${path}`))
    && (!expandable.has(`files:${folder}`) || opened.has(`files:${folder}`)))?.folder ?? null;
}

/** Keep only the chosen file's direct connections; mutual neighbours live in the left column. */
export function neighborhoodGraph(map: ProjectMap, fileId: string):
  { boxes: MapBox[]; arrows: MapArrow[]; users: MapFile[]; used: MapFile[]; hidden: { users: number; used: number } } {
  const selected = map.files.find(file => file.id === fileId);
  if (!selected) return { boxes: [], arrows: [], users: [], used: [], hidden: { users: 0, used: 0 } };
  const touching = map.edges.filter(edge => edge.fromFileId !== edge.toFileId
    && (edge.fromFileId === fileId || edge.toFileId === fileId));
  const userIds = new Set(touching.filter(edge => edge.toFileId === fileId).map(edge => edge.fromFileId));
  const usedIds = new Set(touching.filter(edge => edge.fromFileId === fileId).map(edge => edge.toFileId));
  const ordered = [...map.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const users = ordered.filter(file => userIds.has(file.id));
  const used = ordered.filter(file => usedIds.has(file.id));
  const right = used.filter(file => !userIds.has(file.id));
  const boxes: MapBox[] = [users.slice(0, NEIGHBOR_LIMIT), [selected], right.slice(0, NEIGHBOR_LIMIT)]
    .flatMap((files, column) => files.map((file, row) => ({ id: file.id, kind: 'file', folder: file.folder, file,
      label: file.relativePath.split('/').at(-1)!, count: 1, x: column * COLUMN_WIDTH, y: row * NEIGHBOR_ROW_HEIGHT })));
  const arrows = groupedArrows({ ...map, edges: touching }, new Map(boxes.map(box => [box.id, box.id])));
  const positions = new Map(boxes.map(box => [box.id, box.x]));
  for (const arrow of arrows) arrow.back = positions.get(arrow.target)! < positions.get(arrow.source)!;
  return { boxes, arrows, users, used,
    hidden: { users: Math.max(0, users.length - NEIGHBOR_LIMIT), used: Math.max(0, right.length - NEIGHBOR_LIMIT) } };
}

/** Open one folder's direct files and the ancestors needed to reach it. */
export function fileViewOf(folder: string, expandable: Set<string>): Set<string> {
  const opened = new Set(ancestorsOf(folder).map(path => `folder:${path}`).filter(id => expandable.has(id)));
  if (expandable.has(`files:${folder}`)) opened.add(`files:${folder}`);
  return opened;
}

/** A manual open or fold clears the selection unless it exactly matches another folder's file view. */
export function fileViewFolder(opened: ReadonlySet<string>, folders: { folder: string; count: number }[],
  expandable: Set<string>): string | null {
  for (const { folder } of folders) {
    const expected = fileViewOf(folder, expandable);
    if (opened.size === expected.size && [...expected].every(id => opened.has(id))) return folder;
  }
  return null;
}

/** Closing an area also closes its descendants; closing a file group affects only that group. */
export function closeArea(opened: ReadonlySet<string>, id: string): Set<string> {
  if (!id.startsWith('folder:')) return new Set([...opened].filter(entry => entry !== id));
  const folder = id.slice('folder:'.length);
  return new Set([...opened].filter(entry => {
    const path = entry.slice(entry.indexOf(':') + 1);
    return path !== folder && !path.startsWith(`${folder}/`);
  }));
}

/** Merge imports by the boxes that currently contain their endpoints. */
function groupedArrows(map: ProjectMap, shownAs: Map<string, string>): MapArrow[] {
  const arrows = new Map<string, MapArrow>();
  for (const edge of map.edges) {
    const source = shownAs.get(edge.fromFileId);
    const target = shownAs.get(edge.toFileId);
    if (!source || !target || source === target) continue;
    const id = `${source}->${target}`;
    if (!arrows.has(id)) arrows.set(id, { id, source, target, back: false, items: [] });
    arrows.get(id)!.items.push(edge);
  }
  return [...arrows.values()];
}

/** Longest use chains come first. Cycles stop after one round per visible box. */
function columnLevels(ids: string[], arrows: MapArrow[]): Map<string, number> {
  const levels = new Map(ids.map(id => [id, 0]));
  for (let round = 0; round < ids.length; round++) {
    let changed = false;
    for (const arrow of arrows) {
      if (levels.get(arrow.target)! + 1 <= levels.get(arrow.source)!) continue;
      levels.set(arrow.source, levels.get(arrow.target)! + 1);
      changed = true;
    }
    if (!changed) break;
  }
  return levels;
}

/** The text list keeps the original, innermost-folder connections regardless of opened areas. */
export function folderArrows(map: ProjectMap): MapArrow[] {
  const arrows = groupedArrows(map, new Map(map.files.map(file => [file.id, `folder:${file.folder}`])));
  const folders = [...new Set(map.files.map(file => `folder:${file.folder}`))];
  const levels = columnLevels(folders, arrows);
  const order = folders.sort((a, b) => levels.get(b)! - levels.get(a)! || a.localeCompare(b));
  const columns = new Map(order.map((id, column) => [id, column]));
  for (const arrow of arrows) arrow.back = columns.get(arrow.target)! < columns.get(arrow.source)!;
  return arrows;
}

/** Show one level inside opened areas, then place the visible boxes in compact columns. */
export function visibleGraph(map: ProjectMap, opened: ReadonlySet<string>, expandable = expandableIds(map)):
  { boxes: MapBox[]; arrows: MapArrow[] } {
  const shownAs = new Map<string, string>();
  const byId = new Map<string, MapBox>();
  for (const file of map.files) {
    const closed = ancestorsOf(file.folder).find(folder => !opened.has(`folder:${folder}`));
    const group = `files:${file.folder}`;
    const grouped = closed === undefined && expandable.has(group) && !opened.has(group);
    const id = closed !== undefined ? `folder:${closed}` : grouped ? group : file.id;
    shownAs.set(file.id, id);
    const existing = byId.get(id);
    if (existing) { existing.count++; continue; }
    const isFile = id === file.id;
    byId.set(id, { id, kind: isFile ? 'file' : 'folder', folder: closed ?? file.folder,
      label: '', file: isFile ? file : undefined, count: 1, x: 0, y: 0 });
  }
  const boxes = [...byId.values()];
  for (const box of boxes) {
    if (box.file) { box.label = box.file.relativePath.split('/').at(-1)!; continue; }
    box.label = box.id.startsWith('files:') ? `${folderName(box.folder)} 바로 아래 파일 · ${box.count}개`
      : `${folderName(box.folder)} · 파일 ${box.count}개`;
  }
  const arrows = groupedArrows(map, shownAs);
  const levels = columnLevels(boxes.map(box => box.id), arrows);
  const columns = new Map([...new Set(levels.values())].sort((a, b) => b - a).map((level, column) => [level, column]));
  boxes.sort((a, b) => levels.get(b.id)! - levels.get(a.id)!
    || (a.file?.relativePath ?? a.folder).localeCompare(b.file?.relativePath ?? b.folder));
  const rows = new Map<number, number>();
  for (const box of boxes) {
    const column = columns.get(levels.get(box.id)!)!;
    box.x = column * COLUMN_WIDTH;
    box.y = (rows.get(column) ?? 0) * ROW_HEIGHT;
    rows.set(column, (rows.get(column) ?? 0) + 1);
  }
  for (const arrow of arrows) arrow.back = byId.get(arrow.target)!.x < byId.get(arrow.source)!.x;
  return { boxes, arrows };
}

/**
 * The import evidence on screen for a map entry. Like a start candidate, a map entry is trusted only
 * while the file still has the hash it had when the map was drawn; the range then names the evidence.
 */
export function matchImport(source: SourceView, item: MapImport):
  { status: 'found'; evidence: Evidence } | { status: 'changed' } | { status: 'missing' } {
  if (source.fileId !== item.fromFileId || source.hash !== item.fileHash) return { status: 'changed' };
  const found = source.analysis.imports.find(entry => entry.evidence.startUtf16 === item.startUtf16 && entry.evidence.endUtf16 === item.endUtf16);
  return found ? { status: 'found', evidence: found.evidence } : { status: 'missing' };
}

/** The same for a function from the map's list or a call's target: 'missing' when the analyzer's limits left it out. */
export function matchFunction(source: SourceView, item: Pick<MapFunction, 'fileId' | 'fileHash' | 'startUtf16' | 'endUtf16'>):
  { status: 'found'; symbol: CodeSymbol } | { status: 'changed' } | { status: 'missing' } {
  if (source.fileId !== item.fileId || source.hash !== item.fileHash) return { status: 'changed' };
  const found = source.analysis.symbols.find(symbol => symbol.evidence.startUtf16 === item.startUtf16 && symbol.evidence.endUtf16 === item.endUtf16);
  return found ? { status: 'found', symbol: found } : { status: 'missing' };
}

/**
 * The analyzer's step for a call from the call search: a call expression, or the body of an arrow that is
 * just the call (`() => save()`). 'missing' for a call outside any function or past the analyzer's limits.
 */
export function matchCallStep(source: SourceView, site: Pick<CallSite, 'fileId' | 'fileHash' | 'startUtf16' | 'endUtf16'>):
  { status: 'found'; symbol: CodeSymbol; step: CodeStep } | { status: 'changed' } | { status: 'missing' } {
  if (source.fileId !== site.fileId || source.hash !== site.fileHash) return { status: 'changed' };
  for (const symbol of source.analysis.symbols) {
    const step = symbol.steps.find(item => (item.kind === 'call_expression' || item.kind === 'expression_body')
      && item.evidence.startUtf16 === site.startUtf16 && item.evidence.endUtf16 === site.endUtf16);
    if (step) return { status: 'found', symbol, step };
  }
  return { status: 'missing' };
}
