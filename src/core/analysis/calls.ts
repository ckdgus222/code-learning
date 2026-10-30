import type Parser from 'tree-sitter';
import type { CallLink, CallSite, CallUnknownReason, FunctionCalls, ProjectFile } from '../../shared/contracts';
import { readPathAliases, resolveImport, type PathAliases } from './path-aliases';
import { AppError } from '../../shared/errors';
import { assertAllowedFile, MAX_FILE_BYTES, readAllowed } from '../project/files';
import { codeFile, type MapLimits } from './project-map';
import { functionName, functionTypes } from './syntax';
import { valuesOf } from './values';
import { calledProperty, firstLine, hasToken, isMemberCall, lineRange, nearest, propertyName, readFacts, reassigned, sameRange,
  type CallFact, type FileFacts, type Scope } from './names';

/*
 * Plan v2.3 F: which function a call by name leads to, read from the code only. A name is settled by its
 * nearest declaration, scope by scope outward from the call; whatever the rules cannot settle is reported
 * as unknown with its reason, never guessed.
 */

type Found =
  | { kind: 'linked'; facts: FileFacts; fn: Parser.SyntaxNode }
  | { kind: 'typed'; facts: FileFacts; fn: Parser.SyntaxNode; basis: string }
  | { kind: 'external'; specifier: string }
  | { kind: 'unknown'; reason: CallUnknownReason; detail: string | null };
const unknown = (reason: CallUnknownReason, detail: string | null = null): Found => ({ kind: 'unknown', reason, detail });


const namespaceTypes = new Set(['internal_module', 'module', 'enum_declaration']);
const memberName = (node: Parser.SyntaxNode) => propertyName(node.childForFieldName('name') ?? node.childForFieldName('property') ?? node.childForFieldName('pattern'));

/** Follow assignment wrappers/patterns, but not reads such as the object in `this.f.x = …`. */
function memberWrite(node: Parser.SyntaxNode): boolean {
  let part = node;
  for (let parent = part.parent; parent; parent = part.parent) {
    const fieldIsPart = (field: string) => { const child = parent.childForFieldName(field); return !!child && sameRange(child, part); };
    switch (parent.type) {
      case 'parenthesized_expression': case 'non_null_expression': case 'as_expression': case 'satisfies_expression':
      case 'type_assertion': case 'array_pattern': case 'object_pattern': case 'rest_pattern':
        part = parent; continue;
      case 'pair_pattern':
        if (!fieldIsPart('value')) return false;
        part = parent; continue;
      case 'assignment_pattern': case 'object_assignment_pattern':
        if (!fieldIsPart('left')) return false;
        part = parent; continue;
      case 'assignment_expression': case 'augmented_assignment_expression': case 'for_in_statement': return fieldIsPart('left');
      case 'update_expression': return true;
      case 'unary_expression': return hasToken(parent, 'delete');
      // In these expressions/statements the member supplies a value; it is not an assignment target.
      case 'call_expression': case 'new_expression': case 'arguments': case 'member_expression': case 'subscript_expression':
      case 'expression_statement': case 'return_statement': case 'throw_statement': case 'await_expression': case 'yield_expression':
      case 'binary_expression': case 'ternary_expression': case 'sequence_expression': case 'array': case 'pair':
      case 'spread_element': case 'template_substitution': case 'computed_property_name': case 'jsx_expression':
      case 'variable_declarator': case 'public_field_definition': case 'field_definition': case 'required_parameter': case 'optional_parameter':
      case 'if_statement': case 'while_statement': case 'do_statement': case 'for_statement': case 'switch_statement': case 'switch_case':
        return false;
      default: return true;
    }
  }
  return true;
}

