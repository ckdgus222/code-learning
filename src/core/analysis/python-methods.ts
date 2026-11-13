import type Parser from 'tree-sitter';
import { firstLine } from './names';
import { normalize } from './python-imports';
import { resolvePythonName, type PythonBinding, type PythonCallFact, type PythonClassFact, type PythonFileFacts, type PythonFunctionFact, type PythonScope } from './python-names';
import { pythonParametersOf, type PythonParameter } from './python-parameters';
import { pythonAttributeNames, pythonValueAccess } from './python-values';

export interface PythonMethodResolution { kind: 'typed'; fn: PythonFunctionFact; basis: string }
type BoundName = { binding: PythonBinding; scope: PythonScope };
type Receiver = { owner: PythonClassFact; basis: string };
type Parameter = PythonParameter & { node: Parser.SyntaxNode };
const privateName = (name: string) => name === '__class__' || name.startsWith('__') && !name.endsWith('__') || /^_[^_].*__/.test(name);
const hooks = new Set(['__getattribute__', '__getattr__', '__setattr__', '__delattr__', '__get__', '__set__', '__delete__']);

/** Same-file candidates only; a class shape never proves which runtime object is received. */
export function pythonMethodResolver(facts: PythonFileFacts, stop: () => void) {
  const classes = new Map(facts.classes.map(owner => [owner.name.id, owner]));
  const classScopes = new Map(facts.classes.map(owner => [owner.bodyScope, owner]));
  const functions = new Map(facts.functions.map(fn => [fn.bodyScope, fn]));
  const headers = new Map<PythonFunctionFact, Map<number, Parameter> | null>();
  const modes = new Map<PythonFunctionFact, 'plain' | 'static' | 'class' | null>();
  const receivers = new Map<PythonBinding, Receiver | null>();
  const usableClasses = new Map<PythonClassFact, boolean>();
  const escaped = new Set<PythonClassFact>();
  const changed = new Map<PythonClassFact, Set<string>>();

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
  function receiver(found: BoundName): Receiver | null {
    const { binding, scope } = found;
    if (receivers.has(binding)) return receivers.get(binding)!;
    receivers.set(binding, null);
    stop();
    if (binding.kind !== 'variable') return null;
    const literal = classes.get(binding.node.id);
    if (literal && usable(literal)) {
      const result = { owner: literal, basis: `같은 파일의 클래스 ${firstLine(literal.name)}에 적힌 메서드 후보예요.` };
      receivers.set(binding, result);
      return result;
    }
    const fn = functions.get(scope);
    if (!fn) return null;
    const parameter = header(fn)?.get(binding.node.id);
    if (!parameter || parameter.parameterKind.startsWith('var-')) return null;
    const owner = classScopes.get(fn.parentScope);
    if (owner && parameter.parameterIndex === 0 && member(owner, fn.normalizedName) === fn && mode(fn) !== 'static') {
      const result = { owner, basis: `같은 클래스 ${firstLine(owner.name)}의 첫 매개변수 ${firstLine(binding.node)}로 찾은 후보예요.` };
      receivers.set(binding, result);
      return result;
    }
    const annotation = parameter.node.childForFieldName('type');
    const type = annotation?.type === 'type' && annotation.namedChildCount === 1 ? annotation.firstNamedChild : annotation;
    if (type?.type !== 'identifier') return null;
    const written = resolvePythonName(facts, { node: type, scope: fn.parentScope, inClass: fn.parentScope.kind === 'class' }, type.text);
    if (written.kind !== 'binding' || written.binding.kind !== 'variable') return null;
    const target = classes.get(written.binding.node.id);
    if (!target || !usable(target) || target.declaration.endIndex > fn.declaration.startIndex) return null;
    const result = { owner: target, basis: `매개변수 ${firstLine(binding.node)}에 적힌 타입 ${firstLine(type)}으로 찾은 후보예요.` };
    receivers.set(binding, result);
    return result;
  }
  function receiverAt(node: Parser.SyntaxNode, scope: PythonScope, name: string): Receiver | null {
    const found = resolvePythonName(facts, { node, scope, inClass: false }, name);
    return found.kind === 'binding' ? receiver(found) : null;
  }
  for (const write of facts.attributeWrites) {
    stop();
    const names = pythonAttributeNames(write.node);
    if (!names || names.length < 2) continue;
    const origin = receiverAt(write.node, write.scope, names[0]);
    if (!origin) continue;
    if (hooks.has(names[1]) || ['__class__', '__dict__', '__bases__'].includes(names[1])) { escaped.add(origin.owner); continue; }
    const methods = changed.get(origin.owner) ?? new Set<string>();
    methods.add(names[1]);
    changed.set(origin.owner, methods);
  }
  for (const reference of facts.moduleEscapes) {
    stop();
    const access = pythonValueAccess(reference.node);
    const origin = receiverAt(reference.node, reference.scope, access.names[0]);
    if (!origin) continue;
    if (access.names.length === 1 || member(origin.owner, access.names[1])) escaped.add(origin.owner);
  }
  return (call: PythonCallFact, names: string[], found: BoundName): PythonMethodResolution | null => {
    stop();
    if (names.length !== 2 || names.some(privateName)) return null;
    const origin = receiver(found);
    if (!origin || escaped.has(origin.owner) || changed.get(origin.owner)?.has(names[1])) return null;
    for (let execution: PythonScope | null = call.scope; execution; execution = execution.executionParent) {
      stop();
      if (execution === origin.owner.parentScope && call.node.startIndex < origin.owner.declaration.endIndex) return null;
      if (execution.deferred) break;
    }
    const fn = member(origin.owner, names[1]);
    return fn ? { kind: 'typed', fn, basis: origin.basis } : null;
  };
}
