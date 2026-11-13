import type Parser from 'tree-sitter';
import type { CallUnknownReason, ProjectFile } from '../../shared/contracts';
import { NESTED_NOTE, parse } from './syntax';
import { normalize } from './python-imports';
import { pythonFunction } from './python-syntax';

type Binding = { kind: 'function'; fn: PythonFunctionFact } | { kind: 'variable' | 'import'; node: Parser.SyntaxNode };
export interface PythonScope {
  kind: 'module' | 'function' | 'class' | 'lambda' | 'comprehension';
  parent: PythonScope | null;
  /** Classes and comprehensions execute here even when name lookup skips a class namespace. */
  executionParent: PythonScope | null;
  deferred: boolean;
  names: Map<string, Binding[]>;
}
export interface PythonFunctionFact {
  node: Parser.SyntaxNode;
  declaration: Parser.SyntaxNode;
  body: Parser.SyntaxNode;
  parentScope: PythonScope;
  bodyScope: PythonScope;
  normalizedName: string;
  displayName: string;
  conditional: boolean;
  decorated: boolean;
}
export interface PythonCallFact { node: Parser.SyntaxNode; scope: PythonScope; fn: PythonFunctionFact | null; inClass: boolean }
export interface PythonFileFacts {
  file: ProjectFile;
  hash: string;
  text: string;
  complete: boolean;
  incompleteReason: string | null;
  unclear: string | null;
  program: PythonScope;
  functions: PythonFunctionFact[];
  calls: PythonCallFact[];
}

const scopeOf = (kind: PythonScope['kind'], parent: PythonScope | null, executionParent = parent,
  deferred = kind === 'function' || kind === 'lambda'): PythonScope => ({ kind, parent, executionParent, deferred, names: new Map() });
const lexicalParent = (scope: PythonScope): PythonScope | null => {
  let parent: PythonScope | null = scope;
  while (parent?.kind === 'class') parent = parent.parent;
  return parent;
};
const conditionalBlocks = new Set(['if_statement', 'for_statement', 'while_statement', 'try_statement', 'with_statement', 'match_statement']);
const comprehensions = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
const dynamicNames = new Set(['exec', 'eval', 'globals', 'locals', 'vars', 'setattr', 'delattr', '__import__',
  '__builtins__', '__dict__', '__globals__', '__code__', '__getattribute__', 'f_globals', 'f_locals']);

function bind(scope: PythonScope, name: string, binding: Binding): void {
  const key = normalize(name);
  const previous = scope.names.get(key);
  if (previous) previous.push(binding);
  else scope.names.set(key, [binding]);
}

/** Only assignment targets bind names; attribute receivers, keys and default values do not. */
function bindPattern(scope: PythonScope, root: Parser.SyntaxNode | null): void {
  const pending = root ? [root] : [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'identifier') { bind(scope, node.text, { kind: 'variable', node }); continue; }
    if (node.type === 'attribute' || node.type === 'subscript') continue;
    if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'as_pattern_target',
      'list_splat_pattern', 'dictionary_splat_pattern', 'parenthesized_expression'].includes(node.type)) pending.push(...node.namedChildren);
  }
}

function bindParameters(scope: PythonScope, parameters: Parser.SyntaxNode | null): void {
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type === 'typed_parameter') {
      bindPattern(scope, parameter.namedChildren.find(child => child.id !== parameter.childForFieldName('type')?.id) ?? null);
      continue;
    }
    bindPattern(scope, parameter.childForFieldName('name') ?? parameter);
  }
}

