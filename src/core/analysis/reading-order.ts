import type { MapFile, ProjectMap, ReadingOrder, ReadingStep } from '../../shared/contracts';
import { isConfigFile, isTestPath, typeDeclarationFile } from './unused-files';

// Helpers kept beside tests, and the names pytest collects by default.
export const pythonTestFile = (relativePath: string) => /(?:^|\/)tests?\//.test(relativePath)
  || /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/.test(relativePath);

export const READING_STARTS = 3;
export const READING_STEPS = 30;

/**
 * Tests, configuration and type declarations: left out of the order, and their imports are not counted.
 * A test imports the code it checks and nothing imports the test, so it would otherwise be picked as a start file.
 */
export function supportFile(relativePath: string): boolean {
  return isTestPath(relativePath) || isConfigFile(relativePath) || typeDeclarationFile.test(relativePath)
    || pythonTestFile(relativePath);
}

/**
 * How many other files the imports of `from` lead to. `visited` and `queue` are shared by every call:
 * a start candidate marks its own walk with `stamp`, so a map of a thousand candidates allocates nothing more.
 */
function countReached(links: number[][], from: number, visited: Uint32Array, queue: Uint32Array, stamp: number): number {
  let head = 0;
  let tail = 1;
  queue[0] = from;
  visited[from] = stamp;
  while (head < tail) {
    for (const next of links[queue[head++]]) {
      if (visited[next] === stamp) continue;
      visited[next] = stamp;
      queue[tail++] = next;
    }
  }
  return tail - 1;
}

/** `linksCut`: import results were left out at a map limit while every file still counts as fully read. */
export function readingOrder(files: MapFile[], edges: ProjectMap['edges'], linksCut: boolean): ReadingOrder {
  const incomplete = linksCut || files.some(file => ['partial', 'failed', 'skipped'].includes(file.checked));
  const targets = files.filter(file => file.checked !== 'not-code' && !supportFile(file.relativePath));
  const indices = new Map(targets.map((file, index) => [file.id, index]));
  const outgoing = targets.map(() => new Set<number>());
  const usedBy = new Uint32Array(targets.length);
  for (const edge of edges) {
    const from = indices.get(edge.fromFileId);
    const to = indices.get(edge.toFileId);
    if (from === undefined || to === undefined || from === to || outgoing[from].has(to)) continue;
    outgoing[from].add(to);
    usedBy[to]++;
  }
  const links = outgoing.map(neighbors => [...neighbors]);
  // With no candidate (no imports, or every file in a loop) nothing below is reached and the order is empty.
  const candidates = targets.map((_, index) => index).filter(index => usedBy[index] === 0 && links[index].length > 0);
  const visited = new Uint32Array(targets.length);
  const queue = new Uint32Array(targets.length);
  const starts = candidates.map((index, candidate) => ({ index, reaches: countReached(links, index, visited, queue, candidate + 1) }))
    .sort((a, b) => b.reaches - a.reaches || targets[a.index].relativePath.localeCompare(targets[b.index].relativePath))
    .slice(0, READING_STARTS);

  // One walk from the chosen starts together gives each file its distance from the nearest of them.
  const depth = new Int32Array(targets.length).fill(-1);
  let head = 0;
  let tail = 0;
  for (const start of starts) {
    depth[start.index] = 0;
    queue[tail++] = start.index;
  }
  while (head < tail) {
    const current = queue[head++];
    for (const next of links[current]) {
      if (depth[next] !== -1) continue;
      depth[next] = depth[current] + 1;
      queue[tail++] = next;
    }
  }
  const following = targets.map((_, index) => index).filter(index => depth[index] > 0)
    .sort((a, b) => depth[a] - depth[b] || usedBy[b] - usedBy[a] || targets[a].relativePath.localeCompare(targets[b].relativePath));
  const steps: ReadingStep[] = starts.map(({ index, reaches }) => ({ kind: 'start', fileId: targets[index].id, reaches }));
  steps.push(...following.slice(0, READING_STEPS - steps.length).map((index): ReadingStep => ({
    kind: 'next', fileId: targets[index].id, depth: depth[index], usedBy: usedBy[index],
  })));
  return { steps, total: tail, incomplete };
}
