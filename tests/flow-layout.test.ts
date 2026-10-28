import { expect, it } from 'vitest';
import type { FeatureFlow, FlowNode } from '../src/shared/contracts';
import { getSmoothStepPath, Position } from '@xyflow/react';
import { edgeRoute, layoutFlow, routeEdges, type EdgeRouteInfo, type FlowBox } from '../src/renderer/flow-layout';
import { SIDE_HANDLE_TOP } from '../src/renderer/feature-flow';

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
      expect(route).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left',
        type: from.row === to.row ? 'straight' : 'smoothstep' });
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

it('starts all three lanes at the top with eight frontend boxes and bends the caller-to-request path', () => {
  const front = ['DogsPage', 'DogList', 'map callback', 'onClick', 'removeDog', 'useDeleteDog', 'options', 'mutationFn']
    .map((id, index) => node(id, 'front', 8 - index));
  const input = flow([...front, node('request', 'request', 0), node('handler', 'back', 0), node('service', 'back', 1)],
    edges([['mutationFn', 'request'], ['request', 'handler'], ['handler', 'service']]));
  const { boxes, lanes } = layoutFlow(input);
  expect(boxes.map(box => box.row)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 1]);
  expect([boxes[0], boxes[8], boxes[9]].map(box => box.y)).toEqual([70, 70, 70]);
  expect(lanes.map(lane => lane.height)).toEqual([970, 970, 970]);
  expect(edgeRoute(boxes[7], boxes[8])).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left', type: 'smoothstep' });
  expect(edgeRoute(boxes[8], boxes[9])).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left', type: 'straight' });
  const from = boxes[7];
  const to = boxes[8];
  const [path] = getSmoothStepPath({ sourceX: from.x + 200, sourceY: from.y + 24, sourcePosition: Position.Right,
    targetX: to.x, targetY: to.y + 24, targetPosition: Position.Left });
  expect(path.match(/[A-Za-z]/g)!.every(command => ['M', 'L', 'Q'].includes(command))).toBe(true);
  const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)];
  expect(commands.length).toBeGreaterThan(2);
  let previous = [from.x + 200, from.y + 24];
  for (const [, command, coordinates] of commands) {
    const values = coordinates.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    // Rounded corners have two perpendicular tangents; every straight segment follows an axis.
    expect(values[0] === previous[0] || values[1] === previous[1], path).toBe(true);
    if (command === 'Q') expect(values[0] === values[2] || values[1] === values[3], path).toBe(true);
    previous = values.slice(-2);
  }
  expect(previous).toEqual([to.x, to.y + 24]);
});

it('separates requests sharing a caller and bends the second connection to their shared server', () => {
  const input = flow([node('screen', 'front', 2), node('caller', 'front', 1), node('first', 'request', 0),
    node('second', 'request', 0), node('handler', 'back', 0)],
  edges([['caller', 'first'], ['caller', 'second'], ['first', 'handler'], ['second', 'handler']]));
  const { boxes } = layoutFlow(input);
  expect(boxes.map(box => box.row)).toEqual([0, 1, 0, 1, 0]);
  const from = boxes[3];
  const to = boxes[4];
  expect(edgeRoute(from, to)).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left', type: 'smoothstep' });
  const [path] = getSmoothStepPath({ sourceX: from.x + 200, sourceY: from.y + 24, sourcePosition: Position.Right,
    targetX: to.x, targetY: to.y + 24, targetPosition: Position.Left });
  expect(path.match(/[A-Za-z]/g)!.every(command => ['M', 'L', 'Q'].includes(command))).toBe(true);
  const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)];
  expect(commands.length).toBeGreaterThan(2);
  let previous = [from.x + 200, from.y + 24];
  for (const [, command, coordinates] of commands) {
    const values = coordinates.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    // Rounded corners have two perpendicular tangents; every straight segment follows an axis.
    expect(values[0] === previous[0] || values[1] === previous[1], path).toBe(true);
    if (command === 'Q') expect(values[0] === values[2] || values[1] === values[3], path).toBe(true);
    previous = values.slice(-2);
  }
  expect(previous).toEqual([to.x, to.y + 24]);
});

it.each(['none', 'back', 'request'] as const)('starts an uncalled request at row zero with incoming=%s', incoming => {
  const input = flow([node('request', 'request', 0), node('other', 'request', 0),
    node('handler', 'back', 0), node('service', 'back', 1)],
  incoming === 'none' ? [] : edges([[incoming === 'back' ? 'service' : 'other', 'request']]));
  expect(layoutFlow(input).boxes.map(box => box.row)).toEqual([0, 1, 0, 1]);
});

