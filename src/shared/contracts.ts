import { z } from 'zod';
import type { SourceLanguage } from './languages';
import type { PlanCompareCheck, PlanCompareRequest, PlanCompareResult, SavePlanCompare, PlanDocument } from './plan-compare';
import type { CheckConnectionsRequest, ConnectionReport, ExplainRequest, LearningEvent, OverviewRequest, FileExplanationRequest, FeatureGuideRequest, FeatureGuideResult, FileChunk, FileExplanationRange, FileExplanationResult, OverviewResult, LearningResult } from './ai';

/** The most characters one exported document may have. */
export const MAP_EXPORT_MAX = 2_000_000;
/** The folder scan's warning when it stopped at its limits: the one warning that means files are missing. */
export const SCAN_LIMIT_WARNING = '초기 탐색 제한(파일 1,000개·항목 5,000개·깊이 20)에 도달했습니다. 더 작은 폴더를 선택해 주세요.';
export interface MapExportRequest { projectId: string; text: string; to: 'file' | 'clipboard' }
/** Only the file name, never its folder; null for clipboard or cancellation. */
export interface MapExportResult { done: boolean; name: string | null }

export const MAX_FILE_BYTES = 256 * 1024;
export const viewSettingsSchema = z.object({
  screen: z.enum(['system', 'light', 'dark']),
  codeColors: z.enum(['default', 'contrast']),
}).strict();
export type ViewSettings = z.infer<typeof viewSettingsSchema>;
export type UpdateCheck = { current: string; latest: string | null; status: 'newer' | 'latest' | 'none' };
export const defaultViewSettings: ViewSettings = { screen: 'system', codeColors: 'default' };
export const idSchema = z.string().uuid();
export const mapExportRequestSchema = z.object({ projectId: idSchema, text: z.string().min(1).max(MAP_EXPORT_MAX), to: z.enum(['file', 'clipboard']) }).strict();
export const sourceRequestSchema = z.object({ projectId: idSchema, fileId: idSchema }).strict();
export const evidenceRequestSchema = z.object({ projectId: idSchema, evidenceId: idSchema }).strict();
export const projectRequestSchema = z.object({ projectId: idSchema }).strict();
const utf16 = z.number().int().min(0).max(100_000_000);
const line = z.number().int().min(1).max(10_000_000);
const relativePath = z.string().min(1).max(1024);
const text = z.string().min(1).max(1024);
const fileHash = z.string().regex(/^[a-f0-9]{64}$/);
/** A function's file, normalized analyzer name and zero-based occurrence among functions of that name. */
export const markKeySchema = z.object({ relativePath, name: text, occurrence: z.number().int().min(0).max(100_000) }).strict();
export type MarkKey = z.infer<typeof markKeySchema>;
export const LEARNING_NOTE_LIMIT = 500;
export const learningMarkSchema = markKeySchema.extend({
  state: z.enum(['understood', 'review']).nullable(), note: z.string().max(LEARNING_NOTE_LIMIT), codeHash: fileHash,
}).strict();
export type LearningMark = z.infer<typeof learningMarkSchema> & { savedAt: string };
export const storedLearningMarkSchema = learningMarkSchema.extend({ savedAt: z.string().min(1).max(64) }).strict();
export const saveLearningMarkSchema = z.object({ projectId: idSchema, mark: learningMarkSchema }).strict();
export const learningSpotSchema = z.object({
  version: z.literal(1),
  topic: z.object({
    name: z.string().max(1024), original: text, origin: z.enum(['ai', 'start', 'function']),
    start: z.object({ relativePath, fileHash, functionName: text.nullable(), startUtf16: utf16.nullable() }).strict(),
  }).strict(),
  place: z.object({
    view: z.enum(['function', 'code']), relativePath, fileHash,
    symbol: z.object({ name: text, startUtf16: utf16, step: z.number().int().min(0).max(100_000).nullable() }).strict().nullable(),
    range: z.object({ startUtf16: utf16, endUtf16: utf16, startLine: line, endLine: line }).strict()
      .refine(range => range.startUtf16 <= range.endUtf16 && range.startLine <= range.endLine).nullable(),
  }).strict().nullable(),
}).strict();
export type LearningSpot = z.infer<typeof learningSpotSchema>;
export interface SavedSpot { spot: LearningSpot; savedAt: string }
export interface RecentProject { id: string; name: string; root: string; openedAt: string }
export const saveLearningSpotSchema = z.object({ projectId: idSchema, spot: learningSpotSchema.nullable() }).strict();
export const featureFlowsRequestSchema = projectRequestSchema.extend({ routesId: idSchema }).strict();
export const featureFlowRequestSchema = projectRequestSchema.extend({ routesId: idSchema, routeIndex: z.number().int().min(0) }).strict();
/** A function as the analyzer listed it: its file, the hash the file had and the function's range. */
export const callsRequestSchema = z.object({ projectId: idSchema, fileId: idSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  startUtf16: z.number().int().min(0), endUtf16: z.number().int().min(0) }).strict();
/**
 * The same function and the names to find the shapes of (plan v2.3 V-2). `at` is where a name of the chosen file
 * is declared; null for an import, found by its name. `expect` is where V-1 followed an import to.
 */
