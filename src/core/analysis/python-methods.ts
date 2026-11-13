import type Parser from 'tree-sitter';
import { firstLine } from './names';
import { normalize } from './python-imports';
import { resolvePythonName, type PythonBinding, type PythonCallFact, type PythonClassFact, type PythonFileFacts, type PythonFunctionFact, type PythonImportBinding, type PythonScope } from './python-names';
import { pythonParametersOf, type PythonParameter } from './python-parameters';
import { pythonAttributeNames, pythonValueAccess } from './python-values';

export interface PythonClassOrigin { facts: PythonFileFacts; owner: PythonClassFact }
export interface PythonMethodResolution { kind: 'typed'; facts: PythonFileFacts; fn: PythonFunctionFact; basis: string }
export interface PythonMethodEffects {
  escaped: Set<PythonClassFact>;
  changed: Map<PythonClassFact, Set<string>>;
}
interface ClassLinks {
  imported(binding: PythonImportBinding, suffix: string[]): (PythonClassOrigin & { consumed: number }) | null;
  member(origin: PythonClassOrigin, name: string): PythonFunctionFact | null;
}
type BoundName = { binding: PythonBinding; scope: PythonScope };
type Receiver = PythonClassOrigin & { consumed: number; basis: string };
type Parameter = PythonParameter & { node: Parser.SyntaxNode };
const privateName = (name: string) => name === '__class__' || name.startsWith('__') && !name.endsWith('__') || /^_[^_].*__/.test(name);
const hooks = new Set(['__getattribute__', '__getattr__', '__setattr__', '__delattr__', '__get__', '__set__', '__delete__']);