it('stacks requests without gaps and connects adjacent rows vertically when callers go upward', () => {
  const input = flow([...Array.from({ length: 4 }, (_, i) => node(`front${i}`, 'front', 4 - i)),
    node('first', 'request', 0), node('second', 'request', 0), node('third', 'request', 0), node('handler', 'back', 0)],
  edges([['front0', 'first'], ['front3', 'second'], ['front0', 'third'], ['first', 'second']]));
  const { boxes, lanes } = layoutFlow(input);
  expect(boxes.slice(4).map(box => box.row)).toEqual([0, 1, 2, 0]);
  expect(lanes.every(lane => lane.height === 530)).toBe(true);
  expect(edgeRoute(boxes[4], boxes[5])).toEqual({ sourceHandle: 'out-bottom', targetHandle: 'in-top', type: 'straight' });
});

function smoothPath(from: FlowBox, to: FlowBox, route: EdgeRouteInfo): string {
  return getSmoothStepPath({ sourceX: from.x + 200, sourceY: from.y + SIDE_HANDLE_TOP, sourcePosition: Position.Right,
    targetX: to.x + (route.targetHandle === 'in-top' ? 100 : route.targetHandle === 'in-right' ? 200 : 0),
    targetY: to.y + (route.targetHandle === 'in-top' ? 0 : SIDE_HANDLE_TOP),
    targetPosition: route.targetHandle === 'in-top' ? Position.Top
      : route.targetHandle === 'in-right' ? Position.Right : Position.Left,
    ...route.pathOptions })[0];
}

function verticalXs(path: string): number[] {
  const xs: number[] = [];
  let previous: number[] = [];
  for (const [, command, coordinates] of path.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const values = coordinates.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    if (command === 'L' && values[0] === previous[0] && values[1] !== previous[1]) xs.push(values[0]);
    previous = values.slice(-2);
  }
  return xs;
}

const mixedGap = flow([
  ...Array.from({ length: 4 }, (_, index) => node(`front${index}`, 'front', 4 - index)),
  ...Array.from({ length: 3 }, (_, index) => node(`request${index}`, 'request', 0)),
], edges([['front0', 'request1'], ['front1', 'request2'], ['front3', 'request0'],
  ['front0', 'front3'], ['front3', 'front1'], ['front2', 'front2']]));

it('spreads mixed cross-lane, outside and self-call paths into distinct positions in the same gap', () => {
  const { boxes } = layoutFlow(mixedGap);
  const before = structuredClone({ edges: mixedGap.edges, boxes });
  const routes = routeEdges(mixedGap.edges, boxes);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const xs = routes.map((route, index) => {
    const edge = mixedGap.edges[index];
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    expect(route).toMatchObject(edgeRoute(from, to));
    const verticals = verticalXs(smoothPath(from, to, route)).filter(x => x > from.x + 200);
    expect(verticals).toHaveLength(1);
    return verticals[0];
  });
  const right = boxes[0].x + 200;
  expect(new Set(xs).size).toBe(6);
  expect(xs.every(x => x > right && x < right + 120)).toBe(true);
  [61, 74, 87, 24 + 20 / 3, 24 + 40 / 3, 20].forEach((offset, index) =>
    expect(xs[index]).toBeCloseTo(right + offset));
  expect(routes.map(route => route.crowded)).toEqual([true, true, true, false, false, false]);
  expect({ edges: mixedGap.edges, boxes }).toEqual(before);
  expect(routeEdges(mixedGap.edges, boxes)).toEqual(routes);
});

it('keeps twenty vertical segments distinct even when their gap is crowded', () => {
  const input = flow([
    ...Array.from({ length: 12 }, (_, index) => node(`front${index}`, 'front', 12 - index)),
    ...Array.from({ length: 12 }, (_, index) => node(`request${index}`, 'request', 0)),
  ], edges([
    ...Array.from({ length: 11 }, (_, index) => [`front${index}`, `request${index + 1}`]),
    ...Array.from({ length: 9 }, (_, index) => ['front0', `front${index + 2}`]),
  ]));
  const { boxes } = layoutFlow(input);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const xs = routeEdges(input.edges, boxes).flatMap((route, index) =>
    verticalXs(smoothPath(byId.get(input.edges[index].from)!, byId.get(input.edges[index].to)!, route)));
  expect(xs).toHaveLength(20);
  expect(new Set(xs).size).toBe(20);
  expect(xs.slice(0, 11).every(x => x > 260 + 48 && x < 260 + 100)).toBe(true);
  expect(xs.slice(11).every(x => x > 260 + 24 && x < 260 + 44)).toBe(true);
});

