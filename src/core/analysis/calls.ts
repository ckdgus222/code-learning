import type Parser from 'tree-sitter';
import type { CallLink, CallSite, CallUnknownReason, FunctionCalls, ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { assertAllowedFile, MAX_FILE_BYTES, readAllowed } from '../project/files';
import { candidatesFor, codeFile, isRelative, type MapLimits } from './project-map';
import { functionName } from './syntax';
import { valuesOf } from './values';
import { calledProperty, firstLine, isMemberCall, lineRange, nearest, propertyName, readFacts, reassigned, sameRange,
  type CallFact, type FileFacts } from './names';

/*
 * Plan v2.3 F: which function a call by name leads to, read from the code only. A name is settled by its
 * nearest declaration, scope by scope outward from the call; whatever the rules cannot settle is reported
 * as unknown with its reason, never guessed.
 */

type Found =
  | { kind: 'linked'; facts: FileFacts; fn: Parser.SyntaxNode }
  | { kind: 'external'; specifier: string }
  | { kind: 'unknown'; reason: CallUnknownReason; detail: string | null };
const unknown = (reason: CallUnknownReason, detail: string | null = null): Found => ({ kind: 'unknown', reason, detail });


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

/**
 * What the chosen function calls, and the calls in the project that lead to it, from the files listed when
 * the folder was opened. Files are only read. Reads stay within the map's limits; a stop request is
 * checked between files, as ending the thread inside a parse would abort the app.
 */
export async function findFunctionCalls(root: string, projectId: string, files: ProjectFile[],
  target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number },
  limits: MapLimits, shouldStop: () => boolean = () => false): Promise<FunctionCalls> {
  const chosenFile = files.find(file => file.id === target.fileId);
  if (!chosenFile) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 파일이 아닙니다.');
  const known = new Map(files.map(file => [file.relativePath, file]));
  const result = { limited: false, unexamined: new Map<string, { fileId: string; relativePath: string; reason: string }>() };
  const skip = (file: ProjectFile, reason: string) => {
    if (!result.unexamined.has(file.id)) result.unexamined.set(file.id, { fileId: file.id, relativePath: file.relativePath, reason });
  };
  let filesRead = 0;
  let bytesRead = 0;
  const texts = new Map<string, Promise<{ text: string; hash: string } | null>>();
  const read = (file: ProjectFile) => {
    if (!texts.has(file.id)) texts.set(file.id, (async () => {
      const left = limits.bytes - bytesRead;
      if (filesRead >= limits.files || left <= 0) { result.limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null; }
      filesRead++;
      try {
        const source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
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
      // Only the chosen file's name references are kept (plan V-1); every file's would take much memory.
      const facts = readFacts(file, source.text, source.hash, limits.nodesPerFile, file.id === target.fileId);
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
    if (!isRelative(specifier)) return { kind: 'external', specifier };
    const named = candidatesFor(from.file.relativePath, specifier, known);
    if (named === null) return unknown('import-file', '프로젝트 밖을 가리켜요.');
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
  const resolve = async (call: CallFact, facts: FileFacts): Promise<Found> => {
    const callee = call.node.childForFieldName('function')!;
    if (isMemberCall(callee)) return unknown('member');
    if (callee.type !== 'identifier') return unknown('expression');
    if (call.inNamespace) return unknown('namespace');
    if (facts.unclear) return unknown('unclear-file');
    if (!facts.complete) return unknown('incomplete');
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
    return { ...at, status: 'linked', target: { fileId: found.facts.file.id, fileHash: found.facts.hash, startUtf16: found.fn.startIndex,
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
          if (property && anyName.has(property)) maybeCallers.push({ ...site(call, facts), reason: 'member', detail: null });
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
  return { projectId, fileId: chosenFile.id, fileHash: chosen.hash, startUtf16: fn.startIndex, endUtf16: fn.endIndex, name: functionName(fn),
    calls, callers: searched ? callers : null, maybeCallers, names, unexamined: [...result.unexamined.values()], values, limited: result.limited, notes };
}