export const SHAPE_QUERY_LIMITS = { names: 500, nameLength: 200 } as const;
export const shapesRequestSchema = callsRequestSchema.extend({
  names: z.array(z.object({ name: z.string().min(1).max(SHAPE_QUERY_LIMITS.nameLength), at: z.number().int().min(0).nullable(),
    expect: z.object({ fileId: idSchema, startUtf16: z.number().int().min(0) }).strict().nullable() }).strict()).max(SHAPE_QUERY_LIMITS.names),
}).strict();
export type ShapeQuery = z.infer<typeof shapesRequestSchema>['names'][number];
/** A commit chosen to compare with (plan v2.3 C-2): its full object number, SHA-1 or SHA-256. */
export const changesRequestSchema = projectRequestSchema.extend({ commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict();
/** One change to show: the old path in that commit (none for a new file) and the file now (none for a deleted one). */
export const diffRequestSchema = changesRequestSchema.extend({ oldPath: z.string().min(1).max(1024).nullable(), fileId: idSchema.nullable() }).strict();

// Offsets refer to the unchanged decoded source: UTF-16, start inclusive/end exclusive.
export interface Evidence {
  id: string;
  projectId: string;
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
}

export interface CodeStep {
  id: string;
  title: string;
  kind: string;
  depth: number;
  evidence: Evidence;
  /** Source text the step decides on or hands back, such as an if condition or a returned value. */
  detail?: string;
  /** If statements only: the step reached when the condition is true or false, inside the same function. */
  branch?: { whenTrue: string | null; whenFalse: string | null };
}

/**
 * Plan v2.3 C-1 (D2): a function body with more code lines, or deeper nesting, than this is marked as a
 * place to look. It is not a verdict on the code. The user adjusts the values after trying them.
 */
export const COMPLEXITY_LIMITS = { lines: 60, depth: 4 } as const;

export interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  /** Parameter list as written, or '' when the function takes none. */
  params: string;
  /** Exported where it is declared; `export { name }` lists are not followed. */
  exported: boolean;
  evidence: Evidence;
  steps: CodeStep[];
  /** Code lines and deepest if/loop/switch/try nesting of its own body, nested functions left out (syntax.ts). */
  complexity: { lines: number; depth: number };
}

/** Said for every TS/JS file; the file guide leaves it out of its warnings, which are kept for real limits. */
export const STRUCTURE_NOTE = '코드에 적힌 구문 구조입니다. 실제 실행 순서와 호출 대상은 확인하지 않았습니다.';

/** A class a file declares. Collected for Python only so far (roadmap L2a-2). */
export interface CodeClass {
  /** `Outer.Inner` for a class declared directly in another class's body, otherwise its own name. */
  name: string;
  /** The parenthesised base list as written (`(BaseModel)`), cut short like step details; '' when there is none. */
  bases: string;
  evidence: Evidence;
}

export interface Analysis {
  language: SourceLanguage;
  symbols: CodeSymbol[];
  imports: { text: string; evidence: Evidence }[];
  /** Absent for languages whose classes are not listed (TypeScript, JavaScript, plain text). */
  classes?: CodeClass[];
  warnings: string[];
}

export interface ProjectFile { id: string; relativePath: string; size: number }
export interface ProjectFiles {
  id: string;
  name: string;
  files: ProjectFile[];
  excluded: Record<string, number>;
  warnings: string[];
}
/** A README's own words, shown as plain text. Whether they match the code is not checked. */
export interface ProjectIntro {
  fileId: string;
  relativePath: string;
  title: string | null;
  text: string | null;
  startLine: number | null;
  endLine: number | null;
}
/**
 * A place to start reading, chosen from code structure when the project was opened. It is not
 * an Evidence ID: the screen re-reads the file and uses it only if the hash is unchanged.
 */
export interface StartCandidate {
  fileId: string;
  relativePath: string;
  /** null when the file itself is the candidate (an entry file that exports nothing). */
  name: string | null;
  reason: 'package-main' | 'package-bin' | 'entry-name' | 'exported';
  fileHash: string;
  startUtf16: number;
  startLine: number;
}
export interface ProjectOverview {
  intro: ProjectIntro | null;
  candidates: StartCandidate[];
  entryFileIds: string[];
  /** TS/JS files actually read for candidates; `limited` when more existed than were checked. */
  checkedFiles: number;
  limited: boolean;
  notes: string[];
}
export interface ProjectView extends ProjectFiles {
  overview: ProjectOverview;
}
export type GuideRange = FileExplanationRange;
export interface GuideImport {
  /** The written path; null when it is not plain text. */
  specifier: string | null;
  line: number;
  /** Set only when exactly one project file fits. */
  target: { fileId: string; relativePath: string } | null;
  status: 'project' | 'ambiguous' | 'not-found' | 'outside' | 'not-static' | 'unreadable' | 'syntax';
}
/** Facts matched to an analyzer symbol's exact syntax range. */
export interface GuideFunction extends Pick<FlowNode, 'stops' | 'stopsOmitted' | 'stores' | 'storesOmitted'> {
  symbolId: string;
  tags: string[];
  calls: string[];
  callsOmitted: number;
  hooks: string[];
  hooksOmitted: number;
  routeNote: string | null;
}
export interface FileGuide {
  role: { label: string; about: string; basis: { text: string; range: GuideRange | null } };
  notes: string[];
  exports: string[];
  exportsOmitted: number;
  imports: GuideImport[];
  importsOmitted: number;
  external: string[];
  externalOmitted: number;
  functions: GuideFunction[];
  chunks: { chunk: FileChunk; about: string; symbolId: string | null }[];
  limitations: string[];
}

export interface SourceView {
  projectId: string;
  fileId: string;
  relativePath: string;
  hash: string;
  text: string;
  analysis: Analysis;
  guide: FileGuide | null;
}

/**
 * One import found while drawing the project map. Like StartCandidate it is not an Evidence ID: the
 * screen re-reads the importing file and highlights the range only while its hash is unchanged.
 */
export interface MapImport {
  fromFileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
  text: string;
  specifier: string | null;
}
/** An import whose target file is not there, with the project paths it is looked for at. */
export interface MissingImport extends MapImport { names: string[] }

export interface MapFile {
  id: string;
  relativePath: string;
  /** The folder the file sits in ('' for the project root); the design view groups by it. */
  folder: string;
  start: boolean;
  entry: boolean;
  /** How far this file was examined: full, partly, not readable, skipped by the map's limits, or not code. */
  checked: 'full' | 'partial' | 'failed' | 'skipped' | 'not-code';
  reason: string | null;
}
/** A function over a `COMPLEXITY_LIMITS` value, found while drawing the map; like MapImport it is re-read before use. */
export interface MapFunction {
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
  name: string;
  lines: number;
  depth: number;
}
/** A named function or class in a file the map read. Like MapFunction it is re-read before use. */
export interface MapSymbol {
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
  name: string;
  kind: 'function' | 'class';
}
export type MapUnresolvedReason = 'not-found' | 'ambiguous' | 'outside' | 'not-static' | 'syntax' | 'unavailable' | 'unreadable';
export type UnusedExcludeKind = 'start' | 'test' | 'config' | 'types' | 'framework' | 'script' | 'reference';
export interface MapExport extends Pick<MapFunction, 'fileId' | 'fileHash' | 'startUtf16' | 'endUtf16' | 'startLine' | 'endLine'> {
  name: string;
  displayName: string;
  kind: 'function' | 'class' | 'value';
  usedInFile: boolean;
}
export interface UnusedExports {
  candidates: (MapExport & { relativePath: string })[];
  unsure: { fileId: string; relativePath: string; reason: string; count: number }[];
  notes: string[];
}
export interface UnusedFiles {
  exports: UnusedExports;
  candidates: { fileId: string; relativePath: string }[];
  unsure: { fileId: string; relativePath: string; reason: string }[];
  excluded: { kind: UnusedExcludeKind; count: number }[];
  notes: string[];
}
/** One file of the suggested reading order: start files first, then the files their imports lead to. */
export type ReadingStep =
  /** `reaches`: how many other files this file's imports lead to. */
  | { kind: 'start'; fileId: string; reaches: number }
  /** `depth`: imports followed from the nearest listed start file. `usedBy`: files that import this one. */
  | { kind: 'next'; fileId: string; depth: number; usedBy: number };

export interface ReadingOrder {
  /** The first files of the order, at most READING_STEPS. */
  steps: ReadingStep[];
  /** Every file of the order, including the listed starts and all files they lead to. */
  total: number;
  /** Imports may be missing because files were not fully read or results were cut at a limit. */
  incomplete: boolean;
}

export interface ProjectMap {
  projectId: string;
  files: MapFile[];
  /** Static imports that lead to exactly one file. An arrow means "uses", not an execution order. */
  edges: (MapImport & { toFileId: string; names: string[] | 'all' })[];
  unresolved: (MapImport & { reason: MapUnresolvedReason; reasonText?: string; candidates: string[] })[];
  /** TS/JS imports that found no file, in encounter order; unresolved keeps the same imports. */
  missing: MissingImport[];
  /** True when later missing imports were left out at their separate size limit. */
  missingCut: boolean;
  /** Non-relative specifiers: a package and a path alias cannot be told apart from the import alone. */
  external: MapImport[];
  /** Functions over a complexity limit in the files the map read, in path and then source order. */
  complexFunctions: MapFunction[];
  /** Named functions and classes of the files the map read, in path order and then source order. */
  symbols: MapSymbol[];
  /** True when the list was cut at the size limit: a name missing from it may still exist. */
  symbolsCut: boolean;
  exports: MapExport[];
  unused: UnusedFiles;
  /** A suggested reading order from settled imports only; a suggestion, not an execution order. */
  reading: ReadingOrder;
  limited: boolean;
  notes: string[];
}

/**
 * A call found by the call search (plan v2.3 F). Like MapImport it is not an Evidence ID: the screen re-reads
 * the file and moves only while the hash is unchanged.
 */
export interface CallSite {
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
  /** The call's first line, cut short. */
  text: string;
  /** Its arguments as written (first line each); null for a tagged template, whose arguments line up differently. */
  args: { text: string; spread: boolean }[] | null;
  /** In a test file (`*.test.*`, `*.spec.*`, inside `__tests__/`): its arguments are examples (plan v2.3 V-1). */
  inTest: boolean;
  /** The function the call sits in, named as the analyzer names it; null at the top of the file. */
  inFunction: { name: string; startUtf16: number; endUtf16: number; startLine: number } | null;
}
export type CallUnknownReason = 'member' | 'expression' | 'not-function' | 'var' | 'block-function' | 'duplicate' |
  'reassigned' | 'undeclared' | 'unclear-file' | 'namespace' | 'incomplete' | 'import-file' | 'export';
/** The function a call leads to: its range is the analyzer's evidence range for it. */
export interface CallTarget { fileId: string; fileHash: string; startUtf16: number; endUtf16: number; startLine: number; name: string }
export type CallLink = CallSite & (
  | { status: 'linked'; target: CallTarget }
  | { status: 'typed'; target: CallTarget; basis: string }
  | { status: 'unknown'; reason: CallUnknownReason; detail: string | null }
  | { status: 'external'; specifier: string });
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  path: string | null;
  prefix: 'known' | 'unknown';
  framework: 'nest' | 'next' | 'express' | 'fastapi' | 'flask' | 'django';
  handler: CallTarget;
  basis: { text: string; range: ValueSite };
  /** Path parameters for matching requests: Next, FastAPI and Flask spell them differently from `:name`. */
  segments?: import('../core/analysis/next-routes').NextSegment[];
  /** True when a path parameter takes only values of some form (`<int:id>`, `{id:int}`): its links are guesses. */
  typed?: true;
  /** True when the path or method cannot be expressed by request matching. */
  unmatched?: true;
}
export interface Request extends CallSite {
  branch?: 'consequence' | 'alternative';
  path: string;
  host: string | null;
  prefix: 'known' | 'unknown';
  methods: string[] | null;
}
export interface ProjectRoutes {
  projectId: string;
  routesId: string;
  routes: Route[];
  requests: Request[];
  links: { requestIndex: number; routeIndex: number; sure: boolean; reasons: string[] }[];
  prefix: { text: string; site: ValueSite } | null;
  limited: boolean;
  notes: string[];
}
export interface FlowStop {
  /** The thrown class, e.g. NotFoundException. */
  kind: string;
  /** The first argument when it is a plain string literal, else null. */
  message: string | null;
  /** The nearest condition leading to the throw, as code text. */
  condition: string | null;
  site: ValueSite;
}
export interface FlowStore {
  /** The Prisma model property or the TypeORM repository name without `Repository`; null for raw SQL. */
  model: string | null;
  action: 'read' | 'count' | 'create' | 'update' | 'upsert' | 'delete' | 'raw';
  /** 'shape': Prisma or a $transaction client; 'name': guessed from a common client or repository name. */
  basis: 'shape' | 'name';
  site: ValueSite;
}
/** The element whose event starts the flow, read from JSX. */
export interface FlowControl { tag: string; texts: string[]; submits?: string[] }
/** A first-statement confirmation that returns without a value on cancellation. */
export interface FlowAsk { message: string | null; site: ValueSite }
/** What front code does once the response arrives, by code shape only. */
export interface FlowAfter {
  when: 'success' | 'error' | 'settled';
  action: 'refresh' | 'cache' | 'cancel' | 'navigate' | 'state' | 'notify' | 'call';
  target: string | null;
  site: ValueSite;
}
export interface FlowNode {
  id: string;
  side: 'front' | 'request' | 'back';
  depth: number;
  fileId: string;
  fileHash: string;
  relativePath: string;
  name: string;
  range: { startUtf16: number; endUtf16: number; startLine: number; endLine: number };
  event: string | null;
  control: FlowControl | null;
  asks: FlowAsk[];
  after: FlowAfter[];
  afterOmitted: number;
  screen: string | null;
  /** Full fixed heading text; display names may shorten it after comparing screens. */
  screenTitle?: { text: string; site: ValueSite } | null;
  outside: string[];
  outsideOmitted: number;
  stops: FlowStop[];
  stopsOmitted: number;
  stores: FlowStore[];
  storesOmitted: number;
}
export interface FlowEdge {
  from: string;
  to: string;
  kind: 'calls' | 'typed' | 'inside' | 'event' | 'placed' | 'hook' | 'route';
  sure: boolean;
  reasons: string[];
  site: ValueSite | null;
}
export interface FeatureFlow {
  projectId: string;
  routesId: string;
  routeIndex: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  limited: boolean;
  notes: string[];
}
/** A place in a file shown by V-1; like CallSite it is re-read before use. */
export interface ValueSite { fileId: string; fileHash: string; startUtf16: number; endUtf16: number; startLine: number; endLine: number; text: string }
/**
 * What the code says about one name the chosen function uses (plan v2.3 V-1): where and how it is declared,
 * and the values and expressions written for it. Never a value from running the code.
 */
