export type NextSegment = { text: string } | { param: string } | { catchAll: string; optional: boolean };
export interface NextRoute {
  root: string;
  kind: 'page' | 'layout' | 'route' | 'pages-api';
  segments: NextSegment[];
}

export const isNextConfig = (path: string) => /(?:^|\/)next\.config\.(?:js|mjs|cjs|ts|mts)$/.test(path);

export function nextRouteOf(relativePath: string, projectPaths: string[]): NextRoute | null {
  const parts = relativePath.split('/');
  const configs = new Set(projectPaths.filter(isNextConfig)
    .map(path => path.split('/').slice(0, -1).join('/')));
  const roots = parts.slice(0, -1).flatMap((part, index) => {
    if (part !== 'app' && !(part === 'pages' && parts[index + 1] === 'api')) return [];
    const parent = parts.slice(0, index);
    if (parent.at(-1) === 'src') parent.pop();
    return configs.has(parent.join('/')) ? [index] : [];
  });
  if (roots.length !== 1) return null;
  const index = roots[0];
  const filename = parts.at(-1)!;
  const pages = parts[index] === 'pages';
  const kind = pages ? (/\.(?:tsx|jsx|ts|js)$/.test(filename) ? 'pages-api' : null)
    : /^page\.(?:tsx|jsx|ts|js)$/.test(filename) ? 'page'
      : /^layout\.[^.]+$/.test(filename) ? 'layout' : /^route\.(?:ts|js)$/.test(filename) ? 'route' : null;
  if (!kind) return null;
  const folders = parts.slice(index + 1, -1);
  if (folders.some(part => part.startsWith('_') || /^\(\.{1,3}\)/.test(part) || part.includes('%'))) return null;
  const routeParts = pages ? [...folders, filename.replace(/\.[^.]+$/, '')].filter((part, i, all) => !(i === all.length - 1 && part === 'index'))
    : folders.filter(part => !/^\(.*\)$/.test(part) && !part.startsWith('@'));
  const segments: NextSegment[] = routeParts.map(part => {
    const optional = part.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optional) return { catchAll: optional[1], optional: true };
    const catchAll = part.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) return { catchAll: catchAll[1], optional: false };
    const param = part.match(/^\[(.+)\]$/);
    return param ? { param: param[1] } : { text: part };
  });
  return { root: parts.slice(0, index + 1).join('/'), kind, segments };
}

export function formatNextPath(segments: NextSegment[]): string {
  return '/' + segments.map(segment => 'text' in segment ? segment.text : 'param' in segment ? `:${segment.param}` : `:${segment.catchAll}*`).join('/');
}
