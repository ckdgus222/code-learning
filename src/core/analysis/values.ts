import type Parser from 'tree-sitter';
import type { NameValue, ValueSite } from '../../shared/contracts';
import { firstLine, functionValues, lineRange, nearest, sameRange, type Declaration, type FileFacts, type VariableInfo } from './names';
import { functionName } from './syntax';

/*
 * Plan v2.3 V-1: for one function, the names it uses and what the code writes for them, each with its place.
 * Nothing is run or computed; an expression is shown as written.
 */

// A value written as it is. A template counts only without `${…}`.
const literals = new Set(['number', 'string', 'true', 'false', 'null']);
const isLiteral = (node: Parser.SyntaxNode) => literals.has(node.type)
  || (node.type === 'template_string' && !node.namedChildren.some(child => child.type === 'template_substitution'));
const unclearReason = '파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어 이름을 정할 수 없어요.';
const oddReason = '파일에 arguments나 undefined를 이름으로 선언하거나 대입한 곳이 있어 값을 정하지 않았어요.';
/** Why nothing in this file is worked out, or null. */
const fileReason = (facts: FileFacts) => facts.unclear ? unclearReason : facts.oddNames ? oddReason : !facts.complete ? facts.incompleteReason : null;

function where(facts: FileFacts, from: Parser.SyntaxNode, to: Parser.SyntaxNode = from): ValueSite {
  const text = from === to ? firstLine(from) : facts.text.slice(from.startIndex, to.endIndex).split('\n')[0];
  return { fileId: facts.file.id, fileHash: facts.hash, startUtf16: from.startIndex, endUtf16: to.endIndex,
    startLine: lineRange(from).startLine, endLine: lineRange(to).endLine, text };
}

/** How a followed import comes out: the exporting file and its export, a package, or why it cannot be followed. */
export type Followed = { facts: FileFacts } | { external: string } | { unknown: string };

/** The one declaration of this name in its scope that carries this info, or null when there are more. */
function declarationOf(info: VariableInfo, name: string): Declaration | null {
  const declared = info.scope.names.get(name) ?? [];
  return declared.length === 1 ? declared[0] : null;
}

/** Writes from where this very declaration is the nearest one; a same name declared inside is another. */
function writesTo(facts: FileFacts, name: string, declaration: Declaration | null) {
  return facts.assignments.filter(write => {
    if (write.name !== name || write.viaGlobal) return false;
    const found = nearest(write.scope, name);
    return found?.declared.length === 1 && found.declared[0] === declaration;
  });
}
/**
 * Whether a file-level name can be replaced through `window.x = …` in a plain script. Only a `var` or a function
 * declaration becomes a property of the global object; a `let` or `const` stays apart from it.
 */
const globallyWritten = (facts: FileFacts, name: string, declaration: Declaration) =>
  (declaration.kind === 'var' || (declaration.kind === 'function'
    && (declaration.fn.type === 'function_declaration' || declaration.fn.type === 'generator_function_declaration')))
  && !!facts.program.names.get(name)?.includes(declaration) && facts.assignments.some(write => write.viaGlobal && write.name === name);
/** A function's name given another value: by assignment, or (file-level) through a global object. */
const functionChanged = (facts: FileFacts, name: string, declaration: Declaration) =>
  writesTo(facts, name, declaration).length > 0 || globallyWritten(facts, name, declaration);
// A `let` that starts as a function is plan F's part unless something else is assigned to it later.
const letFunction = (info: VariableInfo) => info.role === 'let' && !!info.value && functionValues.has(info.value.type);

/**
 * A function's name given another value somewhere (`function source() {}` then `source = 42`): no longer
 * only plan F's, so it is shown with the function as its first value and the writes after it.
 */
function reassignedFunction(facts: FileFacts, declaration: Extract<Declaration, { kind: 'function' }>, name: string,
  group: NameValue['group'], chosen: Parser.SyntaxNode, argumentsOwners: Set<number>): NameValue {
  if (declaration.info) return describe(facts, declaration.info, name, group, chosen, argumentsOwners);
  const own = declaration.fn.childForFieldName('name');
  const base: NameValue = { group, name, role: 'function', shape: 'plain', declaredAt: where(facts, own ?? declaration.fn), type: null, fixed: null,
    initial: { ...where(facts, declaration.fn), kind: 'value' }, assignments: [], index: null, outerFunction: null, unknown: null, external: null, notes: [] };
  // Callers pass a declaration that is the only one of its name in its scope.
  const unknown = fileReason(facts) ?? declaration.clash ?? null;
  if (unknown) return { ...base, initial: null, unknown };
  const writes = writesTo(facts, name, declaration);
  if (writes.some(write => write.inNamespace)) return { ...base, initial: null, unknown: 'TS namespace 안에서 같은 이름에 대입한 곳이 있어 이 이름의 값을 정할 수 없어요.' };
  const notes = globallyWritten(facts, name, declaration) ? ['일반 스크립트에서는 window 같은 전역 객체로 다른 곳에서 바뀔 수 있어요.'] : [];
  return { ...base, notes, assignments: writes.sort((a, b) => a.node.startIndex - b.node.startIndex).map(write => where(facts, write.node)) };
}

