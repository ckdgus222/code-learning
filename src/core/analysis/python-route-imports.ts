import type { ProjectFile, Route } from '../../shared/contracts';
import { pythonCallResolver } from './python-call-imports';
import { resolvePythonName, type PythonFileFacts } from './python-names';
import { importedPythonTemplates, importedPythonRegistration, importedRegisteredRoute, pythonRegistrationChild, pythonBlueprintRegistrationName,
  type PythonImportedTemplate, type PythonRouteImportFacts, type PythonRouteImportRoom, type PythonRouteOwnerOrigin,
  type PythonRouterRegistration } from './python-routes';
import { pythonAttributeNames } from './python-values';
import { lacksRouteEvidence, ROUTE_LIMITS } from './routes';

/** Resolve only after every readable file has contributed its import and mutation facts. */
export function importedAppRoutes(files: ProjectFile[], parsed: ReadonlyMap<string, PythonFileFacts>,
  sources: ReadonlyMap<string, PythonRouteImportFacts>, complete: boolean, maxRoutes: number, stop: () => void,
  room?: PythonRouteImportRoom, existing: readonly Route[] = []) {
  const resolver = pythonCallResolver(files, parsed, stop);
  const ownerNames = new Map<string, Set<string>>();
  const decorators = new Map<string, Set<number>>();
  const registrationReads = new Map<string, Set<number>>();
  type Template = { fileId: string; originId: string; template: PythonImportedTemplate };
  type Registration = { fileId: string; originId: string; at: number; parent: PythonRouteOwnerOrigin;
    child: PythonRouteOwnerOrigin; registration: PythonRouterRegistration };
  const prepared: Template[] = [], registrations: Registration[] = [];
  const templates = new Map<PythonRouteOwnerOrigin, Template[]>();
  const latestSetup = new Map<PythonRouteOwnerOrigin, Map<string, number>>();
  const origins = new Map([...sources].map(([fileId, source]) => [fileId, new Map(source.owners.map(owner => [owner.name, owner]))]));
  const unsafeParents = new Set<PythonRouteOwnerOrigin>();
  const flaskNames = new Map<PythonRouteOwnerOrigin, Map<string, number>>();
  let skipped = 0, cut = false, remaining = room?.work ?? ROUTE_LIMITS.work;
  const spend = (cost: number) => {
    stop();
    if (cost > remaining) { cut = true; if (room) room.cut = true; return false; }
    remaining -= cost;
    if (room) room.work = remaining;
    return true;
  };
  for (const [fileId, source] of sources) {
    stop();
    const facts = parsed.get(fileId);
    if (facts) ownerNames.set(facts.file.relativePath, new Set(source.owners.map(owner => owner.name)));
    for (const owner of source.owners) {
      templates.set(owner, owner.templates.map(template => ({ fileId, originId: fileId, template })));
      let end = -1;
      for (const template of owner.templates) end = Math.max(end, template.base.handler.endUtf16);
      latestSetup.set(owner, new Map([[fileId, end]]));
    }
  }
  for (const [fileId, source] of sources) {
    stop();
    const facts = parsed.get(fileId);
    if (!facts || !complete) { skipped += source.drafts.length; continue; }
    const calls = facts.routeCalls ?? [];
    const decoratorsByStart = new Map(calls.filter(call => call.scope === facts.program && call.node.parent?.type === 'decorator'
      && call.node.parent.parent?.parent?.type === 'module').map(call => [call.node.startIndex, call]));
    const allowed = new Set<number>();
    for (const draft of source.drafts) {
      const call = decoratorsByStart.get(draft.callStartUtf16);
      if (!call || !spend(100 + call.node.endIndex - call.node.startIndex)) { skipped++; continue; }
      const origin = resolver.resolveRouteObject(facts, call, draft.receiverNames, true);
      const owner = origin && origins.get(origin.facts.file.id)?.get(origin.name);
      if (!origin || !owner?.safe || owner.bindingStartUtf16 !== origin.bindingStartUtf16
        || draft.handler.fileHash !== facts.hash || parsed.get(origin.facts.file.id)?.hash !== origin.facts.hash) {
        skipped++; continue;
      }
      const found = importedPythonTemplates(owner, draft, call.node, maxRoutes + 1);
      // Only represented direct decorators may bypass mutation detection. Recheck source and caller
      // after every ordinary escape and route-specific effect has been collected.
      if (!found.length || found.some(({ base }) => base.path === null || base.unmatched || lacksRouteEvidence(base))) { skipped++; continue; }
      allowed.add(draft.callStartUtf16);
      for (const template of found) {
        const candidate = { fileId, originId: origin.facts.file.id, template };
        prepared.push(candidate); templates.get(owner)!.push(candidate);
        const ends = latestSetup.get(owner)!;
        ends.set(fileId, Math.max(ends.get(fileId) ?? -1, template.base.handler.endUtf16));
      }
    }
    decorators.set(fileId, allowed);
    for (const call of calls) {
      stop();
      const names = pythonAttributeNames(call.node.childForFieldName('function'));
      if (names?.length !== 2 || !['include_router', 'register_blueprint'].includes(names[1])) continue;
      if (!spend(100 + call.node.endIndex - call.node.startIndex)) continue;
      const parent = origins.get(fileId)?.get(names[0]);
      if (!parent?.safe || parent.app.router) continue;
      const flask = names[1] === 'register_blueprint';
      const found = resolvePythonName(facts, call, names[0]);
      if (found.kind === 'unknown' || found.binding.kind !== 'variable' || found.binding.node.startIndex !== parent.bindingStartUtf16
        || parent.app.framework !== (flask ? 'flask' : 'fastapi') || !facts.importsPlain || facts.unclear
        || call.scope !== facts.program || call.node.parent?.type !== 'expression_statement' || call.node.parent.parent?.type !== 'module') {
        unsafeParents.add(parent); continue;
      }
      const input = pythonRegistrationChild(call.node), childNames = pythonAttributeNames(input);
      const localChild = childNames?.length === 1 ? origins.get(fileId)?.get(childNames[0]) : undefined;
      const origin = childNames && resolver.resolveRouteObject(facts, call, childNames, true);
      const child = localChild ?? (origin && origins.get(origin.facts.file.id)?.get(origin.name));
      if (flask) {
        const name = child && pythonBlueprintRegistrationName(call.node, child);
        if (!name) unsafeParents.add(parent);
        else {
          const names = flaskNames.get(parent) ?? new Map<string, number>();
          names.set(name, (names.get(name) ?? 0) + 1); flaskNames.set(parent, names);
        }
      }
      if (localChild) continue;
      if (!origin || !child?.safe || child.app.framework !== parent.app.framework || child.bindingStartUtf16 !== origin.bindingStartUtf16) {
        unsafeParents.add(parent); continue;
      }
      const registration = importedPythonRegistration(child, call.node);
      if (!registration) { unsafeParents.add(parent); continue; }
      registrations.push({ fileId, originId: origin.facts.file.id, at: call.node.startIndex, parent, child, registration });
    }
  }
  const settled = registrations.filter(candidate => !unsafeParents.has(candidate.parent)
    && (candidate.registration.name === null || flaskNames.get(candidate.parent)?.get(candidate.registration.name) === 1));
  for (const candidate of settled) {
    const reads = registrationReads.get(candidate.fileId) ?? new Set<number>();
    reads.add(candidate.registration.input.id); registrationReads.set(candidate.fileId, reads);
  }
  resolver.scanRouteEffects(ownerNames, decorators, registrationReads);
  const blocked = new Set<string>();
  for (const facts of parsed.values()) {
    stop();
    if (!resolver.routeModuleSafe(facts.file.relativePath)) blocked.add(facts.file.id);
  }
  // A changed or escaped parent may pass its child to arbitrary code. Revoke its read exemption
  // through the whole registration graph, including modules affected by an initializer escape.
  const childrenByCaller = new Map<string, Set<string>>();
  for (const candidate of settled) {
    const children = childrenByCaller.get(candidate.fileId) ?? new Set<string>();
    children.add(candidate.originId); childrenByCaller.set(candidate.fileId, children);
  }
  const pending = [...blocked];
  const block = (fileId: string) => { if (!blocked.has(fileId)) { blocked.add(fileId); pending.push(fileId); } };
  let propagationCut = false;
  for (let index = 0; index < pending.length; index++) {
    const fileId = pending[index], name = parsed.get(fileId)?.file.relativePath;
    for (const child of childrenByCaller.get(fileId) ?? []) {
      if (!spend(1)) { propagationCut = true; break; }
      block(child);
    }
    if (name === '__init__.py' || name?.endsWith('/__init__.py')) {
      const prefix = name.slice(0, -'__init__.py'.length);
      for (const facts of parsed.values()) {
        if (!spend(1)) { propagationCut = true; break; }
        if (facts.file.relativePath.startsWith(prefix)) block(facts.file.id);
      }
    }
    if (propagationCut) break;
  }
  if (propagationCut) for (const fileId of parsed.keys()) blocked.add(fileId);
  const routes: Route[] = [];
  const key = (route: Route) => JSON.stringify([route.handler.fileId, route.handler.startUtf16, route.method, route.path]);
  const seen = new Set(existing.map(key));
  const append = (route: Route) => {
    const id = key(route);
    if (seen.has(id)) return;
    if (routes.length >= maxRoutes) { cut = true; return; }
    routes.push(route); seen.add(id);
  };
  for (const candidate of prepared) {
    stop();
    if (blocked.has(candidate.fileId) || blocked.has(candidate.originId)) { skipped++; continue; }
    append(candidate.template.base);
  }
  for (const candidate of settled) {
    stop();
    if (blocked.has(candidate.fileId) || blocked.has(candidate.originId)) { skipped++; continue; }
    const children = templates.get(candidate.child) ?? [];
    // Older FastAPI versions copy routes at registration. A later declaration in this very file
    // cannot justify composition; the original unknown-prefix candidates remain available.
    if ((latestSetup.get(candidate.child)?.get(candidate.fileId) ?? -1) >= candidate.at) {
      skipped++; continue;
    }
    for (const template of children) {
      if (!spend(100 + (template.template.writtenPath?.length ?? 0))) break;
      if (blocked.has(template.fileId)) continue;
      const route = importedRegisteredRoute(candidate.child, candidate.registration, template.template, candidate.parent.redirectSlashes);
      if (route) append(route);
    }
    if (cut) break;
  }
  return { routes, blocked, skipped, cut };
}