interface ClassMembers { members: Parser.SyntaxNode[]; writes: Set<string>; blocked: string | null }
/** The one function exported by this name and not written to again in its file. */
function exportedFunction(facts: FileFacts, name: string): Found {
  if (facts.unclear) return unknown('export', '가져온 파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어요.');
  if (!facts.complete) return unknown('export', '가져온 파일을 끝까지 보지 못했어요.');
  const entries = facts.exports.get(name) ?? [];
  if (!entries.length) {
    return unknown('export', facts.reexported.has(name) || facts.reexportsAll
      ? '다른 파일에서 다시 내보낸 이름은 따라가지 않아요.' : '그 이름으로 내보낸 것이 없어요.');
  }
  if (entries.length > 1) return unknown('export', '같은 이름으로 내보낸 것이 여럿이에요.');
  const [{ fn, local }] = entries;
  if (!fn) return unknown('export', '내보낸 것을 함수로 정할 수 없어요.');
  if (local) {
    // The exported function must also be the only declaration of its name in the file.
    const declared = facts.program.names.get(local) ?? [];
    if (declared.length !== 1 || declared[0].kind !== 'function' || !sameRange(declared[0].fn, fn)) {
      return unknown('export', '내보낸 쪽에 같은 이름의 선언이 여럿이에요.');
    }
    if (reassigned(facts, local, facts.program)) return unknown('export', '내보낸 쪽에서 다시 대입돼요.');
  }
  return { kind: 'linked', facts, fn };
}

// Plan v2.3 V-1: arguments in test files are shown as examples.
const testFile = (relativePath: string) => /(^|\/)__tests__\//.test(relativePath) || /\.(test|spec)\.[^/]+$/.test(relativePath);
function site(call: CallFact, facts: FileFacts): CallSite {
  const list = call.node.childForFieldName('arguments');
  // A tagged template (tag`a ${b}`) passes its pieces of text first, so its arguments do not line up with these.
  const args = list?.type === 'arguments'
    ? list.namedChildren.filter(item => item.type !== 'comment').map(item => ({ text: firstLine(item), spread: item.type === 'spread_element' })) : null;
  return { fileId: facts.file.id, fileHash: facts.hash, startUtf16: call.node.startIndex, endUtf16: call.node.endIndex, ...lineRange(call.node),
    text: firstLine(call.node), args, inTest: testFile(facts.file.relativePath), inFunction: call.fn ? { name: functionName(call.fn), startUtf16: call.fn.startIndex, endUtf16: call.fn.endIndex,
      startLine: call.fn.startPosition.row + 1 } : null };
}

/** Names the chosen function is called by (plan v2.3 F, '고른 함수의 이름들'). */
function namesOf(fn: Parser.SyntaxNode, facts: FileFacts): FunctionCalls['names'] {
  const local: string[] = [];
  const property: string[] = [];
  const own = fn.childForFieldName('name');
  const parent = fn.parent;
  if (fn.type === 'function_declaration' || fn.type === 'generator_function_declaration') { if (own) local.push(own.text); }
  else if (own && fn.type !== 'method_definition') local.push(own.text);
  // A `var` function cannot be settled, but its calls are still listed as ones that could not be.
  if (parent?.type === 'variable_declarator' && parent.childForFieldName('name')?.type === 'identifier') local.push(parent.childForFieldName('name')!.text);
  const named = (node: Parser.SyntaxNode | null) => { const name = propertyName(node); if (name) property.push(name); };
  if (fn.type === 'method_definition') named(own);
  if (parent?.type === 'pair') named(parent.childForFieldName('key'));
  if (parent && ['public_field_definition', 'field_definition'].includes(parent.type)) {
    named(parent.childForFieldName('name') ?? parent.childForFieldName('property'));
  }
  const exported = [...facts.exports].filter(([, entries]) => entries.some(entry => entry.fn && sameRange(entry.fn, fn))).map(([name]) => name);
  return { local: [...new Set(local)], exported, property: [...new Set(property)] };
}

/** Kept only for one feature-flow job; successful reads and parsed trees can be reused. */
export interface CallsCache {
  texts: Map<string, { text: string; hash: string }>;
  parsed: Map<string, FileFacts>;
  /** Files parsed for the current flow, in first-use order, including cache hits. */
  parsedFiles?: Set<string>;
}

/**
 * What the chosen function calls, and the calls in the project that lead to it, from the files listed when
 * the folder was opened. Files are only read. Reads stay within the map's limits; a stop request is
 * checked between files, as ending the thread inside a parse would abort the app.
 */
