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
