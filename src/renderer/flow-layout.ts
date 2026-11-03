import type { FeatureFlow, FlowNode } from '../shared/contracts';

const LANE_WIDTH = 440;
const LANE_HEADER = 104;
const ROW_HEIGHT = 150;
const BOX_WIDTH = 300;
// Feature boxes are 300px wide (styles.css); centring leaves room on both sides for arrows that skip rows.
const BOX_LEFT = (LANE_WIDTH - BOX_WIDTH) / 2;
// The 140px gap between boxes is shared by vertical lines: self calls keep 10px (half the 20px row gap),
// arrows looping outside the lane take 24–44px and arrows to a lane on the right 48–120px, so none meet.
const ROUTE_OFFSET = 10;
const OUTSIDE_GAP_START = 24;
const OUTSIDE_GAP_END = 44;
const BETWEEN_GAP_START = 48;
const BETWEEN_GAP_END = 120;
const SINGLE_BETWEEN_OFFSET = 70;
export const LANE_TITLES: Record<FlowNode['side'], string> = { front: '화면 쪽', request: '요청', back: '서버 쪽' };
export const LANE_NOTES: Record<FlowNode['side'], string> = {
  front: '사람이 보고 누르는 곳', request: '화면이 서버로 보내는 부탁', back: '부탁을 받아 일을 하는 곳',
};

export function flowNodeKind(node: FlowNode): { label: string; icon: 'document' | 'code' | 'gear' | 'box' } {
  if (node.side === 'request') return { label: '요청', icon: 'code' };
  if (node.side === 'back') return { label: node.depth === 0 ? '서버 받는 곳' : '서버 처리', icon: node.depth === 0 ? 'gear' : 'box' };
  if (node.screen !== null) return { label: '화면', icon: 'document' };
  if (node.event !== null) return { label: '화면 이벤트 처리', icon: 'document' };
  return { label: '화면 쪽 함수', icon: 'document' };
}

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