export interface NameValue {
  /** Its own parameter, declared inside it, or declared outside it and used in it. */
  group: 'parameter' | 'inside' | 'outside';
  name: string;
  /** How it is declared; for a followed import, how the exporting file declares it. */
  role: 'parameter' | 'const' | 'let' | 'var' | 'for' | 'catch' | 'import' | 'function' | 'other';
  shape: 'plain' | 'rest' | 'destructured';
  declaredAt: ValueSite | null;
  /** The type written for it. */
  type: string | null;
  /** A const of one name written as a literal. */
  fixed: string | null;
  /** What is written where it is declared: a value, a default, a destructuring, a loop, or an exported expression. */
  initial: (ValueSite & { kind: 'value' | 'default' | 'pattern' | 'loop' | 'export' }) | null;
  /** Writes that belong to this declaration, in source order. */
  assignments: ValueSite[];
  /** A plain parameter of the chosen function: its position among the arguments of the calls found. */
  index: number | null;
  /** A parameter of an enclosing function, whose arguments are found by choosing that function. */
  outerFunction: { name: string; fileId: string; fileHash: string; startUtf16: number; endUtf16: number; startLine: number } | null;
  /** Why the declaration or its values cannot be worked out; nothing else is shown then. */
  unknown: string | null;
  /** The path of a package or path alias it is imported from. */
  external: string | null;
  notes: string[];
}
/** What one function calls and where it is called from, read from the code only; not an execution order. */
export interface FunctionCalls {
  projectId: string;
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  name: string;
  /** Calls in its own body, in source order; calls inside nested functions belong to those. */
  calls: CallLink[];
  /** Calls that lead to it; null when it has no name to be called by, so none were searched for. */
  callers: CallSite[] | null;
  /** Calls found from a written type or the same class, excluded from confirmed callers and incoming values. */
  typedCallers: (CallSite & { basis: string })[];
  /** Calls by one of its names that the rules could not settle. */
  maybeCallers: (CallSite & { reason: CallUnknownReason; detail: string | null })[];
  /** In its file (settles calls), exported (settles imports), property names (member calls only). */
  names: { local: string[]; exported: string[]; property: string[] };
  unexamined: { fileId: string; relativePath: string; reason: string }[];
  /** The names it uses and what the code says about them (plan v2.3 V-1). */
  values: NameValue[];
  limited: boolean;
  notes: string[];
}

