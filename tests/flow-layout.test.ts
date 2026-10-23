import { expect, it } from 'vitest';
import type { FeatureFlow, FlowNode } from '../src/shared/contracts';
import { layoutFlow } from '../src/renderer/flow-layout';

const node = (id: string, side: FlowNode['side'], depth: number): FlowNode => ({
  id, side, depth, fileId: id, fileHash: 'h', relativePath: `${id}.ts`, name: id,
  range: { startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1 },
  event: null, screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0,
});
const flow = (nodes: FlowNode[], edges: FeatureFlow['edges'] = []): FeatureFlow => ({
  projectId: 'p', routesId: 'r', routeIndex: 0, nodes, edges, limited: false, notes: [],
});
const edges = (pairs: string[][]): FeatureFlow['edges'] =>
  pairs.map(([from, to]) => ({ from, to, kind: 'calls', sure: true, reasons: [], site: null }));

it('orders frontend depths descending, requests, then backend depths ascending, keeping creation order within columns', () => {
  const input = flow([
    node('handler', 'back', 0), node('request-b', 'request', 0), node('near', 'front', 1),
    node('service-b', 'back', 1), node('far-b', 'front', 4), node('deep', 'back', 3),
    node('request-a', 'request', 0), node('far-a', 'front', 4), node('service-a', 'back', 1), node('middle', 'back', 2),
  ]);
  const before = structuredClone(input);
  expect(layoutFlow(input).map(({ node, step }) => [node.id, step])).toEqual([
    ['far-b', 0], ['far-a', 0], ['near', 1], ['request-b', 2], ['request-a', 2], ['handler', 3],
    ['service-b', 4], ['service-a', 4], ['middle', 5], ['deep', 6],
  ]);
  expect(input).toEqual(before);
  expect(layoutFlow(input)).toEqual(layoutFlow(input));
});

it('wraps every four steps onto a new band below, starting again on the left', () => {
  const input = flow([
    node('far-b', 'front', 4), node('far-a', 'front', 4), node('near', 'front', 1), node('request', 'request', 0),
    node('handler', 'back', 0), node('service-b', 'back', 1), node('service-a', 'back', 1),
  ]);
  expect(layoutFlow(input).map(({ node, x, y }) => [node.id, x, y])).toEqual([
    ['far-b', 0, 0], ['far-a', 0, 110], ['near', 260, 0], ['request', 520, 0], ['handler', 780, 0],
    // The first band is two boxes tall: 2 × 110 + 70.
    ['service-b', 0, 290], ['service-a', 0, 400],
  ]);
});

it('keeps every frontend arrow forward in reading order, including the two paths from DogList to its hook', () => {
  const input = flow([
    node('handler', 'back', 0), node('request', 'request', 0), node('mutationFn', 'front', 1),
    node('useDeleteDog', 'front', 2), node('DogList', 'front', 6), node('removeDog', 'front', 3),
    node('onClick', 'front', 4), node('map callback', 'front', 5), node('DogsPage', 'front', 7),
  ], edges([
    ['DogsPage', 'DogList'], ['DogList', 'useDeleteDog'], ['DogList', 'map callback'],
    ['map callback', 'onClick'], ['onClick', 'removeDog'], ['removeDog', 'useDeleteDog'],
    ['useDeleteDog', 'mutationFn'], ['mutationFn', 'request'], ['request', 'handler'],
  ]));
  const steps = new Map(layoutFlow(input).map(box => [box.node.id, box.step]));
  for (const edge of input.edges) expect(steps.get(edge.from), `${edge.from} → ${edge.to}`).toBeLessThan(steps.get(edge.to)!);
});

it('finishes with cycles and self-calls, retaining every node and supplied depth', () => {
  const input = flow([node('a', 'front', 1), node('b', 'front', 2), node('request', 'request', 0)],
    edges([['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'request']]));
  expect(layoutFlow(input).map(({ node, step }) => [node.id, node.depth, step])).toEqual([
    ['b', 2, 0], ['a', 1, 1], ['request', 0, 2],
  ]);
});

it('handles an empty flow and a backend-only flow without empty leading columns', () => {
  expect(layoutFlow(flow([]))).toEqual([]);
  expect(layoutFlow(flow([node('handler', 'back', 0), node('service', 'back', 1)]))
    .map(({ node, x, y }) => [node.id, x, y])).toEqual([['handler', 0, 0], ['service', 260, 0]]);
});