/** Everything the code writes for a variable-like name, in the file that declares it. */
function describe(facts: FileFacts, info: VariableInfo, name: string, group: NameValue['group'], chosen: Parser.SyntaxNode,
  argumentsOwners: Set<number>): NameValue {
  const base: NameValue = { group, name, role: info.role === 'arguments' ? 'var' : info.role, shape: info.shape,
    declaredAt: info.node ? where(facts, info.node) : null, type: null, fixed: null, initial: null, assignments: [], index: null,
    outerFunction: null, unknown: null, external: null, notes: [] };
  const declaration = declarationOf(info, name);
  const unknown = fileReason(facts) ?? (!declaration ? '같은 이름이 한 범위에 여러 번 선언됐어요.' : info.clash);
  if (unknown) return { ...base, unknown };
  const owner = info.owner;
  if (info.role === 'parameter' && owner && !sameRange(owner, chosen)) {
    base.outerFunction = { name: functionName(owner), fileId: facts.file.id, fileHash: facts.hash, startUtf16: owner.startIndex,
      endUtf16: owner.endIndex, startLine: owner.startPosition.row + 1 };
  }
  if (info.role === 'parameter' && owner && sameRange(owner, chosen)) base.index = info.index;
  base.type = info.type?.text ?? null;
  const value = info.value;
  if (info.role === 'const' && info.shape === 'plain' && value && isLiteral(value)) base.fixed = value.text;
  else if (info.role === 'for' && info.source) {
    // A loop name, destructured or not, is shown with its loop head: `[k, v] of entries`.
    const left = info.source.childForFieldName('left');
    const right = info.source.childForFieldName('right');
    if (left && right) base.initial = { ...where(facts, left, right), kind: 'loop' };
  } else if (info.shape !== 'plain' && info.source) base.initial = { ...where(facts, info.source), kind: 'pattern' };
  else if (value) base.initial = { ...where(facts, value), kind: info.role === 'parameter' ? 'default' : 'value' };
  const writes = writesTo(facts, name, declaration);
  // In a TS namespace a write may be to the namespace's own name (`namespace N { x = 3 }` can be N.x),
  // which is not worked out (plan F), so this name's values are not settled either.
  if (writes.some(write => write.inNamespace)) return { ...base, unknown: 'TS namespace 안에서 같은 이름에 대입한 곳이 있어 이 이름의 값을 정할 수 없어요.' };
  base.assignments = writes.sort((a, b) => a.node.startIndex - b.node.startIndex).map(write => where(facts, write.node));
  if (declaration && globallyWritten(facts, name, declaration)) {
    base.notes.push('일반 스크립트에서는 window 같은 전역 객체로 다른 곳에서 바뀔 수 있어요.');
  }
  if (info.role === 'parameter' && owner && argumentsOwners.has(owner.startIndex)) {
    base.notes.push('이 함수에서 arguments를 써요. 엄격하지 않은 코드에서는 arguments[0] = … 으로 매개변수가 바뀔 수 있어요.');
  }
  return base;
}

/**
 * The chosen function's parameters, the names declared inside it, and the names it uses from outside it,
 * with what the code writes for each. Imports are followed through `follow`, which knows how to read files.
 */