/**
 * A shape the TypeScript checker reads from the code (plan v2.3 V-2): `text` as it prints it, and whether a real
 * `any` type shows in it. Never a value from running the code.
 */
export type Shape = { text: string; hasAny: boolean } | { unknown: string };
export interface ValueShapes {
  projectId: string;
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  /** What the chosen function returns. */
  returns: Shape;
  /** One for each name asked, in the order asked. */
  names: Shape[];
  notes: string[];
}

/** A commit that changed the opened folder (plan v2.3 C-2); HEAD is also listed, without its subject when it did not. */
export interface GitCommit { oid: string; time: number; subject: string | null; head: boolean }
/** The commits to compare with, or why the folder's Git history cannot be used. */
export interface GitHistory { projectId: string; available: boolean; reason: string | null; commits: GitCommit[] }
export type ChangeKind = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed';
/** A change of one path in the opened folder: a rename's path is the new one; a deleted file has no file now. */
export interface FileChange { kind: ChangeKind; path: string; oldPath: string | null; fileId: string | null }
export interface ProjectChanges {
  projectId: string;
  commit: string;
  changes: FileChange[];
  /** Paths left out of the comparison or not comparable, counted by reason; nothing of an excluded path is read. */
  notCompared: { reason: string; count: number }[];
  notes: string[];
}
/** One side of a change: its text, or why it could not be opened under the app's rules. */
export type CodeSide = { text: string } | { code: AppErrorCode; message: string };
export interface FileDiff { projectId: string; commit: string; old: CodeSide | null; now: CodeSide | null }

