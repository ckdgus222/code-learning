import { z } from 'zod';
import type { ConnectionReport, ExplainRequest, LearningEvent, OverviewRequest, FileExplanationRequest, FeatureGuideRequest, FileChunk, FileExplanationRange } from './ai';

export const idSchema = z.string().uuid();
export const sourceRequestSchema = z.object({ projectId: idSchema, fileId: idSchema }).strict();
export const evidenceRequestSchema = z.object({ projectId: idSchema, evidenceId: idSchema }).strict();
export const projectRequestSchema = z.object({ projectId: idSchema }).strict();
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

export interface Analysis {
  language: 'typescript' | 'javascript' | 'text';
  symbols: CodeSymbol[];
  imports: { text: string; evidence: Evidence }[];
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
export interface MapFile {
  id: string;
  relativePath: string;
  /** The folder the file sits in ('' for the project root); the design view groups by it. */
  folder: string;
  start: boolean;
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
export type MapUnresolvedReason = 'not-found' | 'ambiguous' | 'outside' | 'not-static' | 'syntax' | 'unavailable' | 'unreadable';
export interface ProjectMap {
  projectId: string;
  files: MapFile[];
  /** Static imports that lead to exactly one file. An arrow means "uses", not an execution order. */
  edges: (MapImport & { toFileId: string })[];
  unresolved: (MapImport & { reason: MapUnresolvedReason; candidates: string[] })[];
  /** Non-relative specifiers: a package and a path alias cannot be told apart from the import alone. */
  external: MapImport[];
  /** Functions over a complexity limit in the files the map read, in path and then source order. */
  complexFunctions: MapFunction[];
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
  framework: 'nest' | 'next' | 'express';
  handler: CallTarget;
  basis: { text: string; range: ValueSite };
  /** Next catch-all parameters retain their optional/required distinction. */
  segments?: import('../core/analysis/next-routes').NextSegment[];
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
  /** The Prisma model property; null for raw SQL. */
  model: string | null;
  action: 'read' | 'count' | 'create' | 'update' | 'upsert' | 'delete' | 'raw';
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

export interface LearningApi {
  openProject(): Promise<Result<ProjectView | null>>;
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
  checkConnections(): Promise<Result<ConnectionReport>>;
  startExplanation(input: ExplainRequest): Promise<Result<{ jobId: string }>>;
  startOverview(input: OverviewRequest): Promise<Result<{ jobId: string }>>;
  startFileExplanation(input: FileExplanationRequest): Promise<Result<{ jobId: string }>>;
  startFeatureGuide(input: FeatureGuideRequest): Promise<Result<{ jobId: string }>>;
  cancelExplanation(input: { jobId: string }): Promise<Result<null>>;
  onLearningEvent(listener: (event: LearningEvent) => void): () => void;
  onProjectEvent(listener: (event: ProjectEvent) => void): () => void;
}

export const channels = {
  open: 'learning:open', read: 'learning:read', evidence: 'learning:evidence',
  cancel: 'learning:cancel', event: 'learning:project-event', routes: 'learning:routes', cancelRoutes: 'learning:cancel-routes', featureFlows: 'learning:feature-flows', cancelFeatureFlows: 'learning:cancel-feature-flows', featureFlow: 'learning:feature-flow', cancelFeatureFlow: 'learning:cancel-feature-flow', map: 'learning:map', cancelMap: 'learning:cancel-map',
  calls: 'learning:calls', cancelCalls: 'learning:cancel-calls', shapes: 'learning:shapes', cancelShapes: 'learning:cancel-shapes',
  history: 'learning:history', changes: 'learning:changes', diff: 'learning:diff', cancelChanges: 'learning:cancel-changes',
  connections: 'learning:connections', explain: 'learning:explain', overview: 'learning:overview',
  fileExplanation: 'learning:file-explanation', featureGuide: 'learning:feature-guide',
  cancelExplanation: 'learning:cancel-explanation', learningEvent: 'learning:ai-event',
} as const;