export async function valuesOf(chosen: FileFacts, fn: Parser.SyntaxNode,
  follow: (specifier: string | null) => Promise<Followed>): Promise<NameValue[]> {
  const isChosen = (node: Parser.SyntaxNode | null) => !!node && sameRange(node, fn);
  // Functions whose own `arguments` is used, by start: an arrow function uses the one around it.
  const argumentsOwners = new Set<number>();
  for (const reference of chosen.references) {
    if (reference.node.text !== 'arguments') continue;
    const found = nearest(reference.scope, 'arguments')?.declared[0];
    // A file that declares `arguments` as a name itself is not worked out at all (`oddNames`).
    if (found?.kind === 'variable' && found.info?.role === 'arguments' && found.info.owner) argumentsOwners.add(found.info.owner.startIndex);
  }
  const values: NameValue[] = [];
  const seen = new Set<Declaration[]>();
  for (const info of chosen.variables) {
    if (!info.node || !isChosen(info.owner) || info.role === 'arguments') continue;
    const own = declarationOf(info, info.node.text);
    if (letFunction(info) && !(own && functionChanged(chosen, info.node.text, own))) continue;
    values.push(describe(chosen, info, info.node.text, info.role === 'parameter' ? 'parameter' : 'inside', fn, argumentsOwners));
  }
  // Function declarations made in it and given another value, even only from a function inside it.
  for (const made of chosen.functionDeclarations) {
    const declared = made.scope.names.get(made.name) ?? [];
    const [declaration] = declared;
    if (!isChosen(made.owner) || seen.has(declared)) continue;
    seen.add(declared);
    // A var of the same name is listed with the parameters and locals already, marked there.
    if (declared.some(item => (item.kind === 'variable' || item.kind === 'var') && item.info)) continue;
    if (declared.length > 1) {
      // Declared more than once (`function x() {} function x() {}`): listed once, not worked out.
      const at = declaration.kind === 'function' ? declaration.fn.childForFieldName('name') ?? declaration.fn : null;
      values.push({ group: 'inside', name: made.name, role: 'function', shape: 'plain', declaredAt: at ? where(chosen, at) : null, type: null,
        fixed: null, initial: null, assignments: [], index: null, outerFunction: null, unknown: '같은 이름이 한 범위에 여러 번 선언됐어요.', external: null, notes: [] });
      continue;
    }
    if (declaration.kind !== 'function') continue;
    if (functionChanged(chosen, made.name, declaration)) values.push(reassignedFunction(chosen, declaration, made.name, 'inside', fn, argumentsOwners));
  }

  // Names used in its own code (not in functions inside it) and declared outside it.
  // Declarations inside the chosen function are listed with it already, each marked when there are more.
  // Where a name is declared: a function by its own name where it has one (`function f`).
  const declaredAt = (item: Declaration) => item.kind === 'function' || item.kind === 'block-function'
    ? (item.kind === 'function' ? item.info?.node : null) ?? item.fn.childForFieldName('name') ?? item.fn
    : item.kind === 'variable' ? item.info?.node ?? item.at ?? null : item.kind === 'var' ? item.info?.node ?? null : null;
  const within = (item: Declaration) => {
    // The chosen function's own name is declared around it, not inside it.
    if (item.kind === 'function' && sameRange(item.fn, fn)) return false;
    const at = declaredAt(item);
    return !!at && at.startIndex >= fn.startIndex && at.endIndex <= fn.endIndex;
  };
  const notWorkedOut = (name: string, role: NameValue['role'], unknown: string, at: Parser.SyntaxNode | null = null) => values.push({
    group: at && within({ kind: 'variable', at }) ? 'inside' : 'outside', name, role, shape: 'plain', declaredAt: at ? where(chosen, at) : null,
    type: null, fixed: null, initial: null, assignments: [], index: null, outerFunction: null, unknown, external: null, notes: [] });
  const namespaceNames = new Set<string>();
  for (const reference of chosen.references) {
    // Calls count too: `cb()` uses the parameter cb. Only names of functions are left to plan F's lists (below).
    if (!isChosen(reference.fn)) continue;
    const name = reference.node.text;
    const found = nearest(reference.scope, name);
    // In a TS namespace a name may be declared in another block of the same namespace, so even one with no
    // declaration found is listed, once per name, as not worked out (plan F does not merge the blocks).
    if (reference.inNamespace && !found?.declared.some(within)) {
      if (!namespaceNames.has(name)) notWorkedOut(name, 'other', 'TS namespace·enum 안이라 이름을 정할 수 없어요.');
      namespaceNames.add(name);
      continue;
    }
    if (!found || seen.has(found.declared)) continue;
    // The name where a class or enum is declared is not a use of it.
    if (found.declared.some(item => declaredAt(item)?.startIndex === reference.node.startIndex)) continue;
    const [declaration] = found.declared;
    // A class or enum made inside it, or a function made inside it and given another value, has no list of its
    // own, so it is shown here, as made inside.
    const plainInside = found.declared.length === 1 && declaration.kind === 'variable' && !declaration.info && within(declaration);
    const functionInside = found.declared.length === 1 && declaration.kind === 'function' && !declaration.info && within(declaration);
    if (functionInside) {
      seen.add(found.declared);
      if (functionChanged(chosen, name, declaration)) values.push(reassignedFunction(chosen, declaration, name, 'inside', fn, argumentsOwners));
      continue;
    }
    // A function declared in a block may be another one outside strict mode (plan F), so it is not worked out.
    if (declaration.kind === 'block-function') {
      seen.add(found.declared);
      notWorkedOut(name, 'function', '블록 안 함수 선언이라 범위를 정할 수 없어요.', declaration.fn.childForFieldName('name') ?? declaration.fn);
      continue;
    }
    if (found.declared.some(within) && !plainInside) continue;
    seen.add(found.declared);
    // A name used is never dropped without a word: what cannot be worked out is listed with its reason.
    if (found.declared.length > 1) notWorkedOut(name, 'var', '같은 이름이 한 범위에 여러 번 선언됐어요.');
    else if (declaration.kind === 'import') {
      const imported = await importedValue(chosen, declaration, name, fn, follow);
      if (imported) values.push(imported);
    } else if (declaration.kind === 'function' && functionChanged(chosen, name, declaration)) {
      values.push(reassignedFunction(chosen, declaration, name, 'outside', fn, argumentsOwners));
    } else if (declaration.kind === 'variable' || declaration.kind === 'var') {
      if (!declaration.info) notWorkedOut(name, 'other', '클래스·enum·namespace·require 같은 선언이라 값을 따라가지 않아요.', declaredAt(declaration));
      else if (declaration.info.role !== 'arguments') values.push(describe(chosen, declaration.info, name, 'outside', fn, argumentsOwners));
    }
    // A function is what plan F's lists are for, so it is not repeated here.
  }
  return values;
}

