import type Parser from 'tree-sitter';
import type { NameValue, ValueSite } from '../../shared/contracts';
import { firstLine, lineRange } from './names';
import { normalize } from './python-imports';
import type { PythonFileFacts, PythonFunctionFact, PythonScope } from './python-names';

export interface PythonValueBinding {
  name: Parser.SyntaxNode;
  scope: PythonScope;
  fn: PythonFunctionFact | null;
  source: Parser.SyntaxNode;
  kind: 'parameter' | 'assignment' | 'annotation' | 'augmented' | 'delete' | 'for' | 'with' | 'except' | 'import';
  value: Parser.SyntaxNode | null;
  annotation: Parser.SyntaxNode | null;
  conditional: boolean;
  shape: NameValue['shape'];
  inClass: boolean;
  parameterKind?: NameValue['parameterKind'];
  parameterIndex?: number | null;
}
export interface PythonValueReference {
  node: Parser.SyntaxNode;
  scope: PythonScope;
  fn: PythonFunctionFact | null;
  inClass: boolean;
}
export type PythonValueOrigin = ({ kind: 'origin'; facts: PythonFileFacts; name: string; viaModule?: boolean }
  | { kind: 'external'; specifier: string } | { kind: 'unknown'; detail: string }) & { localName?: string };

/** Parentheses around one expression do not change its name or object. */
export function pythonParenthesizedValue(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  if (node?.type !== 'parenthesized_expression') return null;
  const children = node.namedChildren.filter(child => !['comment', 'line_continuation'].includes(child.type));
  return children.length === 1 ? children[0] : null;
}

/** Only literal name/attribute chains, never subscripts, calls or computed attributes. */
export function pythonAttributeNames(node: Parser.SyntaxNode | null): string[] | null {
  const names: string[] = [];
  while (node) {
    const inner = pythonParenthesizedValue(node);
    if (inner) { node = inner; continue; }
    if (node.type !== 'attribute') break;
    const name = node.childForFieldName('attribute');
    if (name?.type !== 'identifier') return null;
    names.unshift(normalize(name.text));
    node = node.childForFieldName('object');
  }
  return node?.type === 'identifier' ? [normalize(node.text), ...names] : null;
}

/** Literal attribute reads rooted at this identifier, preserving written names for the card label. */
export function pythonValueAccess(root: Parser.SyntaxNode): { node: Parser.SyntaxNode; names: string[]; label: string } {
  let node = root;
  const names = [root.text];
  while (node.parent) {
    const parent = node.parent;
    if (pythonParenthesizedValue(parent)?.id === node.id) { node = parent; continue; }
    if (parent.type !== 'attribute' || parent.childForFieldName('object')?.id !== node.id) break;
    node = parent;
    names.push(node.childForFieldName('attribute')!.text);
  }
  return { node, names: names.map(normalize), label: names.join('.') };
}
export interface PythonValueFacts {
  bindings: PythonValueBinding[];
  references: PythonValueReference[];
  targets: Map<number, PythonValueBinding['kind']>;
  directives: Map<PythonScope, Map<string, 'global' | 'nonlocal'>>;
  unresolved: Set<PythonScope>;
  dynamic: boolean;
}
export const newPythonValueFacts = (): PythonValueFacts => ({ bindings: [], references: [], targets: new Map(), directives: new Map(), unresolved: new Set(), dynamic: false });

/** Binding targets are not reads, except the old value in an augmented assignment. */
export function pythonValueRead(node: Parser.SyntaxNode, values: PythonValueFacts): boolean {
  const target = values.targets.get(node.id);
  if (target) return target === 'augmented';
  const parent = node.parent;
  if (parent?.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id) return false;
  if (parent?.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id) return false;
  if (parent?.type === 'global_statement' || parent?.type === 'nonlocal_statement') return false;
  return true;
}

const where = (facts: PythonFileFacts, node: Parser.SyntaxNode): ValueSite => ({ fileId: facts.file.id, fileHash: facts.hash,
  startUtf16: node.startIndex, endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) });
const privateName = (name: string) => name === '__class__' || name.startsWith('__') && !name.endsWith('__') || /^_[^_].*__/.test(name);

