import { expect, it } from 'vitest';
import type { FeatureFlow, FlowNode } from '../src/shared/contracts';
import { getSmoothStepPath, Position } from '@xyflow/react';
import { edgeRoute, flowNodeKind, LANE_NOTES, layoutFlow, routeEdges, type EdgeRouteInfo, type FlowBox } from '../src/renderer/flow-layout';
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
    ['far', 70, 104, 0], ['near', 70, 254, 1], ['request', 510, 104, 0],
    ['handler', 950, 104, 0], ['service', 950, 254, 1],
  ]);
  expect(lanes).toEqual([
    { side: 'front', title: '화면 쪽', x: 0, width: 440, height: 424, empty: false },
    { side: 'request', title: '요청', x: 440, width: 440, height: 424, empty: false },
    { side: 'back', title: '서버 쪽', x: 880, width: 440, height: 424, empty: false },
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
  expect(empty.lanes.every(lane => lane.empty && lane.height === 274)).toBe(true);
  const back = layoutFlow(flow([node('handler', 'back', 0), node('service', 'back', 1)]));
  expect(back.boxes.map(({ node, x, y }) => [node.id, x, y])).toEqual([['handler', 950, 104], ['service', 950, 254]]);
  expect(back.lanes.map(lane => lane.empty)).toEqual([true, true, false]);
  expect(back.lanes.map(lane => lane.height)).toEqual([424, 424, 424]);
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
  const [path] = getSmoothStepPath({ sourceX: from.x + 300, sourceY: from.y + 30, sourcePosition: Position.Right,
    targetX: to.x + (route.targetHandle === 'in-top' ? 150 : 300),
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
  expect([boxes[0], boxes[8], boxes[9]].map(box => box.y)).toEqual([104, 104, 104]);
  expect(lanes.map(lane => lane.height)).toEqual([1324, 1324, 1324]);
  expect(edgeRoute(boxes[7], boxes[8])).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left', type: 'smoothstep' });
  expect(edgeRoute(boxes[8], boxes[9])).toEqual({ sourceHandle: 'out-right', targetHandle: 'in-left', type: 'straight' });
  const from = boxes[7];
  const to = boxes[8];
  const [path] = getSmoothStepPath({ sourceX: from.x + 300, sourceY: from.y + 24, sourcePosition: Position.Right,
    targetX: to.x, targetY: to.y + 24, targetPosition: Position.Left });
  expect(path.match(/[A-Za-z]/g)!.every(command => ['M', 'L', 'Q'].includes(command))).toBe(true);
  const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)];
  expect(commands.length).toBeGreaterThan(2);
  let previous = [from.x + 300, from.y + 24];
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
  const [path] = getSmoothStepPath({ sourceX: from.x + 300, sourceY: from.y + 24, sourcePosition: Position.Right,
    targetX: to.x, targetY: to.y + 24, targetPosition: Position.Left });
  expect(path.match(/[A-Za-z]/g)!.every(command => ['M', 'L', 'Q'].includes(command))).toBe(true);
  const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)];
  expect(commands.length).toBeGreaterThan(2);
  let previous = [from.x + 300, from.y + 24];
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
  expect(lanes.every(lane => lane.height === 724)).toBe(true);
  expect(edgeRoute(boxes[4], boxes[5])).toEqual({ sourceHandle: 'out-bottom', targetHandle: 'in-top', type: 'straight' });
});

function smoothPath(from: FlowBox, to: FlowBox, route: EdgeRouteInfo): string {
  return getSmoothStepPath({ sourceX: from.x + 300, sourceY: from.y + SIDE_HANDLE_TOP, sourcePosition: Position.Right,
    targetX: to.x + (route.targetHandle === 'in-top' ? 150 : route.targetHandle === 'in-right' ? 300 : 0),
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
    const verticals = verticalXs(smoothPath(from, to, route)).filter(x => x > from.x + 300);
    expect(verticals).toHaveLength(1);
    return verticals[0];
  });
  const right = boxes[0].x + 300;
  expect(new Set(xs).size).toBe(6);
  expect(xs.every(x => x > right && x < right + 140)).toBe(true);
  [66, 84, 102, 24 + 20 / 3, 24 + 40 / 3, 10].forEach((offset, index) =>
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
  expect(xs.slice(0, 11).every(x => x > 370 + 48 && x < 370 + 120)).toBe(true);
  expect(xs.slice(11).every(x => x > 370 + 24 && x < 370 + 44)).toBe(true);
});

