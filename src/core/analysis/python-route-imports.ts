import type { ProjectFile, Route } from '../../shared/contracts';
import { pythonCallResolver } from './python-call-imports';
import type { PythonFileFacts } from './python-names';
import { importedPythonRoutes, type PythonRouteImportFacts } from './python-routes';
import { lacksRouteEvidence } from './routes';

/** Resolve only after every readable file has contributed its import and mutation facts. */
export function importedAppRoutes(files: ProjectFile[], parsed: ReadonlyMap<string, PythonFileFacts>,
  sources: ReadonlyMap<string, PythonRouteImportFacts>, complete: boolean, maxRoutes: number, stop: () => void) {
  const resolver = pythonCallResolver(files, parsed, stop);
  const ownerNames = new Map<string, Set<string>>();
  const decorators = new Map<string, Set<number>>();
  const prepared: { fileId: string; originId: string; routes: Route[] }[] = [];
  const origins = new Map([...sources].map(([fileId, source]) => [fileId, new Map(source.owners.map(owner => [owner.name, owner]))]));
  let skipped = 0, cut = false;
  for (const [fileId, source] of sources) {
    stop();
    const facts = parsed.get(fileId);
    if (facts) ownerNames.set(facts.file.relativePath, new Set(source.owners.map(owner => owner.name)));
    if (!facts || !complete) { skipped += source.drafts.length; continue; }
    if (!source.drafts.length) continue;
    const calls = new Map((facts.routeCalls ?? []).filter(call => call.scope === facts.program && call.node.parent?.type === 'decorator'
      && call.node.parent.parent?.parent?.type === 'module').map(call => [call.node.startIndex, call]));
    const allowed = new Set<number>();
    for (const draft of source.drafts) {
      stop();
      const call = calls.get(draft.callStartUtf16);
      const origin = call && resolver.resolveRouteObject(facts, call, draft.receiverNames);
      const owner = origin && origins.get(origin.facts.file.id)?.get(origin.name);
      if (!origin || !owner?.safe || owner.bindingStartUtf16 !== origin.bindingStartUtf16
        || draft.handler.fileHash !== facts.hash || parsed.get(origin.facts.file.id)?.hash !== origin.facts.hash) {
        skipped++; continue;
      }
      const found = importedPythonRoutes(owner, draft, call!.node, maxRoutes + 1);
      // An unrepresented registration may compete with routes in its source module. Only fully read,
      // supported direct app decorators are exempt from the project-wide route mutation scan.
      if (!found.length || found.some(route => route.path === null || route.unmatched || lacksRouteEvidence(route))) { skipped++; continue; }
      allowed.add(draft.callStartUtf16);
      prepared.push({ fileId, originId: origin.facts.file.id, routes: found });
    }
    decorators.set(fileId, allowed);
  }
  resolver.scanRouteEffects(ownerNames, decorators);
  const blocked = new Set<string>();
  for (const facts of parsed.values()) {
    stop();
    if (!resolver.routeModuleSafe(facts.file.relativePath)) blocked.add(facts.file.id);
  }
  const routes: Route[] = [];
  for (const candidate of prepared) {
    stop();
    if (blocked.has(candidate.fileId) || blocked.has(candidate.originId)) { skipped++; continue; }
    const room = maxRoutes - routes.length;
    cut ||= candidate.routes.length > room;
    routes.push(...candidate.routes.slice(0, room));
    if (cut) break;
  }
  return { routes, blocked, skipped, cut };
}
