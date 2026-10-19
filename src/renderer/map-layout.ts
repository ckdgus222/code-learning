import type { Evidence, MapFile, MapImport, ProjectMap, SourceView } from '../shared/contracts';

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

const COLUMN_WIDTH = 320;
// Room between stacked boxes for an arrow inside one folder.
const ROW_HEIGHT = 112;
// Folder boxes step down one row per column, so arrows between folders do not lie on one line.
const FOLDER_STEP = 96;
export const folderName = (folder: string) => folder || '(최상위 폴더)';
const folderBox = (folder: string) => `folder:${folder}`;

/**
 * Folders in column order, so arrows run left to right wherever the imports allow: a folder sits left
 * of every folder it uses, by the longest chain of uses after it, and one that uses no other folder sits
 * furthest right. Without a cycle every arrow then runs left to right. Inside an import cycle no order can
 * do that; the rounds stop after one per folder and the backward arrows are drawn dashed. Ties keep path
 * order. This is a fixed rule, not a layout engine.
 */
function columnOrder(map: ProjectMap, folders: string[]): string[] {
  const folderOf = new Map(map.files.map(file => [file.id, file.folder]));
  const uses = new Map<string, [string, string]>();
  for (const edge of map.edges) {
    const from = folderOf.get(edge.fromFileId);
    const to = folderOf.get(edge.toFileId);
    if (from !== undefined && to !== undefined && from !== to) uses.set(`${from}\0${to}`, [from, to]);
  }
  const level = new Map(folders.map(folder => [folder, 0]));
  for (let round = 0; round < folders.length; round++) {
    let changed = false;
    for (const [from, to] of uses.values()) {
      if (level.get(to)! + 1 > level.get(from)!) { level.set(from, level.get(to)! + 1); changed = true; }
    }
    if (!changed) break;
  }
  return [...folders].sort((a, b) => level.get(b)! - level.get(a)! || a.localeCompare(b));
}

/**
 * The boxes and arrows to draw. A file shows as itself when its folder is expanded, otherwise as its
 * folder's box; arrows between the shown boxes are merged and counted, and arrows that stay inside one
 * folder box are left out. Layout is a fixed rule: one column per folder (columnOrder), files by name.
 */
export function visibleGraph(map: ProjectMap, expanded: ReadonlySet<string>): { boxes: MapBox[]; arrows: MapArrow[] } {
  const folders = columnOrder(map, [...new Set(map.files.map(file => file.folder))].sort((a, b) => a.localeCompare(b)));
  const shownAs = new Map<string, string>();
  const boxes: MapBox[] = [];
  folders.forEach((folder, column) => {
    const files = map.files.filter(file => file.folder === folder);
    if (!expanded.has(folder)) {
      boxes.push({ id: folderBox(folder), kind: 'folder', folder, label: `${folderName(folder)} · 파일 ${files.length}개`,
        count: files.length, x: column * COLUMN_WIDTH, y: column * FOLDER_STEP });
      for (const file of files) shownAs.set(file.id, folderBox(folder));
      return;
    }
    files.forEach((file, row) => {
      boxes.push({ id: file.id, kind: 'file', folder, label: file.relativePath.split('/').at(-1)!, file, count: 1,
        x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT });
      shownAs.set(file.id, file.id);
    });
  });
  const arrows = new Map<string, MapArrow>();
  const xOf = new Map(boxes.map(box => [box.id, box.x]));
  for (const edge of map.edges) {
    const source = shownAs.get(edge.fromFileId);
    const target = shownAs.get(edge.toFileId);
    if (!source || !target || source === target) continue;
    const id = `${source}->${target}`;
    if (!arrows.has(id)) arrows.set(id, { id, source, target, back: xOf.get(target)! < xOf.get(source)!, items: [] });
    arrows.get(id)!.items.push(edge);
  }
  return { boxes, arrows: [...arrows.values()] };
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
