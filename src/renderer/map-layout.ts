import type { CallSite, CodeStep, CodeSymbol, Evidence, MapFile, MapFunction, MapImport, ProjectMap, SourceView } from '../shared/contracts';

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
/** `back` when the arrow runs right to left, against the column order: the folders may use each other. */
export interface MapArrow { id: string; source: string; target: string; back: boolean; items: ProjectMap['edges'] }

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
export const folderName = (folder: string) => folder || '(최상위 폴더)';

/** Names in connection lists keep full paths to distinguish files with the same basename. */
export function boxName(box: MapBox): string {
  if (box.file) return box.file.relativePath;
  if (box.id.startsWith('files:')) return `${folderName(box.folder)} 바로 아래 파일`;
  return folderName(box.folder);
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