it('keeps the entire self-call path below the box immediately above it', () => {
  const { boxes } = layoutFlow(flow([node('upper', 'front', 2), node('lower', 'front', 1)]));
  const [route] = routeEdges([{ from: 'lower', to: 'lower' }], boxes);
  expect(route.pathOptions).toEqual({ offset: 20 });
  const coordinates = smoothPath(boxes[1], boxes[1], route).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const ys = coordinates.filter((_, index) => index % 2 === 1);
  // Every endpoint and quadratic control point is below the upper rectangle, so the curves are too.
  expect(Math.min(...ys)).toBe(boxes[1].y - 20);
  expect(Math.min(...ys)).toBeGreaterThan(boxes[0].y + 60);
});

it('marks only multiple cross-lane arrows in one gap as crowded and keeps a lone arrow at R + 60', () => {
  const { boxes } = layoutFlow(mixedGap);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  expect(routeEdges(mixedGap.edges.slice(0, 2), boxes).map(route => route.crowded)).toEqual([true, true]);
  const input = [mixedGap.edges[0], ...mixedGap.edges.slice(3)];
  const routes = routeEdges(input, boxes);
  expect(routes.every(route => !route.crowded)).toBe(true);
  expect(routes[0].pathOptions).toEqual({ offset: 20, stepPosition: 0.5 });
  expect(verticalXs(smoothPath(byId.get('front0')!, byId.get('request1')!, routes[0]))).toEqual([260 + 60]);
});

it('leaves straight and leftward connections unchanged and handles an empty flow', () => {
  const input = flow([node('first', 'front', 2), node('second', 'front', 1), node('request', 'request', 0)],
    edges([['first', 'second'], ['first', 'request'], ['request', 'second']]));
  const { boxes } = layoutFlow(input);
  const routes = routeEdges(input.edges, boxes);
  expect(routes.map(route => route.type)).toEqual(['straight', 'straight', 'smoothstep']);
  for (const route of routes) {
    expect(route).not.toHaveProperty('pathOptions');
    expect(route.crowded).toBe(false);
  }
  expect(routeEdges([], [])).toEqual([]);
});

it.each([false, true])('routes a two-lane jump through the source gap with another cross-lane arrow=%s', crowded => {
  const input = flow([node('first', 'front', 2), node('second', 'front', 1), node('request', 'request', 0),
    node('handler', 'back', 0)], edges(crowded
    ? [['second', 'handler'], ['second', 'request']] : [['second', 'handler']]));
  const { boxes } = layoutFlow(input);
  const [route] = routeEdges(input.edges, boxes);
  const [x] = verticalXs(smoothPath(boxes[1], boxes[3], route));
  expect(x).toBeCloseTo(260 + (crowded ? 48 + 52 / 3 : 60));
  expect(route.pathOptions!.stepPosition).toBeGreaterThan(0);
  expect(route.pathOptions!.stepPosition).toBeLessThan(0.5);
  expect(route.crowded).toBe(crowded);
});

it('sorts each region by source row, target row, then original order without mixing gaps', () => {
  const input = flow([
    ...Array.from({ length: 4 }, (_, index) => node(`front${index}`, 'front', 4 - index)),
    ...Array.from({ length: 3 }, (_, index) => node(`request${index}`, 'request', 0)),
    node('handler', 'back', 0),
  ], edges([['front3', 'request0'], ['front0', 'request2'], ['front0', 'request1'], ['front0', 'request1'],
    ['front3', 'front1'], ['front0', 'front3'], ['front0', 'front2'], ['front0', 'front2'],
    ['request1', 'handler']]));
  const { boxes } = layoutFlow(input);
  const routes = routeEdges(input.edges, boxes);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const xs = routes.map((route, index) => verticalXs(smoothPath(
    byId.get(input.edges[index].from)!, byId.get(input.edges[index].to)!, route))[0]);
  [4, 3, 1, 2].forEach((order, index) => expect(xs[index]).toBeCloseTo(260 + 48 + 52 * order / 5));
  [4, 3, 1, 2].forEach((order, index) => expect(xs[index + 4]).toBeCloseTo(260 + 24 + 20 * order / 5));
  expect(xs[8]).toBe(580 + 60);
  expect(routes[8].crowded).toBe(false);
});
