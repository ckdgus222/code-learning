import path from 'node:path';
import type Parser from 'tree-sitter';
import type { CallUnknownReason, ProjectFile } from '../../shared/contracts';
import { normalize, resolvePythonImport, type PythonTarget } from './python-imports';
import { resolvePythonCall, resolvePythonName, type PythonCallFact, type PythonFileFacts, type PythonFunctionFact,
  type PythonImportBinding, type PythonScope } from './python-names';

type Found = { kind: 'linked'; facts: PythonFileFacts; fn: PythonFunctionFact }
  | { kind: 'external'; specifier: string }
  | { kind: 'unknown'; reason: CallUnknownReason; detail: string };
const unknown = (reason: CallUnknownReason, detail: string): Extract<Found, { kind: 'unknown' }> => ({ kind: 'unknown', reason, detail });

/** Only literal name/attribute chains, never subscripts, calls or computed attributes. */
export function pythonAttributeNames(node: Parser.SyntaxNode | null): string[] | null {
  const names: string[] = [];
  while (node?.type === 'attribute') {
    const name = node.childForFieldName('attribute');
    if (name?.type !== 'identifier') return null;
    names.unshift(normalize(name.text));
    node = node.childForFieldName('object');
  }
  return node?.type === 'identifier' ? [normalize(node.text), ...names] : null;
}

const nearest = (scope: PythonScope | null, name: string) => {
  while (scope && !scope.names.has(name)) scope = scope.parent;
  return scope?.names.get(name) ?? [];
};