it('keeps the entire self-call path below the box immediately above it', () => {
  const { boxes } = layoutFlow(flow([node('upper', 'front', 2), node('lower', 'front', 1)]));
  const [route] = routeEdges([{ from: 'lower', to: 'lower' }], boxes);
  expect(route.pathOptions).toEqual({ offset: 10 });
  const coordinates = smoothPath(boxes[1], boxes[1], route).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const ys = coordinates.filter((_, index) => index % 2 === 1);
  // Every endpoint and quadratic control point is below the upper rectangle, so the curves are too.
  expect(Math.min(...ys)).toBe(boxes[1].y - 10);
  expect(Math.min(...ys)).toBeGreaterThan(boxes[0].y + 130);
});

it('marks only multiple cross-lane arrows in one gap as crowded and keeps a lone arrow at R + 70', () => {
  const { boxes } = layoutFlow(mixedGap);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  expect(routeEdges(mixedGap.edges.slice(0, 2), boxes).map(route => route.crowded)).toEqual([true, true]);
  const input = [mixedGap.edges[0], ...mixedGap.edges.slice(3)];
  const routes = routeEdges(input, boxes);
  expect(routes.every(route => !route.crowded)).toBe(true);
  expect(routes[0].pathOptions).toEqual({ offset: 10, stepPosition: 0.5 });
  expect(verticalXs(smoothPath(byId.get('front0')!, byId.get('request1')!, routes[0]))).toEqual([370 + 70]);
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
  expect(x).toBeCloseTo(370 + (crowded ? 48 + 72 / 3 : 70));
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
  [4, 3, 1, 2].forEach((order, index) => expect(xs[index]).toBeCloseTo(370 + 48 + 72 * order / 5));
  [4, 3, 1, 2].forEach((order, index) => expect(xs[index + 4]).toBeCloseTo(370 + 24 + 20 * order / 5));
  expect(xs[8]).toBe(810 + 70);
  expect(routes[8].crowded).toBe(false);
});

it('describes the three lanes with the approved notes', () => {
  expect(LANE_NOTES).toEqual({ front: '사람이 보고 누르는 곳', request: '화면이 서버로 보내는 부탁', back: '부탁을 받아 일을 하는 곳' });
});

it.each([
  ['front', 0, '/dogs', 'onClick', '화면', 'document'],
  ['front', 0, null, 'onClick', '화면 이벤트 처리', 'document'],
  ['front', 0, null, null, '화면 쪽 함수', 'document'],
  ['request', 0, null, null, '요청', 'code'],
  ['back', 0, null, null, '서버 받는 곳', 'gear'],
  ['back', 1, null, null, '서버 처리', 'box'],
] as const)('classifies %s depth %s screen %s event %s from node data', (side, depth, screen, event, label, icon) => {
  expect(flowNodeKind({ ...node('n', side, depth), screen, event })).toEqual({ label, icon });
});

it.each(['front', 'back'] as const)('keeps self-calls and skipped-row detours clear of 300×130 tagged boxes in the %s lane', side => {
  const input = flow(Array.from({ length: 4 }, (_, index) => ({ ...node(`n${index}`, side, side === 'front' ? 4 - index : index),
    screen: '/dogs', event: 'onClick' })), edges([
    ['n0', 'n0'], ['n1', 'n1'], ['n2', 'n2'], ['n3', 'n3'],
    ['n0', 'n2'], ['n0', 'n3'], ['n3', 'n0'], ['n3', 'n1'],
  ]));
  const { boxes } = layoutFlow(input);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  routeEdges(input.edges, boxes).forEach((route, index) => {
    const edge = input.edges[index];
    const path = smoothPath(byId.get(edge.from)!, byId.get(edge.to)!, route);
    const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)];
    let previous: number[] = [];
    commands.forEach(([, command, coordinates], segment) => {
      const values = coordinates.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      if (command === 'M') { previous = values; return; }
      // A quadratic curve stays inside the bounds of its endpoints and control point.
      const points = [...previous, ...values];
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
      for (const box of boxes) {
        // Only the departure and final arrival may touch their own handles.
        if (segment === 1 && box.node.id === edge.from) continue;
        if (segment === commands.length - 1 && box.node.id === edge.to) continue;
        const overlaps = Math.max(...xs) >= box.x && Math.min(...xs) <= box.x + 300
          && Math.max(...ys) >= box.y && Math.min(...ys) <= box.y + 130;
        expect(overlaps, `${edge.from} → ${edge.to}, segment ${segment}, box ${box.node.id}: ${path}`).toBe(false);
      }
      previous = values.slice(-2);
    });
  });
});