export async function findFunctionCalls(root: string, projectId: string, files: ProjectFile[],
  target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number },
  limits: MapLimits, shouldStop: () => boolean = () => false, cache?: CallsCache, pathAliases?: PathAliases): Promise<FunctionCalls> {
  const chosenFile = files.find(file => file.id === target.fileId);
  if (!chosenFile) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 파일이 아닙니다.');
  const known = new Map(files.map(file => [file.relativePath, file]));
  const result = { limited: false, unexamined: new Map<string, { fileId: string; relativePath: string; reason: string }>() };
  const skip = (file: ProjectFile, reason: string) => {
    if (!result.unexamined.has(file.id)) result.unexamined.set(file.id, { fileId: file.id, relativePath: file.relativePath, reason });
  };
  let filesRead = 0;
  const aliases = pathAliases ?? await readPathAliases(root, files, limits.bytes, shouldStop);
  let bytesRead = aliases.bytesRead;
  const texts = new Map<string, Promise<{ text: string; hash: string } | null>>();
  const read = (file: ProjectFile) => {
    if (!texts.has(file.id)) texts.set(file.id, (async () => {
      const left = limits.bytes - bytesRead;
      if (filesRead >= limits.files || left <= 0) { result.limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null; }
      filesRead++;
      try {
        const source = cache?.texts.get(file.id) ?? await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
        if (Buffer.byteLength(source.text) > Math.min(MAX_FILE_BYTES, left)) throw new AppError('LIMIT', '읽기 한도에 닿았어요.');
        cache?.texts.set(file.id, source);
        bytesRead += Buffer.byteLength(source.text);
        return source;
      } catch (error) {
        if (error instanceof AppError && error.code === 'LIMIT' && left < MAX_FILE_BYTES) {
          result.limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null;
        }
        skip(file, error instanceof AppError ? error.message : '파일을 읽지 못했어요.');
        return null;
      }
    })());
    return texts.get(file.id)!;
  };
  const parsed = new Map<string, FileFacts>();
  const factsOf = (file: ProjectFile, source: { text: string; hash: string }) => {
    if (!parsed.has(file.id)) {
      // Ordinary calls keep only the chosen file's references. A flow reuses each file as a later target.
      const facts = cache?.parsed.get(file.id) ?? readFacts(file, source.text, source.hash, limits.nodesPerFile, !!cache || file.id === target.fileId);
      cache?.parsed.set(file.id, facts);
      cache?.parsedFiles?.add(file.id);
      if (facts.incompleteReason) skip(file, facts.incompleteReason);
      else if (facts.unclear) skip(file, '파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어 이 파일의 이름은 확정하지 않았어요.');
      parsed.set(file.id, facts);
    }
    return parsed.get(file.id)!;
  };
  // A target may have been deleted, excluded or swapped for a link since the folder was opened (as in the map).
  const availability = new Map<string, Promise<boolean>>();
  const available = (relative: string): Promise<boolean> => {
    if (!availability.has(relative)) availability.set(relative, assertAllowedFile(root, relative).then(() => true, () => false));
    return availability.get(relative)!;
  };

  /** The one code file an import leads to by the map's rules, or why there is none. */
  const importedFile = async (from: FileFacts, specifier: string | null): Promise<ProjectFile | Found> => {
    if (specifier === null) return unknown('import-file', '경로 글을 그대로 읽을 수 없어요.');
    if (specifier.startsWith('/')) return unknown('import-file', '프로젝트 밖을 가리켜요.');
    const resolved = resolveImport(from.file.relativePath, specifier, known, aliases);
    if (resolved.kind === 'external') return { kind: 'external', specifier };
    if (resolved.kind === 'outside') return unknown('import-file', '프로젝트 밖을 가리켜요.');
    if (!resolved.sure) return unknown('import-file', '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.');
    const named = resolved.candidates;
    const usable: string[] = [];
    for (const name of named) if (await available(name)) usable.push(name);
    if (usable.length !== 1) {
      return unknown('import-file', !named.length ? '파일을 찾지 못했어요.' : !usable.length ? '대상을 지금 확인할 수 없어요.' : `후보가 여럿이에요: ${usable.join(', ')}`);
    }
    const file = known.get(usable[0])!;
    return codeFile.test(file.relativePath) ? file : unknown('import-file', '코드 파일이 아니에요.');
  };
  const follow = async (from: FileFacts, specifier: string | null, imported: string): Promise<Found> => {
    const file = await importedFile(from, specifier);
    if ('kind' in file) return file;
    if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
    const source = await read(file);
    if (!source) return unknown('export', '가져온 파일을 읽지 못했어요.');
    return exportedFunction(factsOf(file, source), imported);
  };
  const classes = new Map<string, ClassMembers>();
  const membersOf = (owner: Parser.SyntaxNode, facts: FileFacts) => {
    const key = `${facts.file.id}:${owner.startIndex}`;
    const cached = classes.get(key);
    if (cached) return cached;
    const body = owner.childForFieldName('body');
    const members = (body?.namedChildren ?? []).filter(node => !['comment', 'method_signature', 'abstract_method_signature'].includes(node.type));
    const result: ClassMembers = { members, writes: new Set(), blocked: null };
    for (let node = owner.parent; node; node = node.parent) {
      if (namespaceTypes.has(node.type)) result.blocked = 'namespace 안의 클래스는 따라가지 않아요';
    }
    if (body?.namedChildren.some(node => node.childForFieldName('name')?.type === 'computed_property_name')) {
      result.blocked = '클래스에 계산된 이름의 멤버가 있어요';
    }
    const pending = body ? [body] : [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'class_body' && node !== body) continue;
      if (isMemberCall(node) && node.childForFieldName('object')?.type === 'this' && memberWrite(node)) {
        if (node.type === 'subscript_expression') result.blocked = 'this[…]에 쓰는 곳이 있어요';
        else { const name = calledProperty(node); if (name) result.writes.add(name); }
      }
      pending.push(...node.namedChildren);
    }
    // Constructor parameter properties are declarations of instance members too.
    for (const method of [...members]) if (method.type === 'method_definition' && memberName(method) === 'constructor') {
      for (const parameter of method.childForFieldName('parameters')?.namedChildren ?? []) {
        if (parameter.namedChildren.some(child => child.type === 'accessibility_modifier') || hasToken(parameter, 'readonly')) members.push(parameter);
      }
    }
    classes.set(key, result);
    return result;
  };
  const hiddenTypes = new Map<string, { declarations: Set<string>; parameters: Set<string> }>();
  const typeHidden = (facts: FileFacts, name: string, anchor: Parser.SyntaxNode, includeParameters = true) => {
    if (!hiddenTypes.has(facts.file.id)) {
      let root = anchor;
      while (root.parent) root = root.parent;
      const hidden = { declarations: new Set<string>(), parameters: new Set<string>() };
      const pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (['type_parameter', 'type_alias_declaration', 'interface_declaration', ...namespaceTypes].includes(node.type)) {
          const declared = node.childForFieldName('name');
          if (declared) (node.type === 'type_parameter' ? hidden.parameters : hidden.declarations).add(declared.text);
        }
        pending.push(...node.namedChildren);
      }
      hiddenTypes.set(facts.file.id, hidden);
    }
    const hidden = hiddenTypes.get(facts.file.id)!;
    return hidden.declarations.has(name) || includeParameters && hidden.parameters.has(name);
  };
  const methodOf = (owner: Parser.SyntaxNode, facts: FileFacts, name: string, basis: string): Found => {
    if (facts.unclear) return unknown('unclear-file');
    if (!facts.complete) return unknown('incomplete');
    const info = membersOf(owner, facts);
    if (info.blocked) return unknown('member', info.blocked);
    if (info.writes.has(name)) return unknown('member', `this.${name}에 다시 대입하거나 쓰는 곳이 있어요`);
    const members = info.members.filter(node => memberName(node) === name);
    if (!members.length) return unknown('member', '물려받은 메서드는 따라가지 않아요');
    if (members.length !== 1) return unknown('member', '같은 이름의 멤버 선언이 여럿이에요');
    const [method] = members;
    if (method.type !== 'method_definition' || ['static', 'get', 'set'].some(token => hasToken(method, token)) || !method.childForFieldName('body')) {
      return unknown('member', '본문 있는 인스턴스 메서드로 정할 수 없어요');
    }
    return { kind: 'typed', facts, fn: method, basis };
  };
  const resolveMember = async (call: CallFact, facts: FileFacts, callee: Parser.SyntaxNode): Promise<Found> => {
    const receiver = callee.childForFieldName('object');
    const method = callee.childForFieldName('property');
    if (callee.type !== 'member_expression' || !method || !receiver
      || (receiver.type !== 'this' && !(receiver.type === 'member_expression' && receiver.childForFieldName('object')?.type === 'this'))) {
      return unknown('member');
    }
    // Arrows keep `this`; fields, static blocks and non-method functions stop the search.
    let owner: Parser.SyntaxNode | null = null;
    for (let node = call.node.parent; node; node = node.parent) {
      if (['computed_property_name', 'decorator', 'class_heritage', 'class_body', 'class_static_block'].includes(node.type)) break;
      if (!functionTypes.has(node.type) || node.type === 'arrow_function') continue;
      if (node.type === 'method_definition' && !hasToken(node, 'static') && node.parent?.type === 'class_body') owner = node.parent.parent;
      break;
    }
    const className = owner?.childForFieldName('name');
    if (!owner || !className) return unknown('member', 'this가 가리키는 이름 있는 인스턴스 클래스를 정하지 못했어요');
    const info = membersOf(owner, facts);
    if (info.blocked) return unknown('member', info.blocked);
    if (receiver.type === 'this') return methodOf(owner, facts, method.text, `같은 클래스 ${className.text}의 메서드로 찾았어요`);
    const field = receiver.childForFieldName('property')!.text;
    if (info.writes.has(field)) return unknown('member', `this.${field}에 다시 대입하거나 쓰는 곳이 있어요`);
    const declarations = info.members.filter(node => memberName(node) === field);
    if (declarations.length !== 1) return unknown('member', `this.${field}의 선언을 하나로 정하지 못했어요`);
    const [declaration] = declarations;
    if (hasToken(declaration, 'static') || !['public_field_definition', 'field_definition', 'required_parameter', 'optional_parameter'].includes(declaration.type)) {
      return unknown('member', `this.${field}를 인스턴스 필드로 정하지 못했어요`);
    }
    const types = declaration.childForFieldName('type')?.namedChildren.filter(node => node.type !== 'comment') ?? [];
    if (types.length !== 1 || types[0].type !== 'type_identifier') return unknown('member', `this.${field}의 타입이 이름 하나로 적혀 있지 않아요`);
    const type = types[0].text;
    for (const decorator of declaration.namedChildren.filter(node => node.type === 'decorator')) {
      const expression = decorator.namedChildren[0];
      const args = expression?.childForFieldName('arguments')?.namedChildren.filter(node => node.type !== 'comment') ?? [];
      if (expression?.type !== 'call_expression' || expression.childForFieldName('function')?.text !== 'Inject'
        || args.length !== 1 || args[0].type !== 'identifier' || args[0].text !== type) {
        return unknown('member', '@Inject에 다른 값을 넣거나 다른 데코레이터를 써요');
      }
    }
    if (typeHidden(facts, type, owner)) return unknown('member', `${type} 이름을 가리는 타입 선언이 있어요`);
    // Look up the type where the field is declared, outside method parameters and nested functions.
    let scope: Scope | null = call.scope;
    while (scope && !(scope.names.get(className.text) ?? []).some(item => item.kind === 'variable' && item.at && sameRange(item.at, className))) scope = scope.parent;
    const found = scope && nearest(scope, type);
    if (!found || found.declared.length !== 1) return unknown('member', `${type}의 클래스 선언을 하나로 정하지 못했어요`);
    if (reassigned(facts, type, found.scope)) return unknown('member', `${type}에 다시 대입해요`);
    const [named] = found.declared;
    let targetFacts = facts;
    let targetClass: Parser.SyntaxNode | null = null;
    if (named.kind === 'variable') targetClass = named.at?.parent ?? null;
    else if (named.kind === 'import' && named.imported !== '*') {
      const file = await importedFile(facts, named.specifier);
      if ('kind' in file) return unknown('member', file.kind === 'unknown' ? file.detail : '외부 패키지의 클래스는 따라가지 않아요');
      if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
      const source = await read(file);
      if (!source) return unknown('member', '가져온 클래스 파일을 읽지 못했어요');
      targetFacts = factsOf(file, source);
      if (targetFacts.unclear) return unknown('unclear-file');
      if (!targetFacts.complete) return unknown('incomplete');
      const exports = targetFacts.exports.get(named.imported) ?? [];
      if (exports.length !== 1 || !exports[0].local) return unknown('member', '내보낸 클래스를 하나로 정하지 못했어요(다시 내보내기는 따라가지 않아요)');
      const local = exports[0].local;
      const declared = targetFacts.program.names.get(local) ?? [];
      if (declared.length !== 1 || declared[0].kind !== 'variable' || reassigned(targetFacts, local, targetFacts.program)) {
        return unknown('member', '내보낸 쪽 클래스 선언이 여럿이거나 다시 대입돼요');
      }
      targetClass = declared[0].at?.parent ?? null;
      if (targetClass && (typeHidden(targetFacts, local, targetClass, false) || typeHidden(targetFacts, named.imported, targetClass, false))) return unknown('member', `${local} 이름을 가리는 타입 선언이 있어요`);
    }
    if (!targetClass || !['class_declaration', 'abstract_class_declaration'].includes(targetClass.type) || !targetClass.childForFieldName('name')) {
      return unknown('member', `${type}를 이름 있는 클래스 선언으로 정하지 못했어요`);
    }
    return methodOf(targetClass, targetFacts, method.text, `this.${field}에 적힌 타입 ${type}로 찾았어요`);
  };
  const resolve = async (call: CallFact, facts: FileFacts): Promise<Found> => {
    const callee = call.node.childForFieldName('function')!;
    if (!isMemberCall(callee) && callee.type !== 'identifier') return unknown('expression');
    if (call.inNamespace) return unknown('namespace');
    if (facts.unclear) return unknown('unclear-file');
    if (!facts.complete) return unknown('incomplete');
    if (isMemberCall(callee)) return resolveMember(call, facts, callee);
    const found = nearest(call.scope, callee.text);
    if (!found) return unknown('undeclared');
    if (found.declared.length > 1) return unknown('duplicate');
    const [declaration] = found.declared;
    switch (declaration.kind) {
      case 'function': return reassigned(facts, callee.text, found.scope) ? unknown('reassigned') : { kind: 'linked', facts, fn: declaration.fn };
      // Writing to an imported name is an error, but the call then may not reach the import.
      // A namespace import (`* as ns`) is an object, not a function to call by its name.
      case 'import': return declaration.imported === '*' ? unknown('not-function')
        : reassigned(facts, callee.text, found.scope) ? unknown('reassigned') : follow(facts, declaration.specifier, declaration.imported);
      case 'var': return unknown('var');
      case 'block-function': return unknown('block-function');
      case 'variable': return unknown('not-function');
    }
  };
  const link = (call: CallFact, facts: FileFacts, found: Found): CallLink => {
    const at = site(call, facts);
    if (found.kind === 'external') return { ...at, status: 'external', specifier: found.specifier };
    if (found.kind === 'unknown') return { ...at, status: 'unknown', reason: found.reason, detail: found.detail };
    return { ...at, ...(found.kind === 'typed' ? { status: 'typed' as const, basis: found.basis } : { status: 'linked' as const }), target: { fileId: found.facts.file.id, fileHash: found.facts.hash, startUtf16: found.fn.startIndex,
      endUtf16: found.fn.endIndex, startLine: found.fn.startPosition.row + 1, name: functionName(found.fn) } };
  };

  // The chosen function, as it is now.
  const chosenSource = await read(chosenFile);
  if (!chosenSource) throw new AppError('IO', result.unexamined.get(chosenFile.id)?.reason ?? '파일을 읽지 못했어요.');
  if (chosenSource.hash !== target.fileHash) throw new AppError('CHANGED', '함수를 고른 뒤 파일이 바뀌었어요. 파일을 다시 읽어 주세요.');
  const chosen = factsOf(chosenFile, chosenSource);
  const fn = chosen.functions.find(item => item.startIndex === target.startUtf16 && item.endIndex === target.endUtf16);
  if (!fn) throw new AppError('CHANGED', '고른 함수를 지금 파일에서 찾지 못했어요. 파일을 다시 읽어 주세요.');
  const isChosen = (found: Found) => found.kind === 'linked' && found.facts.file.id === chosenFile.id && sameRange(found.fn, fn);

  const calls: CallLink[] = [];
  for (const call of chosen.calls) if (call.fn && sameRange(call.fn, fn)) calls.push(link(call, chosen, await resolve(call, chosen)));

  const names = namesOf(fn, chosen);
  const anyName = new Set([...names.local, ...names.exported.filter(name => name !== 'default'), ...names.property]);
  const callers: CallSite[] = [];
  const typedCallers: FunctionCalls['typedCallers'] = [];
  const maybeCallers: FunctionCalls['maybeCallers'] = [];
  const searched = names.local.length + names.exported.length + names.property.length > 0;
  if (searched) {
    const codeFiles = files.filter(file => codeFile.test(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const file of codeFiles) {
      if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
      const source = await read(file);
      // An import names the exported name even when it renames it; only a default import does not.
      // A file with escapes (`\u0073ave`) may name it without its letters; it is read and reported as not settled.
      if (!source || (!names.exported.includes('default') && !source.text.includes('\\u')
        && ![...anyName].some(name => source.text.includes(name)))) continue;
      const facts = factsOf(file, source);
      for (const call of facts.calls) {
        const callee = call.node.childForFieldName('function')!;
        if (isMemberCall(callee)) {
          const property = calledProperty(callee);
          if (property && anyName.has(property)) {
            const found = fn.type === 'method_definition' ? await resolve(call, facts) : unknown('member');
            if (found.kind === 'typed' && found.facts.file.id === chosenFile.id && sameRange(found.fn, fn)) {
              typedCallers.push({ ...site(call, facts), basis: found.basis });
            } else maybeCallers.push({ ...site(call, facts), reason: found.kind === 'unknown' ? found.reason : 'member',
              detail: found.kind === 'unknown' ? found.detail : '다른 클래스의 메서드로 찾았어요' });
          }
          continue;
        }
        if (callee.type !== 'identifier') continue;
        // Only calls that may reach the chosen function are settled: by its name in its own file, or by a
        // name imported from its file elsewhere. Imports of other files are not read for this.
        let mayReach = file.id === chosenFile.id && names.local.includes(callee.text);
        // Its own file may import it too, under another name (`import { f as other } from './a'` in a.ts).
        if (!mayReach && !call.inNamespace) {
          const found = nearest(call.scope, callee.text);
          const declaration = found?.declared.length === 1 ? found.declared[0] : null;
          if (declaration?.kind === 'import' && names.exported.includes(declaration.imported)) {
            const from = await importedFile(facts, declaration.specifier);
            mayReach = !('kind' in from) && from.id === chosenFile.id;
          }
        }
        if (!mayReach) continue;
        const found = await resolve(call, facts);
        if (isChosen(found)) callers.push(site(call, facts));
        else if (found.kind === 'unknown') maybeCallers.push({ ...site(call, facts), reason: found.reason, detail: found.detail });
      }
    }
  }

  // Plan v2.3 V-1: the names the chosen function uses, imports followed by the same rules as calls.
  const values = await valuesOf(chosen, fn, async specifier => {
    const file = await importedFile(chosen, specifier);
    if ('kind' in file) {
      return file.kind === 'external' ? { external: file.specifier } : { unknown: `가져온 파일을 정할 수 없어요: ${file.kind === 'unknown' ? file.detail : ''}` };
    }
    if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
    const source = await read(file);
    return source ? { facts: factsOf(file, source) } : { unknown: '가져온 파일을 읽지 못했어요.' };
  });

  const notes = result.limited ? [`부르는 곳은 파일 ${limits.files}개·합계 ${limits.bytes / 1024 / 1024} MiB까지만 찾아요. 나머지 파일은 보지 않았어요.`] : [];
  notes.push(...aliases.notes);
  return { projectId, fileId: chosenFile.id, fileHash: chosen.hash, startUtf16: fn.startIndex, endUtf16: fn.endIndex, name: functionName(fn),
    calls, callers: searched ? callers : null, typedCallers, maybeCallers, names, unexamined: [...result.unexamined.values()], values, limited: result.limited, notes };
}
