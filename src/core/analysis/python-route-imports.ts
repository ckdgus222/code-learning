import type { ProjectFile, Route } from '../../shared/contracts';
import { pythonCallResolver } from './python-call-imports';
import { resolvePythonName, type PythonFileFacts } from './python-names';
import { importedPythonTemplates, importedPythonRegistration, importedRegisteredRoute, pythonRegistrationChild, pythonBlueprintRegistrationName,
  type PythonImportedTemplate, type PythonRouteImportFacts, type PythonRouteImportRoom, type PythonRouteOwnerOrigin,
  type PythonRouterRegistration } from './python-routes';
import { pythonAttributeNames } from './python-values';
import { lacksRouteEvidence, ROUTE_LIMITS } from './routes';

type Origins = Map<string, Map<string, PythonRouteOwnerOrigin>>;
type Registration = { fileId: string; originId: string; at: number; parent: PythonRouteOwnerOrigin;
  child: PythonRouteOwnerOrigin; registration: PythonRouterRegistration };

/** Resolve only after every readable file has contributed its import and mutation facts. */
export function importedAppRoutes(files: ProjectFile[], parsed: ReadonlyMap<string, PythonFileFacts>,
  sources: ReadonlyMap<string, PythonRouteImportFacts>, complete: boolean, maxRoutes: number, stop: () => void,
  room?: PythonRouteImportRoom, existing: readonly Route[] = []) {
  const resolver = pythonCallResolver(files, parsed, stop);
  const ownerNames = new Map<string, Set<string>>();
  const decorators = new Map<string, Set<number>>();
  const registrationReads = new Map<string, Set<number>>();
  type Template = { fileId: string; originId: string; template: PythonImportedTemplate };
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
  const factory = prepareFactoryRegistrations(parsed, sources, origins, resolver, complete, spend);
  registrations.push(...factory.registrations);
  for (const [parent, names] of factory.flaskNames) flaskNames.set(parent, names);
  for (const [fileId, source] of sources) {
    stop();
    const facts = parsed.get(fileId);
    if (facts) ownerNames.set(facts.file.relativePath, new Set(source.owners.map(owner => owner.name)));
    for (const owner of origins.get(fileId)?.values() ?? []) {
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
      if (factory.callStarts.get(fileId)?.has(call.node.startIndex)) continue;
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

/** Recover only module-router reads proven to be registrations on an already validated factory app. */
function prepareFactoryRegistrations(parsed: ReadonlyMap<string, PythonFileFacts>, sources: ReadonlyMap<string, PythonRouteImportFacts>,
  origins: Origins, resolver: ReturnType<typeof pythonCallResolver>, complete: boolean, spend: (cost: number) => boolean) {
  const registrations: Registration[] = [];
  const callStarts = new Map<string, Set<number>>();
  const flaskNames = new Map<PythonRouteOwnerOrigin, Map<string, number>>();
  const failedParents = new Set<PythonRouteOwnerOrigin>();
  const empty = () => ({ registrations: [], callStarts, flaskNames });
  if (!complete) return empty();
  const collectFile = (fileId: string, source: PythonRouteImportFacts, facts: PythonFileFacts | undefined): boolean => {
    if (!facts || !source.factories?.length) return true;
    const functions = new Map(facts.functions.map(fn => [fn.node.startIndex, fn]));
    const calls = new Map((facts.routeCalls ?? []).map(call => [call.node.startIndex, call]));
    for (const context of source.factories) {
      if (!spend(100)) return false;
      const fn = functions.get(context.functionStartUtf16), parent = context.parent;
      if (!fn || !parent.safe || fn.parentScope !== facts.program || fn.decorated || fn.conditional
        || fn.body.startIndex !== context.bodyStartUtf16 || fn.body.endIndex !== context.bodyEndUtf16) continue;
      const last = fn.body.namedChildren.filter(node => !['comment', 'line_continuation'].includes(node.type)).at(-1);
      const returned = last?.type === 'return_statement' ? last.namedChildren.find(node => node.type !== 'comment') : null;
      if (returned?.type !== 'identifier' || returned.startIndex !== context.returnedReadStartUtf16) continue;
      const binding = resolvePythonName(facts, { node: returned, scope: fn.bodyScope, inClass: false }, parent.name);
      if (binding.kind === 'unknown' || binding.scope !== fn.bodyScope || binding.binding.kind !== 'variable'
        || binding.binding.node.startIndex !== parent.bindingStartUtf16) continue;
      const local = new Map(context.localBlueprintRegistrations.map(registration => [registration.callStartUtf16, registration.name]));
      const names = new Map<string, number>();
      for (const name of local.values()) {
        if (!name) failedParents.add(parent);
        else names.set(name, (names.get(name) ?? 0) + 1);
      }
      flaskNames.set(parent, names);
      for (const start of context.registrationStarts) {
        if (!spend(100)) return false;
        const call = calls.get(start), called = call && pythonAttributeNames(call.node.childForFieldName('function'));
        if (!call || call.fn !== fn || call.scope !== fn.bodyScope || call.node.parent?.type !== 'expression_statement'
          || call.node.parent.parent?.startIndex !== fn.body.startIndex || called?.length !== 2 || called[0] !== parent.name
          || called[1] !== (parent.app.framework === 'fastapi' ? 'include_router' : 'register_blueprint')) {
          failedParents.add(parent); continue;
        }
        const starts = callStarts.get(fileId) ?? new Set<number>();
        starts.add(start); callStarts.set(fileId, starts);
        const parentBinding = resolvePythonName(facts, call, parent.name);
        if (parentBinding.kind === 'unknown' || parentBinding.scope !== fn.bodyScope || parentBinding.binding.kind !== 'variable'
          || parentBinding.binding.node.startIndex !== parent.bindingStartUtf16) { failedParents.add(parent); continue; }
        if (local.has(start)) continue;
        const input = pythonRegistrationChild(call.node), childNames = pythonAttributeNames(input);
        const found = childNames && resolvePythonName(facts, call, childNames[0]);
        if (!childNames || !found || found.kind === 'unknown' || found.scope !== facts.program) { failedParents.add(parent); continue; }
        let originId = fileId, child: PythonRouteOwnerOrigin | undefined;
        if (found.binding.kind === 'variable' && childNames.length === 1) {
          child = origins.get(fileId)?.get(childNames[0]);
          if (child?.bindingStartUtf16 !== found.binding.node.startIndex) child = undefined;
        } else if (found.binding.kind === 'import') {
          const origin = resolver.resolveRouteObject(facts, call, childNames, true);
          if (origin) {
            originId = origin.facts.file.id; child = origins.get(originId)?.get(origin.name);
            if (child?.bindingStartUtf16 !== origin.bindingStartUtf16) child = undefined;
          }
        }
        if (!child?.app.router || child.app.framework !== parent.app.framework || !child.safe && !child.factoryReadReview?.baseSafe) {
          failedParents.add(parent); continue;
        }
        const registration = importedPythonRegistration({ ...child, safe: true }, call.node);
        if (!registration) { failedParents.add(parent); continue; }
        if (registration.name) names.set(registration.name, (names.get(registration.name) ?? 0) + 1);
        registrations.push({ fileId, originId, at: start, parent, child, registration });
      }
      if ([...names.values()].some(count => count > 1)) failedParents.add(parent);
    }
    return true;
  };
  for (const [fileId, source] of sources) if (!collectFile(fileId, source, parsed.get(fileId))) return empty();
  // A parent needs safe children; a recovered module owner needs every suspicious read to belong
  // to a safe parent. Remove failed nodes through this dependency graph instead of rescanning it.
  const reads = new Map<string, Map<number, Registration>>();
  const parentsByChild = new Map<PythonRouteOwnerOrigin, Set<PythonRouteOwnerOrigin>>();
  const ownersByParent = new Map<PythonRouteOwnerOrigin, Set<PythonRouteOwnerOrigin>>();
  for (const registration of registrations) {
    const parents = parentsByChild.get(registration.child) ?? new Set<PythonRouteOwnerOrigin>();
    parents.add(registration.parent); parentsByChild.set(registration.child, parents);
    if (registration.fileId !== registration.originId) continue;
    const starts = reads.get(registration.fileId) ?? new Map<number, Registration>();
    starts.set(registration.registration.input.startIndex, registration); reads.set(registration.fileId, starts);
  }
  const failedOwners = new Set<PythonRouteOwnerOrigin>();
  for (const [fileId, owners] of origins) for (const owner of owners.values()) {
    if (owner.safe) continue;
    const review = owner.factoryReadReview;
    if (!review?.baseSafe || !review.unsafeReadStarts.length) { failedOwners.add(owner); continue; }
    for (const start of review.unsafeReadStarts) {
      if (!spend(1)) return empty();
      const registration = reads.get(fileId)?.get(start);
      if (!registration || registration.child !== owner) { failedOwners.add(owner); continue; }
      const dependents = ownersByParent.get(registration.parent) ?? new Set<PythonRouteOwnerOrigin>();
      dependents.add(owner); ownersByParent.set(registration.parent, dependents);
    }
  }
  const pending: { kind: 'owner' | 'parent'; value: PythonRouteOwnerOrigin }[] = [
    ...[...failedParents].map(value => ({ kind: 'parent' as const, value })), ...[...failedOwners].map(value => ({ kind: 'owner' as const, value })),
  ];
  for (let index = 0; index < pending.length; index++) {
    const { kind, value } = pending[index];
    const next = kind === 'owner' ? parentsByChild.get(value) : ownersByParent.get(value);
    const failed = kind === 'owner' ? failedParents : failedOwners;
    for (const dependent of next ?? []) {
      if (!spend(1)) return empty();
      if (failed.has(dependent)) continue;
      failed.add(dependent); pending.push({ kind: kind === 'owner' ? 'parent' : 'owner', value: dependent });
    }
  }
  const updated = new Map<PythonRouteOwnerOrigin, PythonRouteOwnerOrigin>();
  for (const owners of origins.values()) for (const [name, owner] of owners) {
    if (owner.safe || failedOwners.has(owner)) continue;
    const copy = { ...owner, safe: true }; owners.set(name, copy); updated.set(owner, copy);
  }
  return { callStarts, flaskNames, registrations: registrations.filter(candidate => !failedParents.has(candidate.parent))
    .map(candidate => ({ ...candidate, child: updated.get(candidate.child) ?? candidate.child })) };
}