/** Collect every binding before resolving any call: a later assignment also makes an earlier read local. */
export function readPythonFacts(file: ProjectFile, text: string, hash: string, nodeBudget: number): PythonFileFacts {
  const root = parse(text, file.relativePath);
  const program = scopeOf('module', null);
  const facts: PythonFileFacts = { file, text, hash, program, functions: [], calls: [], unclear: null,
    complete: !!root && !root.hasError,
    incompleteReason: !root ? NESTED_NOTE : root.hasError ? '구문 오류가 있어 이 파일의 이름은 확정하지 않았어요.' : null };
  if (!root) return facts;
  type Frame = { node: Parser.SyntaxNode; scope: PythonScope; fn: PythonFunctionFact | null; conditional: boolean; calls: boolean; inClass: boolean };
  const pending: Frame[] = [{ node: root, scope: program, fn: null, conditional: false, calls: true, inClass: false }];
  let visited = 0;
  while (pending.length) {
    if (++visited > nodeBudget) { facts.complete = false; facts.incompleteReason = '구문 개수 한도에 닿아 이 파일의 이름은 확정하지 않았어요.'; break; }
    const frame = pending.pop()!;
    const { node, scope, fn } = frame;
    const push = (child: Parser.SyntaxNode, changes: Partial<Frame> = {}) => pending.push({ ...frame, ...changes, node: child });
    if (node.type === 'identifier' && dynamicNames.has(normalize(node.text))) facts.unclear = '동적으로 이름이나 함수 내용을 바꾸는 이름이 있어 이 파일의 연결은 확정하지 않았어요.';
    if (['global_statement', 'nonlocal_statement', 'match_statement', 'type_alias_statement', 'type_parameter'].includes(node.type)) {
      facts.unclear = 'global·nonlocal·match·타입 매개변수의 이름 규칙은 아직 확정하지 않아요.';
    }
    if (node.type === 'function_definition') {
      const found = pythonFunction(node);
      const name = node.childForFieldName('name');
      if (!found || !name) continue;
      // A method closes over enclosing functions, never over its class's namespace.
      const bodyScope = scopeOf('function', lexicalParent(scope), scope);
      const item: PythonFunctionFact = { node, declaration: found.declaration, body: found.body, parentScope: scope, bodyScope,
        normalizedName: normalize(name.text), displayName: found.name, conditional: frame.conditional,
        decorated: found.declaration.type === 'decorated_definition' };
      facts.functions.push(item);
      bind(scope, name.text, { kind: 'function', fn: item });
      bindParameters(bodyScope, node.childForFieldName('parameters'));
      for (const child of [...node.namedChildren].reverse()) {
        if (child.id === found.body.id) push(child, { scope: bodyScope, fn: item, conditional: false, calls: true });
        else push(child, { calls: false });
      }
      continue;
    }
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name');
      if (name) bind(scope, name.text, { kind: 'variable', node: name });
      const body = node.childForFieldName('body');
      const classScope = scopeOf('class', lexicalParent(scope), scope);
      for (const child of [...node.namedChildren].reverse()) {
        if (child.id === body?.id) push(child, { scope: classScope, fn: null, conditional: false, inClass: true });
        else push(child, { calls: false });
      }
      continue;
    }
    if (node.type === 'lambda') {
      const lambdaScope = scopeOf('lambda', lexicalParent(scope), scope);
      bindParameters(lambdaScope, node.childForFieldName('parameters'));
      for (const child of [...node.namedChildren].reverse()) {
        push(child, { scope: child.id === node.childForFieldName('body')?.id ? lambdaScope : scope, calls: false });
      }
      continue;
    }
    if (comprehensions.has(node.type)) {
      const comprehension = scopeOf('comprehension', lexicalParent(scope), scope, node.type === 'generator_expression');
      // Its first iterable is evaluated outside the comprehension's local names.
      const clauses = node.namedChildren.filter(child => child.type === 'for_in_clause');
      const first = clauses[0];
      for (const clause of clauses) bindPattern(comprehension, clause.childForFieldName('left'));
      for (const child of [...node.namedChildren].reverse()) {
        if (child.id !== first?.id) { push(child, { scope: comprehension }); continue; }
        for (const part of [...child.namedChildren].reverse()) {
          push(part, { scope: child.childrenForFieldName('right').some(right => right.id === part.id) ? scope : comprehension });
        }
      }
      continue;
    }
    if (node.type === 'assignment' || node.type === 'augmented_assignment') bindPattern(scope, node.childForFieldName('left'));
    if (node.type === 'named_expression') {
      let owner = scope;
      while (owner.kind === 'comprehension' && owner.parent) owner = owner.parent;
      bindPattern(owner, node.childForFieldName('name'));
    }
    if (node.type === 'delete_statement') for (const child of node.namedChildren) bindPattern(scope, child);
    if (node.type === 'for_statement') bindPattern(scope, node.childForFieldName('left'));
    if (node.type === 'as_pattern') bindPattern(scope, node.childForFieldName('alias'));
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      if (node.namedChildren.some(child => child.type === 'wildcard_import')) facts.unclear = '별표 import가 있어 이 파일의 이름을 확정하지 않았어요.';
      for (const entry of node.childrenForFieldName('name')) {
        const name = entry.childForFieldName('alias') ?? (entry.type === 'aliased_import' ? entry.childForFieldName('name') : entry);
        if (name) bind(scope, node.type === 'import_statement' && entry.type !== 'aliased_import' ? name.text.split('.')[0] : name.text, { kind: 'import', node: entry });
      }
    }
    if (node.type === 'call' && frame.calls) facts.calls.push({ node, scope, fn, inClass: frame.inClass });
    const conditional = frame.conditional || conditionalBlocks.has(node.type);
    for (const child of [...node.namedChildren].reverse()) push(child, { conditional, calls: node.type === 'decorated_definition' ? false : frame.calls });
  }
  return facts;
}

