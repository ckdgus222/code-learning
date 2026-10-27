import type { FeatureFlow, FlowNode } from '../shared/contracts';

const LANE_WIDTH = 320;
const LANE_HEADER = 70;
const ROW_HEIGHT = 110;
// The shared `.map-box` is 200px wide (styles.css); centring it leaves room on both sides for arrows that skip rows.
const BOX_LEFT = (LANE_WIDTH - 200) / 2;
export const LANE_TITLES: Record<FlowNode['side'], string> = { front: '화면 쪽', request: '요청', back: '서버 쪽' };

export type FlowBox = { node: FlowNode; step: number; row: number; x: number; y: number };
export type FlowLane = { side: FlowNode['side']; title: string; x: number; width: number; height: number; empty: boolean };

// Screen side first: far frontend callers, the request, then deeper backend calls.
const rank = (node: FlowNode) => node.side === 'front' ? -1 - node.depth : node.side === 'request' ? 0 : 1 + node.depth;

/** `step` retains the depth-based reading order, while `row` is the position within a lane. */
export function layoutFlow(flow: FeatureFlow): { boxes: FlowBox[]; lanes: FlowLane[] } {
  const ordered = [...flow.nodes].sort((a, b) => rank(a) - rank(b));
  const ranks = [...new Set(ordered.map(rank))];
  const sides = ['front', 'request', 'back'] as const;
  const counts = sides.map(side => ordered.filter(node => node.side === side).length);
  const height = LANE_HEADER + Math.max(1, ...counts) * ROW_HEIGHT + 20;
  const lanes = sides.map((side, index) => ({
    side, title: LANE_TITLES[side], x: index * LANE_WIDTH, width: LANE_WIDTH, height, empty: counts[index] === 0,
  }));
  const rows = { front: 0, request: 0, back: 0 };
  const boxes = ordered.map(node => {
    const row = rows[node.side]++;
    return { node, step: ranks.indexOf(rank(node)), row,
      x: sides.indexOf(node.side) * LANE_WIDTH + BOX_LEFT, y: LANE_HEADER + row * ROW_HEIGHT };
  });
  return { boxes, lanes };
}

export function edgeRoute(fromBox: FlowBox, toBox: FlowBox): { sourceHandle: string; targetHandle: string; type?: string } {
  if (fromBox.node.id === toBox.node.id) return { sourceHandle: 'out-right', targetHandle: 'in-top', type: 'smoothstep' };
  if (fromBox.node.side !== toBox.node.side) return { sourceHandle: 'out-right', targetHandle: 'in-left' };
  if (toBox.row === fromBox.row + 1) return { sourceHandle: 'out-bottom', targetHandle: 'in-top', type: 'straight' };
  return { sourceHandle: 'out-right', targetHandle: 'in-right', type: 'smoothstep' };
}