function baseValue(facts: PythonFileFacts, event: PythonValueBinding, group: NameValue['group']): NameValue {
  const role = event.kind === 'parameter' ? 'parameter' : event.kind === 'for' ? 'for' : event.kind === 'except' ? 'catch'
    : event.kind === 'import' ? 'import' : 'assignment';
  return { group, name: event.name.text, role, shape: event.shape, declaredAt: where(facts, event.name), type: null, fixed: null,
    initial: null, assignments: [], index: null, outerFunction: null, unknown: null, external: null, notes: [] };
}

/** Written facts of one scope/name; assigning twice does not create two Python variables. */
function describe(facts: PythonFileFacts, fn: PythonFunctionFact, events: PythonValueBinding[], group: NameValue['group']): NameValue {
  const values = facts.values!;
  const [first] = events;
  const name = normalize(first.name.text);
  const parameter = events.find(event => event.kind === 'parameter');
  const base = baseValue(facts, parameter ?? first, group);
  const directive = values.directives.get(first.scope)?.get(name);
  if (directive) return { ...base, group: 'outside', unknown: `${directive}로 정한 이름의 실제 선언과 값은 아직 따라가지 않아요.` };
  if (first.inClass && privateName(name)) return { ...base, unknown: '클래스의 비공개 이름 변환과 __class__의 값 출처는 아직 확정하지 않아요.' };
  if (first.kind === 'import') return { ...base, unknown: '가져온 이름의 값 출처를 하나로 정하지 못했어요.' };
  if (group === 'outside' && (!facts.complete || values.dynamic || values.unresolved.has(fn.bodyScope) || values.unresolved.has(first.scope))) {
    return { ...base, unknown: '불완전하거나 동적인 이름 규칙이 있어 바깥 값의 선언을 확정하지 않았어요.' };
  }
  const declarations = first.scope.names.get(name) ?? [];
  if (declarations.some(binding => binding.kind !== 'variable')) {
    return { ...base, unknown: '함수·import 선언과 같은 이름으로 값도 정하고 있어 값 출처를 하나로 정하지 않았어요.' };
  }
  if (parameter && events.filter(event => event.kind === 'parameter').length > 1) {
    return { ...base, unknown: '같은 이름의 매개변수가 여러 번 적혀 있어요.' };
  }
  const annotations = [...new Set(events.flatMap(event => event.annotation ? [event.annotation.text] : []))];
  base.type = annotations.length === 1 ? annotations[0] : null;
  if (annotations.length > 1) base.notes.push('서로 다른 타입 표기가 있어 하나로 고르지 않았어요.');
  if (parameter) {
    if (parameter.value) base.initial = { ...where(facts, parameter.value), kind: 'default' };
    if (parameter.fn && parameter.fn !== fn) base.outerFunction = { name: parameter.fn.displayName, fileId: facts.file.id, fileHash: facts.hash,
      startUtf16: parameter.fn.declaration.startIndex, endUtf16: parameter.fn.declaration.endIndex, startLine: parameter.fn.declaration.startPosition.row + 1 };
    if (parameter.fn === fn && facts.complete && !facts.unclear && !values.dynamic && !values.unresolved.has(first.scope) && parameter.parameterKind) {
      base.parameterKind = parameter.parameterKind;
      base.index = parameter.parameterIndex ?? null;
    } else if (parameter.fn === fn) base.notes.push('매개변수 규칙을 확정하지 못해 호출 인자의 대응을 표시하지 않아요.');
  }
  const writes = events.filter(event => !['parameter', 'annotation', 'delete', 'import'].includes(event.kind));
  const initial = writes[0];
  const simpleFirst = !parameter && facts.complete && !values.dynamic && !values.unresolved.has(first.scope)
    && initial?.kind === 'assignment' && !initial.conditional
    && !events.some(event => event.source.startIndex < initial.source.startIndex && event.kind !== 'annotation');
  if (simpleFirst && initial.value) {
    base.initial = { ...where(facts, initial.shape === 'destructured' ? initial.source : initial.value), kind: initial.shape === 'destructured' ? 'pattern' : 'value' };
  }
  base.assignments = writes.filter(event => !simpleFirst || event !== initial).map(event => where(facts, event.source));
  if (events.some(event => event.conditional)) base.notes.push('조건·반복에 따라 대입이 실행되지 않을 수 있어요. 최종 값을 계산하지 않아요.');
  if (events.some(event => event.kind === 'for')) base.notes.push('반복 대상에서 꺼낸 이름이에요. 반복이 없으면 값이 정해지지 않을 수 있어요.');
  if (initial?.kind === 'augmented') base.notes.push('기존 값으로 계산하는 대입부터 적혀 있어 처음 값을 정하지 않았어요.');
  if (events.some(event => event.kind === 'with')) base.notes.push('with로 받는 값은 준비한 객체의 __enter__ 결과예요. 준비 식 자체를 값으로 표시하지 않아요.');
  if (events.some(event => event.kind === 'except')) base.notes.push('except에서 받은 이름은 해당 except 구문이 끝나면 삭제돼요.');
  for (const event of events.filter(event => event.kind === 'delete')) base.notes.push(`${event.source.startPosition.row + 1}행에 이름을 삭제하는 코드가 있어요: ${firstLine(event.source)}`);
  if (!facts.complete || values.dynamic || values.unresolved.has(first.scope)) base.notes.push('읽은 선언·식만 보여 줘요. 동적 이름 규칙이나 분석 누락 때문에 대입 목록이 완전하다고 보장하지 않아요.');
  if (events.every(event => event.kind === 'annotation')) base.notes.push('타입만 적혀 있으며 값을 넣는 대입은 없어요.');
  return base;
}

