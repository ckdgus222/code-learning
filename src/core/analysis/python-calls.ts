import type { CallLink, CallSite, FunctionCalls, ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, readAllowed } from '../project/files';
import type { MapLimits } from './project-map';
import { firstLine, lineRange } from './names';
import { readPythonFacts, type PythonCallFact, type PythonFileFacts, type PythonFunctionFact } from './python-names';
import { pythonCallResolver } from './python-call-imports';

export interface PythonCallsCache {
  texts: Map<string, { text: string; hash: string }>;
  pythonParsed?: Map<string, PythonFileFacts>;
  parsedFiles?: Set<string>;
}

const pythonFile = /\.py$/i;
const testFile = (relative: string) => /(^|\/)(tests|__tests__)\//.test(relative) || /(^|\/)test_[^/]+\.py$/i.test(relative) || /_test\.py$/i.test(relative);
const functionAt = (fn: PythonFunctionFact) => ({ name: fn.displayName, startUtf16: fn.declaration.startIndex,
  endUtf16: fn.declaration.endIndex, startLine: fn.declaration.startPosition.row + 1 });

function site(call: PythonCallFact, facts: PythonFileFacts): CallSite {
  const argumentsNode = call.node.childForFieldName('arguments');
  const args = argumentsNode?.namedChildren.filter(node => node.type !== 'comment') ?? [];
  const positional = argumentsNode?.type === 'argument_list' && !args.some(node => ['keyword_argument', 'list_splat', 'dictionary_splat'].includes(node.type));
  return { fileId: facts.file.id, fileHash: facts.hash, startUtf16: call.node.startIndex, endUtf16: call.node.endIndex,
    ...lineRange(call.node), text: firstLine(call.node), args: positional ? args.map(node => ({ text: firstLine(node), spread: false })) : null,
    inTest: testFile(facts.file.relativePath), inFunction: call.fn ? functionAt(call.fn) : null };
}

/** Static Python names and unambiguous project imports, without running the project. */
export async function findPythonFunctionCalls(root: string, projectId: string, files: ProjectFile[],
  target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number }, limits: MapLimits,
  shouldStop: () => boolean = () => false, cache?: PythonCallsCache): Promise<FunctionCalls> {
  const chosenFile = files.find(file => file.id === target.fileId);
  if (!chosenFile) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 파일이 아닙니다.');
  const stop = () => { if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.'); };
  const unexamined = new Map<string, { fileId: string; relativePath: string; reason: string }>();
  const skip = (file: ProjectFile, reason: string) => unexamined.set(file.id, { fileId: file.id, relativePath: file.relativePath, reason });
  const parsed = new Map<string, PythonFileFacts | null>();
  let filesRead = 0, bytesRead = 0, resultSize = 0, limited = false;
  async function read(file: ProjectFile): Promise<PythonFileFacts | null> {
    stop();
    if (parsed.has(file.id)) return parsed.get(file.id)!;
    // Failed reads also belong to this snapshot and must not consume the budget again.
    parsed.set(file.id, null);
    const left = limits.bytes - bytesRead;
    if (filesRead >= limits.files || left <= 0) { limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null; }
    filesRead++;
    try {
      const source = cache?.texts.get(file.id) ?? await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
      stop();
      if (Buffer.byteLength(source.text) > Math.min(MAX_FILE_BYTES, left)) throw new AppError('LIMIT', '읽기 한도에 닿았어요.');
      bytesRead += Buffer.byteLength(source.text);
      cache?.texts.set(file.id, source);
      const cached = cache?.pythonParsed?.get(file.id);
      const facts = cached?.hash === source.hash ? cached : readPythonFacts(file, source.text, source.hash, limits.nodesPerFile);
      if (cache) { cache.pythonParsed ??= new Map(); cache.pythonParsed.set(file.id, facts); cache.parsedFiles?.add(file.id); }
      parsed.set(file.id, facts);
      if (facts.incompleteReason) skip(file, facts.incompleteReason);
      else if (facts.unclear) skip(file, facts.unclear);
      return facts;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CANCELLED') throw error;
      if (error instanceof AppError && error.code === 'LIMIT') limited = true;
      skip(file, error instanceof AppError ? error.message : '파일을 읽지 못했어요.');
      return null;
    }
  }
  function keep<T>(rows: T[], row: T): void {
    const size = JSON.stringify(row).length;
    if (resultSize + size > limits.results) { limited = true; return; }
    resultSize += size;
    rows.push(row);
  }

  const chosen = await read(chosenFile);
  if (!chosen) throw new AppError('IO', unexamined.get(chosenFile.id)?.reason ?? '파일을 읽지 못했어요.');
  if (chosen.hash !== target.fileHash) throw new AppError('CHANGED', '함수를 고른 뒤 파일이 바뀌었어요. 파일을 다시 읽어 주세요.');
  const fn = chosen.functions.find(item => item.declaration.startIndex === target.startUtf16 && item.declaration.endIndex === target.endUtf16);
  if (!fn) throw new AppError('CHANGED', '고른 함수를 지금 파일에서 찾지 못했어요. 파일을 다시 읽어 주세요.');
  const calls: CallLink[] = [], callers: CallSite[] = [];
  const maybeCallers: FunctionCalls['maybeCallers'] = [];
  for (const file of files.filter(file => pythonFile.test(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) await read(file);
  const resolver = pythonCallResolver(files, parsed, stop);
  for (const call of chosen.calls) {
    if (call.fn !== fn) continue;
    stop();
    const found = resolver.resolve(chosen, call);
    keep(calls, found.kind === 'linked' ? { ...site(call, chosen), status: 'linked', target: { fileId: found.facts.file.id, fileHash: found.facts.hash, ...functionAt(found.fn) } }
      : found.kind === 'external' ? { ...site(call, chosen), status: 'external', specifier: found.specifier }
      : { ...site(call, chosen), status: 'unknown', reason: found.reason, detail: found.detail });
  }
  for (const file of files.filter(file => pythonFile.test(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const facts = await read(file);
    if (!facts) continue;
    for (const call of facts.calls) {
      stop();
      const found = resolver.resolve(facts, call);
      if (found.kind === 'linked' && found.facts === chosen && found.fn === fn) keep(callers, site(call, facts));
      if (found.kind === 'unknown' && resolver.mayName(facts, call, chosen, fn.normalizedName)) {
        keep(maybeCallers, { ...site(call, facts), reason: found.reason, detail: found.detail });
      }
    }
  }
  stop();
  const notes = ['Python은 직접 이름과 경로가 하나로 정해진 import의 함수를 따라가요. 객체 메서드·다시 가져온 이름·람다 안·함수 정의 헤더의 호출과 값 추적은 아직 지원하지 않아요.'];
  if (limited) notes.push('파일·읽기 크기·결과 크기 한도에 닿아 일부 호출은 보이지 않아요.');
  return { projectId, fileId: chosenFile.id, fileHash: chosen.hash, startUtf16: fn.declaration.startIndex,
    endUtf16: fn.declaration.endIndex, name: fn.displayName, calls, callers, typedCallers: [], maybeCallers,
    names: { local: [fn.displayName], exported: [], property: [] }, values: [], limited, unexamined: [...unexamined.values()], notes };
}
