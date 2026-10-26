import type { FeatureFlow, ProjectRoutes } from '../shared/contracts';
import type { FeatureGuide } from '../shared/ai';
import { routeLabel, storyOf } from '../core/analysis/flow-story';

export interface RouteRow {
  routeIndex: number; aiName: string | null; haystack: string;
}
export interface ScreenRow extends RouteRow {
  through: string; storyId: string; title: string; text: string;
  inferred: boolean; reasons: string[]; elsewhere: boolean;
}
export interface ScreenGroups {
  screens: { screen: string; rows: ScreenRow[] }[];
  noScreen: RouteRow[];
  unlinked: RouteRow[];
}

export interface FileUse {
  routeIndex: number; screen: string | null; through: string | null; storyId: string;
  step: number; label: string; nodeId: string; other: boolean; inferred: boolean; reasons: string[];
}

export function fileUses(fileId: string, fileHash: string, routes: ProjectRoutes, flows: FeatureFlow[]):
  { uses: FileUse[]; changed: boolean } {
  const uses: FileUse[] = [];
  const seen = new Set<string>();
  const changed = flows.some(flow => flow.nodes.some(node => node.fileId === fileId && node.fileHash !== fileHash));
  for (const flow of flows) {
    if (!routes.routes[flow.routeIndex]) continue;
    const screens = flow.nodes.filter(node => node.side === 'front' && node.screen !== null)
      .map(node => ({ screen: node.screen, through: node.id, steps: storyOf(flow, node.id) }))
      .filter(story => story.steps.length > 0);
    const stories = screens.length ? screens : [{ screen: null, through: null, steps: storyOf(flow) }];
    const paths = stories.flatMap(story => [...new Set(story.steps.map(step => step.storyId))]
      .map(storyId => ({ ...story, storyId, steps: story.steps.filter(step => step.storyId === storyId) })));
    for (const story of paths) {
      const step = story.steps.findIndex(item => [...item.nodes, ...item.others].some(node => node.fileId === fileId));
      if (step < 0) continue;
      const item = story.steps[step];
      const primary = item.nodes.find(node => node.fileId === fileId);
      const node = primary ?? item.others.find(node => node.fileId === fileId)!;
      if (node.fileHash !== fileHash) continue;
      const key = JSON.stringify([flow.routeIndex, story.screen, step]);
      if (seen.has(key)) continue;
      seen.add(key);
      uses.push({ routeIndex: flow.routeIndex, screen: story.screen, through: story.through, storyId: story.storyId,
        step, label: item.label, nodeId: node.id, other: !primary,
        inferred: story.steps.some(item => item.inferred), reasons: [...new Set(story.steps.flatMap(item => item.reasons))] });
    }
  }
  uses.sort((a, b) => a.routeIndex - b.routeIndex || (a.screen ?? '').localeCompare(b.screen ?? '') || a.step - b.step);
  return { uses, changed };
}

export function screenGroups(routes: ProjectRoutes, flows: FeatureFlow[], guide?: FeatureGuide): ScreenGroups {
  const screens = new Map<string, ScreenRow[]>();
  const noScreen: RouteRow[] = [];
  const unlinked: RouteRow[] = [];
  for (const flow of flows) {
    const routeIndex = flow.routeIndex;
    const route = routes.routes[routeIndex];
    const aiName = guide?.groups.flatMap(group => group.features).filter(feature => feature.routes.includes(routeIndex))
      .map(feature => feature.name).join(' · ') || null;
    const row: RouteRow = { routeIndex, aiName,
      haystack: `${routeLabel(route)} ${route.handler.name} ${aiName ?? ''}`.toLowerCase() };
    let hasScreen = false;
    for (const node of flow.nodes) {
      if (node.side !== 'front' || node.screen === null) continue;
      const rows = screens.get(node.screen) ?? [];
      if (rows.some(row => row.routeIndex === routeIndex)) { hasScreen = true; continue; }
      const steps = storyOf(flow, node.id);
      if (!steps.length) continue;
      hasScreen = true;
      const first = steps[0];
      const story = steps.filter(step => step.storyId === first.storyId);
      rows.push({ ...row, through: node.id, storyId: first.storyId, title: first.title, text: first.text,
        inferred: story.some(step => step.inferred), reasons: [...new Set(story.flatMap(step => step.reasons))], elsewhere: false,
        haystack: `${node.screen.toLowerCase()} ${row.haystack}` });
      screens.set(node.screen, rows);
    }
    if (hasScreen) continue;
    if (flow.nodes.some(node => node.side === 'front' || node.side === 'request')) noScreen.push(row);
    else unlinked.push(row);
  }
  const counts = new Map<number, number>();
  for (const rows of screens.values()) for (const row of rows) counts.set(row.routeIndex, (counts.get(row.routeIndex) ?? 0) + 1);
  for (const rows of screens.values()) for (const row of rows) row.elsewhere = counts.get(row.routeIndex)! > 1;
  return { screens: [...screens].sort(([a], [b]) => a.localeCompare(b)).map(([screen, rows]) => ({ screen, rows })), noScreen, unlinked };
}