/** Emit each name within the caller's shared result budget, rather than accumulating an unbounded result. */
export async function pythonValuesOf(facts: PythonFileFacts, fn: PythonFunctionFact,
  functionReferences: ReadonlySet<number>, emit: (value: NameValue) => boolean, stop: () => void,
  followImport?: (reference: PythonValueReference) => Promise<PythonValueOrigin>): Promise<void> {
  const values = facts.values;
  if (!values) return;
  const groups = new Map<PythonScope, Map<string, PythonValueBinding[]>>();
  for (const event of values.bindings) {
    stop();
    let scope = groups.get(event.scope);
    if (!scope) { scope = new Map(); groups.set(event.scope, scope); }
    const name = normalize(event.name.text);
    const previous = scope.get(name);
    if (previous) previous.push(event);
    else scope.set(name, [event]);
  }
  const seen = new Set<PythonValueBinding[]>();
  const importedSeen = new Map<PythonValueBinding[], { paths: Set<string>; cards: Set<string> }>();
  const originNames = new Map<PythonFileFacts, Map<string, PythonValueBinding[]>>();
  const follow = async (base: NameValue, reference: PythonValueReference): Promise<NameValue> => {
    const origin = await followImport!(reference);
    stop();
    base = { ...base, name: origin.localName ?? base.name };
    if (origin.kind === 'unknown') return { ...base, unknown: origin.detail };
    if (origin.kind === 'external') return { ...base, unknown: null, external: origin.specifier };
    let names = originNames.get(origin.facts);
    if (!names) {
      names = new Map();
      for (const event of origin.facts.values?.bindings ?? []) {
        stop();
        if (event.scope !== origin.facts.program) continue;
        const name = normalize(event.name.text);
        const events = names.get(name);
        if (events) events.push(event);
        else names.set(name, [event]);
      }
      originNames.set(origin.facts, names);
    }
    return importedValue(base, origin.facts, origin.name, names.get(origin.name) ?? [], !!origin.viaModule);
  };
  const unknownDirectives = new Map<PythonScope, Set<string>>();
  for (const scope of groups.values()) {
    for (const events of scope.values()) {
      stop();
      if (!events.some(event => event.fn === fn) || events.every(event => event.kind === 'import')) continue;
      events.sort((a, b) => a.source.startIndex - b.source.startIndex);
      seen.add(events);
      const group = events.some(event => event.kind === 'parameter' && event.fn === fn) ? 'parameter' : 'inside';
      if (!emit(describe(facts, fn, events, group))) return;
    }
  }
  for (const reference of values.references) {
    stop();
    if (reference.fn !== fn) continue;
    const name = normalize(reference.node.text);
    let scope: PythonScope | null = reference.scope;
    while (scope && !scope.names.has(name) && !values.directives.get(scope)?.has(name)) scope = scope.parent;
    if (!scope) continue;
    const events = groups.get(scope)?.get(name);
    if (!events) {
      const directive = values.directives.get(scope)?.get(name);
      if (!directive || unknownDirectives.get(scope)?.has(name)) continue;
      const names = unknownDirectives.get(scope) ?? new Set<string>();
      names.add(name);
      unknownDirectives.set(scope, names);
      const value: NameValue = { group: 'outside', name: reference.node.text, role: 'assignment', shape: 'plain', declaredAt: null,
        type: null, fixed: null, initial: null, assignments: [], index: null, outerFunction: null, external: null, notes: [],
        unknown: `${directive}로 정한 이름의 실제 선언과 값은 아직 따라가지 않아요.` };
      if (!emit(value)) return;
      continue;
    }
    if (seen.has(events)) continue;
    if (functionReferences.has(reference.node.id) && events.every(event => event.kind === 'import')) continue;
    events.sort((a, b) => a.source.startIndex - b.source.startIndex);
    let value = describe(facts, fn, events, events.some(event => event.fn === fn) ? 'inside' : 'outside');
    if (followImport && events.length === 1 && events[0].kind === 'import') {
      const visited = importedSeen.get(events) ?? { paths: new Set<string>(), cards: new Set<string>() };
      importedSeen.set(events, visited);
      const key = normalize(pythonValueAccess(reference.node).label);
      if (visited.paths.has(key)) continue;
      visited.paths.add(key);
      value = await follow(value, reference);
      if (visited.cards.has(normalize(value.name))) continue;
      visited.cards.add(normalize(value.name));
    } else seen.add(events);
    if (reference.inClass && privateName(name)) {
      value.unknown = '클래스의 비공개 이름 변환과 __class__의 값 출처는 아직 확정하지 않아요.';
      value.declaredAt = null;
      value.initial = null;
      value.type = null;
      value.assignments = [];
      value.outerFunction = null;
    }
    if (!emit(value)) return;
  }
}