/** Build indexes first, then scan effects once for the whole job before resolving any candidate. */
export function pythonMethodResolver(facts: PythonFileFacts, links: ClassLinks, effects: PythonMethodEffects, stop: () => void) {
  const classes = new Map(facts.classes.map(owner => [owner.name.id, owner]));
  const classScopes = new Map(facts.classes.map(owner => [owner.bodyScope, owner]));
  const functions = new Map(facts.functions.map(fn => [fn.bodyScope, fn]));
  const headers = new Map<PythonFunctionFact, Map<number, Parameter> | null>();
  const modes = new Map<PythonFunctionFact, 'plain' | 'static' | 'class' | null>();
  const receivers = new Map<PythonBinding, Receiver | null>();
  const usableClasses = new Map<PythonClassFact, boolean>();
  const { escaped, changed } = effects;

  function usable(owner: PythonClassFact): boolean {
    const cached = usableClasses.get(owner);
    if (cached !== undefined) return cached;
    stop();
    const bindings = owner.parentScope.names.get(normalize(owner.name.text)) ?? [];
    const bases = owner.node.childForFieldName('superclasses')?.namedChildren.filter(node => !['comment', 'line_continuation'].includes(node.type)) ?? [];
    const result = facts.complete && !facts.unclear && owner.parentScope === facts.program && !owner.conditional && !owner.decorated
      && !privateName(normalize(owner.name.text)) && !bases.length && bindings.length === 1 && bindings[0].kind === 'variable'
      && bindings[0].node.id === owner.name.id && ![...hooks].some(name => owner.bodyScope.names.has(name));
    usableClasses.set(owner, result);
    return result;
  }
  function header(fn: PythonFunctionFact): Map<number, Parameter> | null {
    if (headers.has(fn)) return headers.get(fn)!;
    stop();
    const parameters = fn.node.childForFieldName('parameters');
    const kinds = pythonParametersOf(parameters, fn.parentScope.kind === 'class');
    if (!kinds) { headers.set(fn, null); return null; }
    const result = new Map<number, Parameter>();
    for (const parameter of parameters!.namedChildren) {
      stop();
      const kind = kinds.get(parameter.id);
      if (!kind) continue;
      const annotation = parameter.childForFieldName('type');
      const name = parameter.childForFieldName('name') ?? (parameter.type === 'typed_parameter'
        ? parameter.namedChildren.find(node => node.id !== annotation?.id && !['comment', 'line_continuation'].includes(node.type)) : parameter);
      if (name?.type === 'identifier') result.set(name.id, { ...kind, node: parameter });
    }
    headers.set(fn, result);
    return result;
  }
  function mode(fn: PythonFunctionFact): 'plain' | 'static' | 'class' | null {
    if (modes.has(fn)) return modes.get(fn)!;
    stop();
    if (!fn.decorated) { modes.set(fn, 'plain'); return 'plain'; }
    modes.set(fn, null);
    const decorators = fn.declaration.namedChildren.filter(node => node.type === 'decorator');
    if (decorators.length !== 1) return null;
    const name = decorators[0].namedChildren.filter(node => node.type !== 'comment');
    if (name.length !== 1 || name[0].type !== 'identifier') return null;
    const normalized = normalize(name[0].text);
    if (!['staticmethod', 'classmethod'].includes(normalized)) return null;
    for (let scope: PythonScope | null = fn.parentScope; scope; scope = scope.parent) {
      stop();
      if (scope.names.has(normalized)) return null;
    }
    const result = normalized === 'staticmethod' ? 'static' : 'class';
    modes.set(fn, result);
    return result;
  }
  function member(owner: PythonClassFact, name: string): PythonFunctionFact | null {
    stop();
    if (!usable(owner) || privateName(name)) return null;
    const bindings = owner.bodyScope.names.get(name) ?? [];
    if (bindings.length !== 1 || bindings[0].kind !== 'function') return null;
    const fn = bindings[0].fn;
    return !fn.conditional && mode(fn) && header(fn) ? fn : null;
  }
  function classOf(binding: PythonBinding): PythonClassFact | null {
    const owner = binding.kind === 'variable' ? classes.get(binding.node.id) : undefined;
    return owner && usable(owner) ? owner : null;
  }
  function receiver(names: string[], found: BoundName): Receiver | null {
    const { binding, scope } = found;
    if (binding.kind === 'import') {
      const origin = links.imported(binding, names.slice(1));
      return origin ? { ...origin, basis: `가져온 클래스 ${firstLine(origin.owner.name)}에 적힌 메서드 후보예요.` } : null;
    }
    if (receivers.has(binding)) return receivers.get(binding)!;
    receivers.set(binding, null);
    stop();
    if (binding.kind !== 'variable') return null;
    const literal = classOf(binding);
    if (literal) {
      const result = { facts, owner: literal, consumed: 1, basis: `같은 파일의 클래스 ${firstLine(literal.name)}에 적힌 메서드 후보예요.` };
      receivers.set(binding, result);
      return result;
    }
    const fn = functions.get(scope);
    if (!fn) return null;
    const parameter = header(fn)?.get(binding.node.id);
    if (!parameter || parameter.parameterKind.startsWith('var-')) return null;
    const owner = classScopes.get(fn.parentScope);
    if (owner && parameter.parameterIndex === 0 && member(owner, fn.normalizedName) === fn && mode(fn) !== 'static') {
      const result = { facts, owner, consumed: 1, basis: `같은 클래스 ${firstLine(owner.name)}의 첫 매개변수 ${firstLine(binding.node)}로 찾은 후보예요.` };
      receivers.set(binding, result);
      return result;
    }
    const annotation = parameter.node.childForFieldName('type');
    const type = annotation?.type === 'type' && annotation.namedChildCount === 1 ? annotation.firstNamedChild : annotation;
    const typeNames = pythonAttributeNames(type ?? null);
    if (!type || !typeNames || typeNames.some(privateName)) return null;
    const written = resolvePythonName(facts, { node: type, scope: fn.parentScope, inClass: fn.parentScope.kind === 'class' }, typeNames[0]);
    if (written.kind !== 'binding') return null;
    let origin: PythonClassOrigin | null = null;
    if (written.binding.kind === 'import') {
      if (written.binding.node.endIndex > fn.declaration.startIndex) return null;
      const imported = links.imported(written.binding, typeNames.slice(1));
      if (imported?.consumed === typeNames.length) origin = imported;
    } else if (typeNames.length === 1) {
      const target = classOf(written.binding);
      if (target) origin = { facts, owner: target };
    }
    if (!origin || origin.facts === facts && origin.owner.declaration.endIndex > fn.declaration.startIndex) return null;
    const result = { ...origin, consumed: 1, basis: `매개변수 ${firstLine(binding.node)}에 적힌 타입 ${firstLine(type)}으로 찾은 후보예요.` };
    receivers.set(binding, result);
    return result;
  }
  function receiverAt(node: Parser.SyntaxNode, scope: PythonScope, names: string[]): Receiver | null {
    const found = resolvePythonName(facts, { node, scope, inClass: false }, names[0]);
    return found.kind === 'binding' ? receiver(names, found) : null;
  }
  function scanEffects(): void {
    for (const write of facts.attributeWrites) {
      stop();
      const names = pythonAttributeNames(write.node);
      if (!names || names.length < 2) continue;
      const origin = receiverAt(write.node, write.scope, names);
      if (!origin || names.length <= origin.consumed) continue;
      const name = names[origin.consumed];
      if (hooks.has(name) || ['__class__', '__dict__', '__bases__'].includes(name)) { escaped.add(origin.owner); continue; }
      const methods = changed.get(origin.owner) ?? new Set<string>();
      methods.add(name);
      changed.set(origin.owner, methods);
    }
    for (const reference of facts.moduleEscapes) {
      stop();
      const access = pythonValueAccess(reference.node);
      const origin = receiverAt(reference.node, reference.scope, access.names);
      if (!origin) continue;
      if (access.names.length === origin.consumed || links.member(origin, access.names[origin.consumed])) escaped.add(origin.owner);
    }
  }
  function resolve(call: PythonCallFact, names: string[], found: BoundName): PythonMethodResolution | null {
    stop();
    if (names.length < 2 || names.some(privateName)) return null;
    const origin = receiver(names, found);
    if (!origin || names.length !== origin.consumed + 1 || escaped.has(origin.owner) || changed.get(origin.owner)?.has(names.at(-1)!)) return null;
    for (let execution: PythonScope | null = call.scope; execution; execution = execution.executionParent) {
      stop();
      if (origin.facts === facts && execution === origin.owner.parentScope && call.node.startIndex < origin.owner.declaration.endIndex) return null;
      if (execution.deferred) break;
    }
    const fn = links.member(origin, names.at(-1)!);
    return fn ? { kind: 'typed', facts: origin.facts, fn, basis: origin.basis } : null;
  }
  return { classOf, member, receiver, scanEffects, resolve };
}