export type AppErrorCode = 'CANCELLED' | 'INVALID_REQUEST' | 'PROJECT_CLOSED' | 'NOT_ALLOWED' |
  'CHANGED' | 'UNSUPPORTED' | 'LIMIT' | 'IO' | 'INTERNAL' | 'AI_UNAVAILABLE' | 'AI_AUTH' | 'AI_RESPONSE';
export type Result<T> = { ok: true; value: T } | { ok: false; code: AppErrorCode; message: string };
export type ProjectEvent = { projectId: string; kind: 'changed' | 'watch-error' };

export interface GeminiKeyStatus { saved: boolean; readable: boolean; canEncrypt: boolean }
export const saveGeminiKeySchema = z.object({ key: z.string().min(1).max(512) }).strict();

export interface LearningApi {
  exportMap(input: MapExportRequest): Promise<Result<MapExportResult>>;
  geminiKeyStatus(): Promise<Result<GeminiKeyStatus>>;
  saveGeminiKey(input: z.infer<typeof saveGeminiKeySchema>): Promise<Result<GeminiKeyStatus>>;
  clearGeminiKey(): Promise<Result<GeminiKeyStatus>>;
  checkForUpdate(): Promise<Result<UpdateCheck>>;
  openReleasePage(): Promise<Result<null>>;
  getViewSettings(): Promise<Result<ViewSettings>>;
  setViewSettings(input: ViewSettings): Promise<Result<ViewSettings>>;
  savedPlanCompare(input: z.infer<typeof projectRequestSchema>): Promise<Result<{ result: PlanCompareResult; savedAt: string; reasons: string[] } | null>>;
  savePlanCompare(input: SavePlanCompare): Promise<Result<{ savedAt: string }>>;
  deletePlanCompare(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  startPlanCompare(input: PlanCompareRequest): Promise<Result<{ jobId: string }>>;
  checkPlanCompare(input: PlanCompareCheck): Promise<Result<{ reasons: string[] }>>;
  pickPlanDocument(): Promise<Result<PlanDocument | null>>;
  openProject(): Promise<Result<ProjectView | null>>;
  recentProjects(): Promise<Result<RecentProject[]>>;
  openRecent(input: z.infer<typeof projectRequestSchema>): Promise<Result<ProjectView | null>>;
  learningSpot(input: z.infer<typeof projectRequestSchema>): Promise<Result<SavedSpot | null>>;
  learningMarks(input: z.infer<typeof projectRequestSchema>): Promise<Result<LearningMark[]>>;
  saveLearningMark(input: z.infer<typeof saveLearningMarkSchema>): Promise<Result<LearningMark | null>>;
  saveLearningSpot(input: z.infer<typeof saveLearningSpotSchema>): Promise<Result<null>>;
  readSource(input: z.infer<typeof sourceRequestSchema>): Promise<Result<SourceView>>;
  readEvidence(input: z.infer<typeof evidenceRequestSchema>): Promise<Result<{ source: SourceView; evidence: Evidence }>>;
  cancel(): Promise<Result<null>>;
  routes(input: z.infer<typeof projectRequestSchema>): Promise<Result<ProjectRoutes>>;
  cancelRoutes(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  featureFlows(input: z.infer<typeof featureFlowsRequestSchema>): Promise<Result<FeatureFlow[]>>;
  cancelFeatureFlows(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  featureFlow(input: z.infer<typeof featureFlowRequestSchema>): Promise<Result<FeatureFlow>>;
  cancelFeatureFlow(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  projectMap(input: z.infer<typeof projectRequestSchema>): Promise<Result<ProjectMap>>;
  cancelProjectMap(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  functionCalls(input: z.infer<typeof callsRequestSchema>): Promise<Result<FunctionCalls>>;
  cancelFunctionCalls(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  valueShapes(input: z.infer<typeof shapesRequestSchema>): Promise<Result<ValueShapes>>;
  cancelValueShapes(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  gitHistory(input: z.infer<typeof projectRequestSchema>): Promise<Result<GitHistory>>;
  projectChanges(input: z.infer<typeof changesRequestSchema>): Promise<Result<ProjectChanges>>;
  fileDiff(input: z.infer<typeof diffRequestSchema>): Promise<Result<FileDiff>>;
  cancelChanges(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  checkConnections(request?: CheckConnectionsRequest): Promise<Result<ConnectionReport>>;
  startExplanation(input: ExplainRequest): Promise<Result<{ jobId: string }>>;
  startOverview(input: OverviewRequest): Promise<Result<{ jobId: string }>>;
  savedAnswers(input: { projectId: string }): Promise<Result<{ jobId: string; question: string; savedAt: string }[]>>;
  savedAnswer(input: { projectId: string; jobId: string }): Promise<Result<{ result: LearningResult; savedAt: string; changed: boolean } | null>>;
  openSavedEvidence(input: { projectId: string; jobId: string; evidenceId: string }): Promise<Result<{ source: SourceView; evidence: Evidence }>>;
  saveAnswer(input: { projectId: string; result: LearningResult }): Promise<Result<{ savedAt: string }>>;
  deleteAnswer(input: { projectId: string; jobId: string }): Promise<Result<null>>;
  savedOverview(input: z.infer<typeof projectRequestSchema>): Promise<Result<{ result: OverviewResult; savedAt: string; changed: boolean } | null>>;
  saveOverview(input: { projectId: string; result: OverviewResult }): Promise<Result<{ savedAt: string }>>;
  deleteOverview(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  savedFileExplanation(input: z.infer<typeof sourceRequestSchema>): Promise<Result<{ result: FileExplanationResult; savedAt: string } | null>>;
  saveFileExplanation(input: { projectId: string; result: FileExplanationResult }): Promise<Result<{ savedAt: string }>>;
  deleteFileExplanation(input: z.infer<typeof sourceRequestSchema>): Promise<Result<null>>;
  startFileExplanation(input: FileExplanationRequest): Promise<Result<{ jobId: string }>>;
  savedFeatureGuide(input: z.infer<typeof featureFlowsRequestSchema>): Promise<Result<{ result: FeatureGuideResult; savedAt: string; changed: boolean } | null>>;
  saveFeatureGuide(input: { projectId: string; result: FeatureGuideResult }): Promise<Result<{ savedAt: string }>>;
  deleteFeatureGuide(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  startFeatureGuide(input: FeatureGuideRequest): Promise<Result<{ jobId: string }>>;
  cancelExplanation(input: { jobId: string }): Promise<Result<null>>;
  onLearningEvent(listener: (event: LearningEvent) => void): () => void;
  onProjectEvent(listener: (event: ProjectEvent) => void): () => void;
}

export const channels = {
  geminiKeyStatus: 'learning:gemini-key-status', saveGeminiKey: 'learning:save-gemini-key', clearGeminiKey: 'learning:clear-gemini-key',
  checkForUpdate: 'learning:check-for-update', openReleasePage: 'learning:open-release-page',
  getViewSettings: 'learning:get-view-settings', setViewSettings: 'learning:set-view-settings',
  savedPlanCompare: 'learning:saved-plan-compare', savePlanCompare: 'learning:save-plan-compare', deletePlanCompare: 'learning:delete-plan-compare',
  planCompare: 'learning:plan-compare',
  planCompareCheck: 'learning:plan-compare-check',
  pickPlanDocument: 'learning:pick-plan-document',
  recentProjects: 'learning:recent-projects', openRecent: 'learning:open-recent',
  learningSpot: 'learning:spot', saveLearningSpot: 'learning:save-spot',
  learningMarks: 'learning:marks', saveLearningMark: 'learning:save-mark',
  open: 'learning:open', read: 'learning:read', evidence: 'learning:evidence',
  cancel: 'learning:cancel', event: 'learning:project-event', routes: 'learning:routes', cancelRoutes: 'learning:cancel-routes', featureFlows: 'learning:feature-flows', cancelFeatureFlows: 'learning:cancel-feature-flows', featureFlow: 'learning:feature-flow', cancelFeatureFlow: 'learning:cancel-feature-flow', map: 'learning:map', exportMap: 'learning:export-map', cancelMap: 'learning:cancel-map',
  calls: 'learning:calls', cancelCalls: 'learning:cancel-calls', shapes: 'learning:shapes', cancelShapes: 'learning:cancel-shapes',
  history: 'learning:history', changes: 'learning:changes', diff: 'learning:diff', cancelChanges: 'learning:cancel-changes',
  connections: 'learning:connections', explain: 'learning:explain', overview: 'learning:overview',
  savedAnswers: 'learning:saved-answers', savedAnswer: 'learning:saved-answer', openSavedEvidence: 'learning:open-saved-evidence',
  saveAnswer: 'learning:save-answer', deleteAnswer: 'learning:delete-answer',
  savedOverview: 'learning:saved-overview', saveOverview: 'learning:save-overview', deleteOverview: 'learning:delete-overview',
  savedFileExplanation: 'learning:saved-file-explanation', saveFileExplanation: 'learning:save-file-explanation',
  deleteFileExplanation: 'learning:delete-file-explanation',
  savedFeatureGuide: 'learning:saved-feature-guide', saveFeatureGuide: 'learning:save-feature-guide', deleteFeatureGuide: 'learning:delete-feature-guide',
  fileExplanation: 'learning:file-explanation', featureGuide: 'learning:feature-guide',
  cancelExplanation: 'learning:cancel-explanation', learningEvent: 'learning:ai-event',
} as const;
