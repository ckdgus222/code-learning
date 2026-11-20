/** Source-set paths are project-relative. An empty root is the project itself. */
export function javaModuleRoot(relative: string): string | null {
  const path = '/' + relative;
  const marker = path.lastIndexOf('/src/main/java/');
  return marker < 0 ? null : path.slice(1, marker);
}

/** The resource directory itself or a direct default/profile configuration file. */
export function bootResource(relative: string): { root: string; name: string } | null {
  const match = /(?:^|\/)src\/main\/resources(?:\/(application(?:-[^/]+)?\.(?:properties|ya?ml)))?$/.exec(relative);
  return match ? { root: relative.slice(0, match.index), name: match[1] ?? '' } : null;
}
