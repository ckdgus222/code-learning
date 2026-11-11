import type { MapFile } from '../shared/contracts';
import type { MapLink } from './map-layout';

/** One hop, with settled imports before guesses. */
export interface PathStep { from: MapFile; to: MapFile; links: MapLink[] }
export type ImportPath =
  | { status: 'same' }
  | { status: 'found'; steps: PathStep[]; guessed: boolean }
  | { status: 'none'; reverse: 'settled' | 'guessed' | null };
export interface PathGraph { outgoing: Map<string, Map<string, PathStep>> }

/** Group once per map, preserving the first appearance of each destination. */
export function pathGraph(files: MapFile[], links: MapLink[]): PathGraph {
  const byId = new Map(files.map(file => [file.id, file]));
  const outgoing: PathGraph['outgoing'] = new Map(files.map(file => [file.id, new Map()]));
  for (const link of links) {
    const from = byId.get(link.fromFileId);
    const to = byId.get(link.toFileId);
    if (!from || !to || from.id === to.id) continue;
    const neighbors = outgoing.get(from.id)!;
    if (!neighbors.has(to.id)) neighbors.set(to.id, { from, to, links: [] });
    neighbors.get(to.id)!.links.push(link);
  }
  for (const neighbors of outgoing.values()) {
    for (const step of neighbors.values()) {
      step.links = [...step.links.filter(link => link.guess === undefined), ...step.links.filter(link => link.guess !== undefined)];
    }
  }
  return { outgoing };
}

/** Breadth-first, so the end is first reached by a shortest path. A step whose first link is a guess has no settled import. */
function walk(graph: PathGraph, start: string, end: string, allowGuesses: boolean): PathStep[] | null {
  const previous = new Map<string, PathStep | null>([[start, null]]);
  const queue = [start];
  // A cursor avoids repeatedly shifting a wide queue; predecessors avoid copying paths.
  for (let cursor = 0; cursor < queue.length && !previous.has(end); cursor++) {
    for (const step of graph.outgoing.get(queue[cursor])?.values() ?? []) {
      if (!allowGuesses && step.links[0].guess !== undefined) continue;
      if (previous.has(step.to.id)) continue;
      previous.set(step.to.id, step);
      queue.push(step.to.id);
    }
  }
  if (!previous.has(end)) return null;
  const steps: PathStep[] = [];
  for (let step = previous.get(end); step; step = previous.get(step.from.id)) steps.push(step);
  return steps.reverse();
}

/** Settled imports first; guesses are followed only when those give no path (user decision). */
function find(graph: PathGraph, start: string, end: string): { steps: PathStep[]; guessed: boolean } | null {
  const steps = walk(graph, start, end, false) ?? walk(graph, start, end, true);
  return steps && { steps, guessed: steps.some(step => step.links[0].guess !== undefined) };
}

export function importPath(graph: PathGraph, fromId: string, toId: string): ImportPath {
  if (fromId === toId) return { status: 'same' };
  const forward = find(graph, fromId, toId);
  if (forward) return { status: 'found', ...forward };
  const reverse = find(graph, toId, fromId);
  return { status: 'none', reverse: reverse ? reverse.guessed ? 'guessed' : 'settled' : null };
}
