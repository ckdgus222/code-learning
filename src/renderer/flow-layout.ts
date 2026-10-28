import type { FeatureFlow, FlowNode } from '../shared/contracts';

const LANE_WIDTH = 320;
const LANE_HEADER = 70;
const ROW_HEIGHT = 110;
const BOX_WIDTH = 200;
// The shared `.map-box` is 200px wide (styles.css); centring it leaves room on both sides for arrows that skip rows.
const BOX_LEFT = (LANE_WIDTH - BOX_WIDTH) / 2;
// The 120px gap right of a lane is shared by vertical lines: self calls keep 20px (a larger offset also climbs into the
// box above), arrows looping outside the lane take 24–44px and arrows to a lane on the right 48–100px, so none meet.
const ROUTE_OFFSET = 20;
const OUTSIDE_GAP_START = 24;
const OUTSIDE_GAP_END = 44;
const BETWEEN_GAP_START = 48;
const BETWEEN_GAP_END = 100;
const SINGLE_BETWEEN_OFFSET = 60;
export const LANE_TITLES: Record<FlowNode['side'], string> = { front: '화면 쪽', request: '요청', back: '서버 쪽' };

export type FlowBox = { node: FlowNode; step: number; row: number; x: number; y: number };
export type FlowLane = { side: FlowNode['side']; title: string; x: number; width: number; height: number; empty: boolean };
export type EdgeRouteInfo = { sourceHandle: string; targetHandle: string; type?: string;
  pathOptions?: { offset: number; stepPosition?: number }; crowded: boolean };

// Screen side first: far frontend callers, the request, then deeper backend calls.
const rank = (node: FlowNode) => node.side === 'front' ? -1 - node.depth : node.side === 'request' ? 0 : 1 + node.depth;

/** `step` retains the depth-based reading order, while `row` is the position within a lane. */
export function layoutFlow(flow: FeatureFlow): { boxes: FlowBox[]; lanes: FlowLane[] } {
  const ordered = [...flow.nodes].sort((a, b) => rank(a) - rank(b));
  const ranks = [...new Set(ordered.map(rank))];
  const sides = ['front', 'request', 'back'] as const;
  const counts = sides.map(side => ordered.filter(node => node.side === side).length);
  const rows = { front: 0, request: 0, back: 0 };
  const boxes = ordered.map(node => {
    const row = rows[node.side]++;
    return { node, step: ranks.indexOf(rank(node)), row,
      x: sides.indexOf(node.side) * LANE_WIDTH + BOX_LEFT, y: LANE_HEADER + row * ROW_HEIGHT };
  });
  const height = LANE_HEADER + (Math.max(0, ...boxes.map(box => box.row)) + 1) * ROW_HEIGHT + 20;
  const lanes = sides.map((side, index) => ({
    side, title: LANE_TITLES[side], x: index * LANE_WIDTH, width: LANE_WIDTH, height, empty: counts[index] === 0,
  }));
  return { boxes, lanes };
}

export function edgeRoute(fromBox: FlowBox, toBox: FlowBox): { sourceHandle: string; targetHandle: string; type?: string } {
  if (fromBox.node.id === toBox.node.id) return { sourceHandle: 'out-right', targetHandle: 'in-top', type: 'smoothstep' };
  if (fromBox.node.side !== toBox.node.side) return {
    sourceHandle: 'out-right', targetHandle: 'in-left', type: fromBox.row === toBox.row ? 'straight' : 'smoothstep',
  };
  if (toBox.row === fromBox.row + 1) return { sourceHandle: 'out-bottom', targetHandle: 'in-top', type: 'straight' };
  return { sourceHandle: 'out-right', targetHandle: 'in-right', type: 'smoothstep' };
}

export function routeEdges(edges: { from: string; to: string }[], boxes: FlowBox[]): EdgeRouteInfo[] {
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const groups = new Map<string, { from: FlowBox; to: FlowBox; index: number; route: EdgeRouteInfo }[]>();
  const routes = edges.map((edge, index): EdgeRouteInfo => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const route: EdgeRouteInfo = { ...edgeRoute(from, to), crowded: false };
    if (edge.from === edge.to) return { ...route, pathOptions: { offset: ROUTE_OFFSET } };
    if (route.type !== 'smoothstep') return route;
    if (route.targetHandle !== 'in-right' && to.x <= from.x) return route;

    const key = `${from.x}:${route.targetHandle}`;
    const group = groups.get(key) ?? [];
    group.push({ from, to, index, route });
    groups.set(key, group);
    return route;
  });

  for (const group of groups.values()) {
    group.sort((a, b) => a.from.row - b.from.row || a.to.row - b.to.row || a.index - b.index);
    const outside = group[0].route.targetHandle === 'in-right';
    const start = outside ? OUTSIDE_GAP_START : BETWEEN_GAP_START;
    const end = outside ? OUTSIDE_GAP_END : BETWEEN_GAP_END;
    group.forEach(({ from, to, route }, index) => {
      const fraction = (index + 1) / (group.length + 1);
      const right = from.x + BOX_WIDTH;
      const offset = !outside && group.length === 1 ? SINGLE_BETWEEN_OFFSET : start + (end - start) * fraction;
      route.pathOptions = outside ? { offset } : { offset: ROUTE_OFFSET,
        stepPosition: (offset - ROUTE_OFFSET) / ((to.x - ROUTE_OFFSET) - (right + ROUTE_OFFSET)) };
      route.crowded = !outside && group.length >= 2;
    });
  }
  return routes;
}