/** One bounded call-search job; import and mutation results never outlive its file snapshot. */
export function pythonCallResolver(files: ProjectFile[], parsed: ReadonlyMap<string, PythonFileFacts | null>, stop: () => void) {
  const known = new Set(files.map(file => file.relativePath));
  const byPath = new Map([...parsed.values()].flatMap(facts => facts ? [[facts.file.relativePath, facts] as const] : []));
  const imports = new Map<PythonImportBinding, PythonTarget[]>();
  const imported = (facts: PythonFileFacts, binding: PythonImportBinding) => {
    let result = imports.get(binding);
    if (result) return result;
    stop();
    result = resolvePythonImport(facts.file.relativePath, binding.item, known, {
      init: file => byPath.get(file)?.initNames ?? null,
      plain: file => byPath.get(file)?.importsPlain ?? false,
    });
    imports.set(binding, result);
    return result;
  };
  // Resolve writes by their module target, so another alias cannot hide a mutation.
  const changed = new Set<string>();
  const escaped = new Set<string>();
  const mark = (paths: Set<string>, file: string) => {
    if (paths.has(file)) return;
    paths.add(file);
    if (!file.endsWith('/__init__.py') && file !== '__init__.py') return;
    const prefix = file.slice(0, -'__init__.py'.length);
    for (const candidate of known) { stop(); if (candidate.startsWith(prefix)) paths.add(candidate); }
  };
  const markImport = (paths: Set<string>, facts: PythonFileFacts, binding: PythonImportBinding) => {
    const candidates = imported(facts, binding).flatMap(target => target.kind === 'file' ? [target.relativePath]
      : target.kind === 'unresolved' ? target.candidates : []);
    for (const candidate of candidates) mark(paths, candidate);
  };
  const markWrite = (facts: PythonFileFacts, write: PythonFileFacts['attributeWrites'][number]) => {
    stop();
    const names = pythonAttributeNames(write.node);
    if (!names) return;
    const suffix = names.slice(1);
    for (const binding of nearest(write.scope, names[0])) {
      if (binding.kind !== 'import') continue;
      if (!binding.prefix.every((part, index) => suffix[index] === undefined || suffix[index] === part)) continue;
      markImport(changed, facts, binding);
    }
  };
  const markEscape = (facts: PythonFileFacts, reference: PythonFileFacts['moduleEscapes'][number]) => {
    stop();
    for (const binding of nearest(reference.scope, normalize(reference.node.text))) {
      if (binding.kind === 'import') markImport(escaped, facts, binding);
    }
  };
  for (const facts of byPath.values()) {
    facts.attributeWrites.forEach(write => markWrite(facts, write));
    facts.moduleEscapes.forEach(reference => markEscape(facts, reference));
  }
  const mutation = (file: string) => changed.has(file)
    ? unknown('reassigned', '이 모듈이나 부모 패키지의 속성에 대입·삭제하는 곳이 있어 다른 별칭의 호출도 확정하지 않았어요.')
    : escaped.has(file) ? unknown('unclear-file', '모듈이나 가져온 함수가 다른 이름·코드로 전달되어 속성 변경 여부를 정하지 못했어요.') : null;
  const initializerClash = (file: string) => {
    const parts = file.replace(/\/__init__\.py$/, '').replace(/\.py$/, '').split('/');
    for (let index = 1; index < parts.length; index++) {
      const init = path.posix.join(...parts.slice(0, index), '__init__.py');
      if (known.has(init) && (!byPath.get(init)?.initNames || byPath.get(init)!.initNames!.has(parts[index]))) return true;
    }
    return false;
  };

  function resolve(facts: PythonFileFacts, call: PythonCallFact): Found {
    stop();
    const names = pythonAttributeNames(call.node.childForFieldName('function'));
    if (!names) return unknown('expression', '직접 이름이나 import한 모듈의 함수만 따라가요.');
    if (call.inClass && names.some(name => name.startsWith('__') && !name.endsWith('__'))) {
      return unknown('member', '클래스 안의 비공개 이름 변환이 있는 호출은 확정하지 않아요.');
    }
    const found = resolvePythonName(facts, call, names[0]);
    if (found.kind === 'unknown') return found;
    if (found.binding.kind !== 'import') {
      if (names.length > 1) return unknown('member', 'import한 모듈이 아닌 객체의 속성 호출은 아직 따라가지 않아요.');
      const local = resolvePythonCall(facts, call);
      if (local.kind === 'unknown') return local;
      const modified = mutation(facts.file.relativePath);
      if (modified) return modified;
      return { ...local, facts };
    }
    const binding = found.binding;
    if (binding.privateName) return unknown('import-file', '클래스 안에서 비공개 이름을 import해 이름 변환 여부를 확정하지 않았어요.');
    const targets = imported(facts, binding);
    if (targets.length !== 1) return unknown('import-file', '가져오는 이름의 파일을 하나로 정하지 못했어요.');
    const [target] = targets;
    if (target.kind === 'external') return { kind: 'external', specifier: target.specifier };
    if (target.kind === 'unresolved') return unknown('import-file', target.reasonText ?? '가져오는 경로가 없거나 파일·패키지 후보가 여럿이에요.');
    const suffix = names.slice(1);
    const module = binding.imported === null || target.names === 'all';
    const prefix = binding.prefix;
    if (module && (suffix.length !== prefix.length + 1 || !prefix.every((part, index) => suffix[index] === part))) {
      return unknown('member', 'import한 모듈 바로 아래의 함수 이름을 하나로 정하지 못했어요.');
    }
    if (!module && suffix.length) return unknown('member', '가져온 값의 속성 호출은 아직 따라가지 않아요.');
    const modified = mutation(target.relativePath);
    if (modified) return modified;
    if (initializerClash(target.relativePath)) return unknown('import-file', '부모 패키지의 초기화 코드가 하위 모듈 이름을 바꿀 수 있어 확정하지 않았어요.');
    const destination = byPath.get(target.relativePath);
    if (!destination?.complete || !destination.importsPlain) return unknown('export', '가져온 파일을 끝까지 읽지 못했거나 동적인 이름 규칙이 있어요.');
    const name = module ? suffix.at(-1)! : binding.imported!;
    const bindings = destination.program.names.get(name) ?? [];
    if (bindings.length !== 1) return unknown('export', '가져온 파일에서 그 이름을 한 번 정의한 함수로 정하지 못했어요.');
    const [entry] = bindings;
    if (entry.kind === 'import') return unknown('export', '다른 파일에서 다시 가져온 이름은 아직 따라가지 않아요.');
    if (entry.kind !== 'function') return unknown('export', '가져온 이름이 파일 맨 위에서 정의된 함수가 아니에요.');
    if (entry.fn.conditional || entry.fn.decorated) return unknown('export', '조건부 정의나 데코레이터가 있는 가져온 함수는 확정하지 않았어요.');
    return { kind: 'linked', facts: destination, fn: entry.fn };
  }
  function mayName(facts: PythonFileFacts, call: PythonCallFact, destination: PythonFileFacts, name: string): boolean {
    const names = pythonAttributeNames(call.node.childForFieldName('function'));
    if (!names) return false;
    if (names.at(-1) === name) return true;
    if (names.length !== 1) return false;
    return nearest(call.scope, names[0]).some(binding => binding.kind === 'import' && binding.imported === name
      && imported(facts, binding).some(target => target.kind === 'file' ? target.relativePath === destination.file.relativePath
        : target.kind === 'unresolved' && (!target.candidates.length || target.candidates.includes(destination.file.relativePath))));
  }
  return { resolve, mayName };
}
