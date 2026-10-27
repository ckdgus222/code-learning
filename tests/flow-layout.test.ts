import { expect, it } from 'vitest';
import type { FeatureFlow, FlowNode } from '../src/shared/contracts';
import { getSmoothStepPath, Position } from '@xyflow/react';
import { edgeRoute, layoutFlow } from '../src/renderer/flow-layout';

const node = (id: string, side: FlowNode['side'], depth: number): FlowNode => ({
  id, side, depth, fileId: id, fileHash: 'h', relativePath: `${id}.ts`, name: id,
  range: { startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1 },
  event: null, control: null, asks: [], after: [], afterOmitted: 0, screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0,
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
  expect(layoutFlow(input).boxes.map(({ node, step }) => [node.id, step])).toEqual([
    ['far-b', 0], ['far-a', 0], ['near', 1], ['request-b', 2], ['request-a', 2], ['handler', 3],
    ['service-b', 4], ['service-a', 4], ['middle', 5], ['deep', 6],
  ]);
  expect(input).toEqual(before);
  expect(layoutFlow(input)).toEqual(layoutFlow(input));
});

it('stacks boxes in three fixed lanes with shared heights and lane-local rows', () => {
  const input = flow([
    node('near', 'front', 1), node('service', 'back', 1), node('request', 'request', 0),
    node('far', 'front', 4), node('handler', 'back', 0),
  ]);
  const { boxes, lanes } = layoutFlow(input);
  expect(boxes.map(({ node, x, y, row }) => [node.id, x, y, row])).toEqual([
    ['far', 60, 70, 0], ['near', 60, 180, 1], ['request', 380, 70, 0],
    ['handler', 700, 70, 0], ['service', 700, 180, 1],
  ]);
  expect(lanes).toEqual([
    { side: 'front', title: '화면 쪽', x: 0, width: 320, height: 310, empty: false },
    { side: 'request', title: '요청', x: 320, width: 320, height: 310, empty: false },
    { side: 'back', title: '서버 쪽', x: 640, width: 320, height: 310, empty: false },
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
  checkRoutes(input);
  const steps = new Map(layoutFlow(input).boxes.map(box => [box.node.id, box.step]));
  for (const edge of input.edges) expect(steps.get(edge.from), `${edge.from} → ${edge.to}`).toBeLessThan(steps.get(edge.to)!);
});

it('finishes with cycles and self-calls, retaining every node and supplied depth', () => {
  const input = flow([node('a', 'front', 1), node('b', 'front', 2), node('request', 'request', 0)],
    edges([['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'request']]));
  checkRoutes(input);
  expect(layoutFlow(input).boxes.map(({ node, step }) => [node.id, node.depth, step])).toEqual([
    ['b', 2, 0], ['a', 1, 1], ['request', 0, 2],
  ]);
});

it('keeps all three lanes for empty and backend-only flows', () => {
  const empty = layoutFlow(flow([]));
  expect(empty.boxes).toEqual([]);
  expect(empty.lanes).toHaveLength(3);
  expect(empty.lanes.every(lane => lane.empty && lane.height === 200)).toBe(true);
  const back = layoutFlow(flow([node('handler', 'back', 0), node('service', 'back', 1)]));
  expect(back.boxes.map(({ node, x, y }) => [node.id, x, y])).toEqual([['handler', 700, 70], ['service', 700, 180]]);
  expect(back.lanes.map(lane => lane.empty)).toEqual([true, true, false]);
  expect(back.lanes.map(lane => lane.height)).toEqual([310, 310, 310]);
});

function checkRoutes(input: FeatureFlow) {
  const boxes = new Map(layoutFlow(input).boxes.map(box => [box.node.id, box]));
  for (const edge of input.edges) {
    const from = boxes.get(edge.from)!;
    const to = boxes.get(edge.to)!;
    const route = edgeRoute(from, to);
    if (from.node.id === to.node.id) {
      expect(route).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-top', type: 'smoothstep' });
      continue;
    }
    if (from.node.side !== to.node.side) {
      expect(route).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left' });
      continue;
    }
    expect(route).toEqual(to.row === from.row + 1
      ? { sourceHandle: 'out-bottom', targetHandle: 'in-top', type: 'straight' }
      : { sourceHandle: 'out-right', targetHandle: 'in-right', type: 'smoothstep' });
  }
}

it.each(['self', 'upward'] as const)('keeps %s smoothstep paths from collapsing to a line', kind => {
  const { boxes } = layoutFlow(flow([node('upper', 'back', 0), node('lower', 'back', 1)]));
  const from = boxes[1];
  const to = kind === 'self' ? from : boxes[0];
  const route = edgeRoute(from, to);
  expect(route.type).toBe('smoothstep');
  const [path] = getSmoothStepPath({ sourceX: from.x + 200, sourceY: from.y + 30, sourcePosition: Position.Right,
    targetX: to.x + (route.targetHandle === 'in-top' ? 100 : 200),
    targetY: to.y + (route.targetHandle === 'in-top' ? 0 : 30),
    targetPosition: route.targetHandle === 'in-top' ? Position.Top : Position.Right });
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
});
