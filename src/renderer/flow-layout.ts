import type { FeatureFlow, FlowNode } from '../shared/contracts';

// A flow can run ten steps long; in one row the fitted view shrank every box past reading. Steps wrap like
// lines of text instead: four per band, the next band starting again on the left.
const STEPS_PER_BAND = 4;
// The shared `.map-box` is 200px wide (styles.css); the rest is the gap an arrow and its line label need.
const STEP_WIDTH = 260;
const ROW_HEIGHT = 110;
const BAND_GAP = 70;

export type FlowBox = { node: FlowNode; step: number; x: number; y: number };

// Screen side first: far frontend callers, the request, then deeper backend calls.
const rank = (node: FlowNode) => node.side === 'front' ? -1 - node.depth : node.side === 'request' ? 0 : 1 + node.depth;

/**
 * `step` is the reading order (screen side first). Depth is already the longest distance from a request,
 * so cycles need no other traversal here.
 */
export function layoutFlow(flow: FeatureFlow): FlowBox[] {
  const byRank = new Map<number, FlowNode[]>();
  for (const node of flow.nodes) byRank.set(rank(node), [...byRank.get(rank(node)) ?? [], node]);
  const columns = [...byRank].sort(([a], [b]) => a - b).map(([, nodes]) => nodes);
  const boxes: FlowBox[] = [];
  let top = 0;
  for (let first = 0; first < columns.length; first += STEPS_PER_BAND) {
    const band = columns.slice(first, first + STEPS_PER_BAND);
    band.forEach((nodes, offset) => nodes.forEach((node, row) =>
      boxes.push({ node, step: first + offset, x: offset * STEP_WIDTH, y: top + row * ROW_HEIGHT })));
    top += Math.max(...band.map(nodes => nodes.length)) * ROW_HEIGHT + BAND_GAP;
  }
  return boxes;
}