/** An imported name, described where it is exported; null when it turns out to be a function (plan F's part). */
async function importedValue(chosen: FileFacts, declaration: Extract<Declaration, { kind: 'import' }>, name: string, fn: Parser.SyntaxNode,
  follow: (specifier: string | null) => Promise<Followed>): Promise<NameValue | null> {
  const base: NameValue = { group: 'outside', name, role: 'import', shape: 'plain', declaredAt: null, type: null, fixed: null, initial: null,
    assignments: [], index: null, outerFunction: null, unknown: null, external: null, notes: [] };
  // Unseen parts of the file could declare the name again or write to it.
  const chosenReason = fileReason(chosen);
  if (chosenReason) return { ...base, unknown: chosenReason };
  // Writing to an imported name fails when it runs, and the exporting file's value would not tell what is meant.
  if (writesTo(chosen, name, declaration).length) return { ...base, unknown: '가져온 이름에 대입하는 곳이 있어요(실행하면 오류가 나요).' };
  const followed = await follow(declaration.specifier);
  if ('external' in followed) return { ...base, external: followed.external };
  if (declaration.imported === '*') return { ...base, unknown: '이름공간 가져오기(* as)라 파일 전체를 가리켜요. 값을 하나로 따라가지 않아요.' };
  if ('unknown' in followed) return { ...base, unknown: followed.unknown };
  const { facts } = followed;
  const exportingReason = fileReason(facts);
  if (exportingReason) return { ...base, unknown: `가져온 파일에서: ${exportingReason}` };
  const entries = facts.exports.get(declaration.imported) ?? [];
  if (entries.length !== 1) {
    return { ...base, unknown: entries.length ? '같은 이름으로 내보낸 것이 여럿이에요.'
      : facts.reexported.has(declaration.imported) || facts.reexportsAll ? '다른 파일에서 다시 내보낸 이름은 따라가지 않아요.' : '그 이름으로 내보낸 것이 없어요.' };
  }
  const [entry] = entries;
  // `export default x` where x starts as a function: still that function only if x is never given another value
  // (plan F's part). With a write before or after, what is exported then is not worked out: the snapshot is shown.
  if (entry.fn && entry.snapshot) {
    const declared = entry.local ? facts.program.names.get(entry.local) ?? [] : [];
    if (declared.length === 1 && !writesTo(facts, entry.local!, declared[0]).length) return null;
  }
  if (entry.fn && !entry.snapshot) {
    // A function is plan F's part, unless its name is given another value in its file (as in the chosen file).
    const declared = entry.local ? facts.program.names.get(entry.local) ?? [] : [];
    const [exported] = declared;
    if (declared.length !== 1 || exported.kind !== 'function' || !functionChanged(facts, entry.local!, exported)) return null;
    return { ...reassignedFunction(facts, exported, entry.local!, 'outside', fn, new Set()), name, role: 'import' };
  }
  // `export default …` exports the value it has then: only that expression is shown, not later writes.
  if (entry.snapshot) {
    const snapshot = entry.snapshot;
    return { ...base, declaredAt: where(facts, snapshot), fixed: isLiteral(snapshot) ? snapshot.text : null,
      initial: isLiteral(snapshot) ? null : { ...where(facts, snapshot), kind: 'export' } };
  }
  const declared = entry.local ? facts.program.names.get(entry.local) ?? [] : [];
  const [exported] = declared;
  if (declared.length !== 1) return { ...base, unknown: '내보낸 쪽에 같은 이름의 선언이 여럿이거나 없어요.' };
  if (exported.kind === 'function' || exported.kind === 'block-function') return null;
  if ((exported.kind !== 'variable' && exported.kind !== 'var') || !exported.info) return { ...base, unknown: '내보낸 것을 값으로 정할 수 없어요.' };
  // A live export: the exporting file's declaration and its writes, as there.
  return { ...describe(facts, exported.info, entry.local!, 'outside', fn, new Set()), name, role: 'import' };
}