export type PythonResolution = { kind: 'linked'; fn: PythonFunctionFact }
  | { kind: 'unknown'; reason: CallUnknownReason; detail: string };
const unknown = (reason: CallUnknownReason, detail: string): PythonResolution => ({ kind: 'unknown', reason, detail });

export function resolvePythonCall(facts: PythonFileFacts, call: PythonCallFact): PythonResolution {
  if (!facts.complete) return unknown('incomplete', facts.incompleteReason ?? '파일을 끝까지 보지 못했어요.');
  if (facts.unclear) return unknown('unclear-file', facts.unclear);
  const callee = call.node.childForFieldName('function');
  if (callee?.type === 'attribute') return unknown('member', 'Python 속성으로 부르는 함수는 아직 따라가지 않아요.');
  if (callee?.type !== 'identifier') return unknown('expression', '직접 이름으로 부르는 함수만 따라가요.');
  const name = normalize(callee.text);
  if (call.inClass && (name === '__class__' || name.startsWith('__') && !name.endsWith('__'))) {
    return unknown('not-function', '클래스 안의 비공개 이름 변환과 __class__의 암묵적 연결은 아직 확정하지 않아요.');
  }
  let scope: PythonScope | null = call.scope;
  while (scope && !scope.names.has(name)) scope = scope.parent;
  const bindings = scope?.names.get(name);
  if (!bindings?.length) return unknown('undeclared', '이 파일에서 이름의 선언을 찾지 못했어요.');
  if (bindings.length !== 1) return unknown(bindings.some(item => item.kind === 'variable') ? 'reassigned' : 'duplicate', '같은 범위에 이름을 정하거나 바꾸는 곳이 여럿이에요.');
  const [binding] = bindings;
  if (binding.kind === 'import') return unknown('import-file', 'Python 파일 사이의 호출 연결은 아직 따라가지 않아요.');
  if (binding.kind !== 'function') return unknown('not-function', '가장 가까운 이름이 매개변수·대입·클래스 등으로 정해져 있어요.');
  if (binding.fn.conditional) return unknown('block-function', '조건·반복·오류 처리 안에서 정의되는 함수라 확정하지 않았어요.');
  if (binding.fn.decorated) return unknown('not-function', '데코레이터가 함수를 다른 값으로 바꿀 수 있어 확정하지 않았어요.');
  for (let execution: PythonScope | null = call.scope; execution; execution = execution.executionParent) {
    if (execution === scope && call.node.startIndex < binding.fn.declaration.startIndex) return unknown('not-function', '같은 실행 범위에서 함수 정의보다 먼저 부르고 있어요.');
    if (execution.deferred) break;
  }
  return { kind: 'linked', fn: binding.fn };
}