/** A from-import captures an object reference; later module rebindings are not writes to this local name. */
function importedValue(base: NameValue, facts: PythonFileFacts, name: string, events: PythonValueBinding[], viaModule: boolean): NameValue {
  const bindings = facts.program.names.get(name) ?? [];
  const [event] = events;
  if (!facts.complete || !facts.importsPlain || facts.values?.dynamic || facts.values?.unresolved.has(facts.program)) {
    return { ...base, unknown: '가져온 파일에 분석 누락이나 동적인 이름 규칙이 있어 값 출처를 확정하지 않았어요.' };
  }
  if (bindings.length !== 1 || bindings[0].kind !== 'variable' || events.length !== 1 || event.kind !== 'assignment'
    || event.conditional || event.shape !== 'plain' || !event.value || event.source.type !== 'assignment'
    || event.source.childForFieldName('right')?.type === 'assignment'
    || event.source.parent?.type !== 'expression_statement' || event.source.parent.parent?.type !== 'module') {
    return { ...base, unknown: '가져온 이름이 파일 맨 위의 한 번뿐인 단순 대입이 아니어서 값 출처를 확정하지 않았어요.' };
  }
  return { ...base, declaredAt: where(facts, event.name), initial: { ...where(facts, event.value), kind: viaModule ? 'value' : 'export' },
    type: event.annotation?.text ?? null, unknown: null, assignments: [], fixed: null,
    notes: [viaModule ? '모듈에 처음 적힌 대입 식이에요. 속성을 읽는 실행 시점의 값이나 객체 내부 상태는 계산하지 않아요.'
      : '가져오는 코드의 출처예요. 실행 시점의 값이나 객체 내부 상태는 계산하지 않아요. 원본 이름의 나중 재대입을 따라가는 연결은 아니에요.'] };
}
