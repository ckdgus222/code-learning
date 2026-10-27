import type { FeatureFlow, FlowNode, ProjectRoutes, ValueSite } from '../shared/contracts';
import type { FeatureGuide } from '../shared/ai';
import { codeNameOf, groupNameOf, methodNames, routeLabel, storyOf } from '../core/analysis/flow-story';
import type { FlowStart } from './feature-flow';
import { screenGroups } from './screen-groups';

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}…` : text;

export interface IndexFeature {
  routeIndex: number;
  name: string;
  basis: 'button' | 'screen-title' | 'address';
  source: string;
  screens: string[];
  start: FlowStart | null;
  linked: 'screen' | 'request-only' | 'none';
  inferred: boolean;
  reasons: string[];
  aiName: string | null;
  haystack: string;
}

export interface IndexGroup {
  key: string;
  title: { text: string; screen: string; relativePath: string; site: ValueSite } | null;
  features: IndexFeature[];
}

function buttonName(node: FlowNode | undefined): string | null {
  if (!node?.event || !node.control) return null;
  const { tag, texts, submits } = node.control;
  const words = tag === 'form' && node.event === 'onSubmit' ? submits
    : ['button', 'a', 'Link'].includes(tag) ? texts : [];
  if (!words?.length) return null;
  return `${words.map(text => `‘${text}’`).join(' 또는 ')} ${tag === 'a' || tag === 'Link' ? '링크' : '버튼'}`;
}

export function featureIndex(routes: ProjectRoutes, flows: FeatureFlow[], pathOf: (fileId: string) => string,
  guide?: FeatureGuide): IndexGroup[] {
  const grouped = screenGroups(routes, flows, guide);
  const groups = new Map<string, IndexGroup>();
  const seen = new Set<number>();
  for (const flow of flows) {
    const { routeIndex } = flow;
    if (seen.has(routeIndex)) continue;
    seen.add(routeIndex);
    const route = routes.routes[routeIndex];
    const parts = route.path?.split('/').filter(Boolean) ?? [];
    const key = route.framework === 'nest' ? groupNameOf(route, pathOf(route.handler.fileId))
      : parts[0] === 'api' ? parts[1] ?? 'api' : parts[0] ?? '주소 모름';
    let group = groups.get(key);
    if (!group) {
      const screen = flows.flatMap(flow => flow.nodes).find(node => node.side === 'front' && node.screen === `/${key}`);
      group = { key, title: screen?.screenTitle ? { ...screen.screenTitle, text: clip(screen.screenTitle.text, 40), screen: screen.screen!,
        relativePath: pathOf(screen.screenTitle.site.fileId) } : null, features: [] };
      groups.set(key, group);
    }
    const rows = grouped.screens.flatMap(group => group.rows.filter(row => row.routeIndex === routeIndex)
      .map(row => ({ ...row, screen: group.screen, first: storyOf(flow, row.through)[0] })));
    // User decision: a view is named by its screen title first, an action by its button text first,
    // so actions on one screen do not all share the screen's name.
    const title = rows[0]?.first?.nodes[0]?.screenTitle;
    const titledRow = title && rows.every(row => row.first?.nodes[0]?.screenTitle?.text === title.text) ? rows[0] : undefined;
    const buttonRow = rows.find(row => buttonName(row.first?.representative));
    const titled = route.method !== 'GET' && buttonRow ? undefined : titledRow;
    const button = titled ? undefined : buttonRow;
    const chosen = titled ?? button ?? rows[0];
    const requestOnly = grouped.noScreen.find(row => row.routeIndex === routeIndex);
    const fallback = !chosen && requestOnly ? storyOf(flow) : [];
    const first = chosen?.first ?? fallback[0];
    const story = fallback.filter(step => step.storyId === first?.storyId);
    const screenTitle = titled?.first.nodes[0].screenTitle;
    const controlName = !titled && (button || !chosen) ? buttonName(first?.representative) : null;
    const basis: IndexFeature['basis'] = screenTitle ? 'screen-title' : controlName ? 'button' : 'address';
    const name = screenTitle ? `‘${clip(screenTitle.text, 40)}’ 화면 · ${methodNames[route.method]}`
      : controlName ? `${controlName} · ${methodNames[route.method]}` : codeNameOf(route);
    const source = screenTitle ? `화면 ${chosen!.screen} · ${pathOf(screenTitle.site.fileId)} ${screenTitle.site.startLine}행`
      : controlName ? `${chosen ? `화면 ${chosen.screen} · ` : ''}${first!.representative.relativePath} ${first!.representative.name}`
      : `처리 함수 ${pathOf(route.handler.fileId)} ${route.handler.name}`;
    const screens = rows.map(row => row.screen);
    const aiName = chosen?.aiName ?? requestOnly?.aiName ?? grouped.unlinked.find(row => row.routeIndex === routeIndex)?.aiName ?? null;
    group.features.push({ routeIndex, name, basis, source, screens,
      start: chosen ? { through: chosen.through, storyId: chosen.storyId }
        : first ? { through: null, storyId: first.storyId } : null,
      linked: chosen ? 'screen' : requestOnly ? 'request-only' : 'none',
      inferred: chosen?.inferred ?? story.some(step => step.inferred),
      reasons: chosen?.reasons ?? [...new Set(story.flatMap(step => step.reasons))], aiName,
      haystack: `${name} ${routeLabel(route)} ${route.handler.name} ${screens.join(' ')} ${aiName ?? ''} ${key} ${group.title?.text ?? ''}`.toLowerCase(),
    });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(group => ({ ...group, features: group.features.sort((a, b) => a.routeIndex - b.routeIndex) }));
}
