import type { ProjectFile } from '../shared/contracts';

export interface TreeFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: (TreeFolder | TreeFile)[];
}

export interface TreeFile {
  kind: 'file';
  name: string;
  file: ProjectFile;
}

export function buildFileTree(files: ProjectFile[]): TreeFolder {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] };
  const folders = new Map<string, TreeFolder>([['', root]]);
  for (const file of files) {
    const parts = file.relativePath.split('/');
    const name = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: 'folder', name: part, path, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ kind: 'file', name, file });
  }
  for (const folder of folders.values()) {
    folder.children.sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name) : left.kind === 'folder' ? -1 : 1);
  }
  return root;
}

export function filterFileTree(tree: TreeFolder, search: string): TreeFolder {
  if (!search) return tree;
  const query = search.toLowerCase();
  const children: TreeFolder['children'] = [];
  for (const child of tree.children) {
    if (child.kind === 'folder') {
      const folder = filterFileTree(child, query);
      if (folder.children.length) children.push(folder);
    } else if (child.file.relativePath.toLowerCase().includes(query)) {
      children.push(child);
    }
  }
  return { ...tree, children };
}

export function ancestorFolderPaths(relativePath: string): string[] {
  const parts = relativePath.split('/');
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}
