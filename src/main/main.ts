import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerMonitor, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { channels, learningSpotSchema, saveLearningSpotSchema, saveLearningMarkSchema, storedLearningMarkSchema, featureFlowsRequestSchema, featureFlowRequestSchema, sourceRequestSchema, evidenceRequestSchema, projectRequestSchema, callsRequestSchema, shapesRequestSchema, changesRequestSchema, diffRequestSchema, type Result, type Evidence } from '../shared/contracts';
import { AppError, failure } from '../shared/errors';
import { ProjectStorage } from '../core/storage/projects';
import { MAP_TIMEOUT_MS, ProjectSession, workersStopped } from './project-session';
import { learningResultSchema, saveAnswerSchema, savedAnswerRequestSchema, openSavedEvidenceSchema, explanationReferencesMatch, type LearningResult, featureGuideResultSchema, saveFeatureGuideSchema, overviewResultSchema, saveOverviewSchema, type OverviewResult, fileExplanationResultSchema, saveFileExplanationSchema, checkConnectionsSchema, explainRequestSchema, cancelExplanationSchema, overviewRequestSchema, fileExplanationRequestSchema, featureGuideRequestSchema } from '../shared/ai';
import { LocalAiRuntime } from '../core/ai/runtime';
import { checkFeatureGuideRoutes } from '../core/ai/feature-guide';
import { maskSecrets } from '../core/ai/secrets';
import { LearningWorkflow } from '../core/ai/workflow';
import { ProjectAiContext } from '../core/ai/context';
import { MAX_FILE_BYTES, readStable } from '../core/project/files';
import { planSections } from '../core/analysis/plan-sections';
import { checkPlanCompare, planPartFor, planCompareResultSchema, savePlanCompareSchema, planCompareCheckSchema, planCompareRequestSchema, planSelection, type PlanCompareResult, type PlanDocument } from '../shared/plan-compare';
import { capturePlanCompare, checkPlanCompareBasis, restorePlanCompare, revalidatePlanCompare } from '../core/ai/plan-compare';
import { handleSquirrelEvent } from './squirrel-startup';
import { ViewSettingsStore } from './view-settings';
import { checkForUpdate, RELEASES_PAGE } from './update-check';

const installing = handleSquirrelEvent();

let window: BrowserWindow | null = null;
let session: ProjectSession | undefined;
let storage: ProjectStorage;
let viewSettings: ViewSettingsStore;
let generation = 0;
let opening = false;
let quitting = false;
// Set only once every worker has ended; until then each quit request is held back.
let quitReady = false;
let projectRevision = 0;
let aiContext: ProjectAiContext | undefined;
// The one plan document picked this run, kept for the comparison step; exported for main tests.
// The picker sends metadata only; comparison results also send the selected, masked text.
export let planDocument: (PlanDocument & { path: string; text: string; hash: string }) | null = null;
let finishedPlanCompare: { result: PlanCompareResult; planPath: string } | null = null;
let pickingPlan = false;
// App-only Codex and Antigravity folders keep the user's own AI settings out of app runs.
const aiRuntime = new LocalAiRuntime(path.join(app.getPath('userData'), 'codex-home'), path.join(app.getPath('userData'), 'agy-home'));
const learning = new LearningWorkflow({
  assertReady: mode => aiRuntime.assertReady(mode),
  capture: async (request, signal) => {
    const revision = projectRevision;
    const active = current(request.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    const { source, evidence } = await readEvidence(active, request.evidenceId);
    const snapshot = await context.capture(source, evidence, revision, signal);
    if (session !== active || aiContext !== context || projectRevision !== revision) throw new AppError('CHANGED', '근거를 모으는 동안 코드가 바뀌었습니다.');
    return snapshot;
  },
  capturePlanCompare: async (request, signal) => {
    const revision = projectRevision;
    const active = current(request.projectId);
    const context = aiContext;
    const document = planDocument;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    if (!document || document.documentId !== request.selection.documentId) throw new AppError('INVALID_REQUEST', '기획 문서를 다시 골라 주세요');
    const snapshot = await capturePlanCompare(planSource(active, context),
      document, request.selection, revision, signal);
    if (session !== active || aiContext !== context || projectRevision !== revision || planDocument !== document) {
      throw new AppError('CHANGED', '대조 자료가 바뀌었어요. 다시 골라 주세요.');
    }
    return snapshot;
  },
  revalidatePlanCompare: async (snapshot, signal, final) => {
    const active = current(snapshot.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다.');
    if (projectRevision !== snapshot.revision || planDocument?.documentId !== snapshot.document.documentId) {
      throw new AppError('CHANGED', '대조 자료가 바뀌었어요. 다시 골라 주세요.');
    }
    await revalidatePlanCompare(planSource(active, context), snapshot, signal, final);
    if (session !== active || aiContext !== context || projectRevision !== snapshot.revision || planDocument?.documentId !== snapshot.document.documentId) {
      throw new AppError('CHANGED', '대조 자료가 바뀌었어요. 다시 골라 주세요.');
    }
  },
  captureOverview: async (request, signal) => {
    const revision = projectRevision;
    const active = current(request.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    const snapshot = await context.captureOverview(request.startFileId, revision, signal);
    if (session !== active || aiContext !== context || projectRevision !== revision) throw new AppError('CHANGED', '자료를 모으는 동안 프로젝트가 바뀌었습니다.');
    return snapshot;
  },
  captureFeatureGuide: async (request, signal) => {
    if (signal.aborted) throw new AppError('CANCELLED', 'AI 작업을 취소했습니다.');
    return current(request.projectId).captureFeatureGuide(request.routesId, projectRevision);
  },
  captureFile: async (request, signal) => {
    const revision = projectRevision;
    const active = current(request.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    const snapshot = await context.captureFile(request, revision, signal);
    if (session !== active || aiContext !== context || projectRevision !== revision) throw new AppError('CHANGED', '파일이 바뀌어 다시 만들어 주세요');
    return snapshot;
  },
  expand: async (snapshot, ids, signal) => {
    const active = current(snapshot.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다.');
    await context.expand(snapshot, ids, signal);
    if (session !== active || aiContext !== context || projectRevision !== snapshot.revision) throw new AppError('CHANGED', '관련 파일을 읽는 동안 프로젝트가 바뀌었습니다.');
  },
  revalidateFeatureGuide: async (snapshot, signal) => {
    if (signal.aborted) throw new AppError('CANCELLED', 'AI 작업을 취소했습니다.');
    if (snapshot.revision !== projectRevision) throw new AppError('CHANGED', '기능 목록이 바뀌었어요. 주소를 다시 찾아 주세요.');
    current(snapshot.projectId).validateFeatureGuide(snapshot.routesId, projectRevision);
  },
  revalidate: async (snapshot, signal) => {
    const active = current(snapshot.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다.');
    await context.revalidate(snapshot, signal);
    if (session !== active || aiContext !== context || projectRevision !== snapshot.revision) {
      throw new AppError('CHANGED', '답변을 만드는 동안 코드가 바뀌었습니다. 새 질문으로 다시 확인해 주세요.');
    }
  },
  run: request => aiRuntime.run(request),
  emit: event => {
    if (event.kind === 'plan-compare-completed') {
      finishedPlanCompare = planDocument?.documentId === event.result.document.documentId
        ? { result: event.result, planPath: planDocument.path } : null;
    }
    if (window && !window.isDestroyed()) window.webContents.send(channels.learningEvent, event);
  },
});
const rendererFile = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
const rendererUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL || pathToFileURL(rendererFile).href).href;

function validateSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== rendererUrl) throw new AppError('NOT_ALLOWED', '이 요청은 허용된 앱 화면에서만 사용할 수 있습니다.');
}

const planSource = (active: ProjectSession, context: ProjectAiContext) =>
  ({ projectId: active.id, root: active.root, context, map: () => active.map(MAP_TIMEOUT_MS, 'plan-compare-map'),
    restoreMap: () => active.map(MAP_TIMEOUT_MS, 'plan-map'), cancelMap: () => active.cancelPlanCompareMap() });

function current(projectId: string) {
  if (!session || session.id !== projectId) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
  return session;
}

function storedPlanCompare(projectId: string) {
  const saved = storage.planCompareOf(projectId);
  if (!saved) return null;
  const parsed = planCompareResultSchema.safeParse(saved.result);
  if (!parsed.success || parsed.data.projectId !== projectId) return null;
  const result: PlanCompareResult = parsed.data;
  try {
    checkPlanCompare(result.compare, result.sent, result.files.map(file => file.id),
      result.read.map(file => file.fileId), result.edges.map(edge => edge.index));
  } catch { return null; }
  const ranges = [...result.compare.items, ...result.compare.designMismatches].map(item => item.plan);
  if (ranges.some(range => !planPartFor(result.plan, range))) return null;
  return { result, planPath: saved.planPath, savedAt: saved.savedAt };
}

function overviewReferencesMatch(projectId: string, result: OverviewResult): boolean {
  const { overview, sources } = result;
  const allowed = new Set(sources.map(source => source.evidence.id));
  const references = [...overview.intro?.evidenceIds ?? [],
    ...overview.features.flatMap(feature => [...feature.evidenceIds, feature.start.evidenceId]),
    ...overview.roles.flatMap(role => [...role.evidenceIds, ...role.functions.map(item => item.evidenceId)])];
  return result.projectId === projectId && sources.every(source => source.evidence.projectId === projectId) &&
    allowed.size === sources.length && references.every(id => allowed.has(id));
}

function answerReferencesMatch(projectId: string, result: LearningResult): boolean {
  const { evidence, sources } = result;
  const allowed = new Set(sources.map(source => source.evidence.id));
  return result.projectId === projectId && evidence.projectId === projectId &&
    sources.every(source => source.evidence.projectId === projectId) && allowed.size === sources.length &&
    (Object.keys(evidence) as (keyof Evidence)[]).every(key => evidence[key] === sources[0].evidence[key]) &&
    explanationReferencesMatch(result.explanation, allowed);
}

function storedAnswer(projectId: string, jobId: string) {
  const saved = storage.answerOf(projectId, jobId);
  if (!saved) return null;
  const parsed = learningResultSchema.safeParse(saved.result);
  if (!parsed.success || parsed.data.jobId !== jobId || !answerReferencesMatch(projectId, parsed.data)) return null;
  return { result: parsed.data, savedAt: saved.savedAt };
}

async function readEvidence(active: ProjectSession, evidenceId: string) {
  const evidence: Evidence | undefined = aiContext?.lookup(evidenceId);
  if (!evidence) return active.evidence(evidenceId);
  const source = await active.read(evidence.fileId);
  if (evidence.projectId !== active.id || source.hash !== evidence.fileHash ||
      evidence.startUtf16 < 0 || evidence.endUtf16 > source.text.length || evidence.startUtf16 >= evidence.endUtf16) {
    throw new AppError('CHANGED', '답변에 사용한 근거가 바뀌었습니다. 다시 질문해 주세요.');
  }
  return { source, evidence };
}

function handle<T>(channel: string, action: (argument: unknown) => Promise<T>) {
  ipcMain.handle(channel, async (event, argument): Promise<Result<T>> => {
    try { validateSender(event); return { ok: true, value: await action(argument) }; }
    catch (error) {
      if (error instanceof z.ZodError) return { ok: false, code: 'INVALID_REQUEST', message: '잘못된 요청입니다.' };
      return failure(error);
    }
  });
}

async function dispose() {
  generation++;
  planDocument = null;
  finishedPlanCompare = null;
  const previous = session;
  session = undefined;
  aiContext = undefined;
  projectRevision++;
  await Promise.all([learning.close(), aiRuntime.close(), previous?.close()]);
}

async function openFolder(selectRoot: (requestedAt: number) => Promise<string | null>) {
  // A worker started now would not be among those quitting waits for.
  if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
  if (opening) throw new AppError('INVALID_REQUEST', '폴더 선택 작업이 이미 진행 중입니다.');
  opening = true;
  const requestedAt = ++generation;
  try {
    const root = await selectRoot(requestedAt);
    if (generation !== requestedAt) throw new AppError('CANCELLED', '폴더 열기를 취소했습니다.');
    if (root === null) return null;
    planDocument = null;
    finishedPlanCompare = null;
    const previous = session;
    session = undefined;
    aiContext = undefined;
    projectRevision++;
    await Promise.all([learning.close(), previous?.close()]);
    if (generation !== requestedAt) throw new AppError('CANCELLED', '폴더 열기를 취소했습니다.');
    const id = storage.recordOpen(root, path.basename(root));
    const next = new ProjectSession(id, root, path.join(__dirname, 'analysis.cjs'), event => {
      if (session === next) {
        projectRevision++;
        aiContext?.clear();
        void learning.close();
        if (window) window.webContents.send(channels.event, event);
      }
    });
    next.onRoutesInvalidated = () => learning.cancelFeatureGuide(next.id);
    session = next;
    try {
      // The screen does not know this project yet, so it ignores a change or wake-up notice sent during
      // the scan and would show a scan older than the files.
      const revision = projectRevision;
      const project = await next.open();
      if (generation !== requestedAt || session !== next) throw new AppError('CANCELLED', '이전 프로젝트 결과를 버렸습니다.');
      if (projectRevision !== revision) throw new AppError('CHANGED', '폴더를 여는 동안 파일이 바뀌었거나 잠자기에서 돌아왔습니다. 다시 열어 주세요.');
      aiContext = new ProjectAiContext(root, project);
      return project;
    } catch (error) {
      if (session === next) session = undefined;
      await next.close();
      throw error;
    }
  } finally { opening = false; }
}

function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 800, minWidth: 760, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false,
      additionalArguments: [`--code-colors=${viewSettings.get().codeColors}`] },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
  contents.on('render-process-gone', () => { void dispose(); });
  window.on('closed', () => { window = null; void dispose(); });
  void window.loadURL(rendererUrl);
}

app.whenReady().then(async () => {
  if (installing) return;
  await mkdir(app.getPath('userData'), { recursive: true });
  viewSettings = new ViewSettingsStore(path.join(app.getPath('userData'), 'view-settings.json'), nativeTheme);
  await viewSettings.load();
  handle(channels.getViewSettings, async argument => {
    z.undefined().parse(argument);
    return viewSettings.get();
  });
  handle(channels.setViewSettings, argument => viewSettings.set(argument));
  handle(channels.checkForUpdate, async argument => {
    z.undefined().parse(argument);
    return checkForUpdate(app.getVersion());
  });
  handle(channels.openReleasePage, async argument => {
    z.undefined().parse(argument);
    await shell.openExternal(RELEASES_PAGE);
    return null;
  });
  storage = new ProjectStorage(path.join(app.getPath('userData'), 'learning.sqlite'));
  // The watcher may miss changes made while the Mac slept (plan 15.6), so waking up asks for a re-check.
  // Returning to the window does not: the watcher keeps running in the background, and evidence and
  // every AI stage recheck file hashes before use.
  powerMonitor.on('resume', () => {
    if (!session || !window) return;
    projectRevision++;
    aiContext?.clear();
    void learning.close();
    window.webContents.send(channels.event, { projectId: session.id, kind: 'changed' });
  });
  handle(channels.open, async argument => {
    z.undefined().parse(argument);
    return openFolder(async requestedAt => {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: '읽을 프로젝트 폴더 선택' });
      if (generation !== requestedAt) throw new AppError('CANCELLED', '폴더 열기를 취소했습니다.');
      if (selected.canceled || !selected.filePaths[0]) return null;
      return realpath(selected.filePaths[0]);
    });
  });
  handle(channels.pickPlanDocument, async argument => {
    z.undefined().parse(argument);
    if (!session) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    if (quitting || opening || pickingPlan) throw new AppError('INVALID_REQUEST', '다른 선택 작업이 끝난 뒤 다시 골라 주세요.');
    const requestedAt = generation;
    pickingPlan = true;
    try {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openFile'], title: '대조할 기획 문서 선택',
        filters: [{ name: '기획 문서', extensions: ['md', 'markdown', 'txt'] }] });
      if (generation !== requestedAt) throw new AppError('CANCELLED', '프로젝트가 바뀌어 문서 선택을 취소했어요.');
      if (selected.canceled || selected.filePaths.length === 0) return null;
      if (selected.filePaths.length !== 1) throw new AppError('INVALID_REQUEST', '기획 문서는 하나만 골라 주세요.');
      const file = selected.filePaths[0];
      if (!['.md', '.markdown', '.txt'].includes(path.extname(file).toLowerCase())) {
        throw new AppError('UNSUPPORTED', 'Markdown·텍스트 파일(.md, .markdown, .txt)만 고를 수 있어요.');
      }
      const source = await readStable(path.dirname(file), path.basename(file), MAX_FILE_BYTES);
      if (generation !== requestedAt) throw new AppError('CANCELLED', '프로젝트가 바뀌어 문서 선택을 취소했어요.');
      const document: PlanDocument = { documentId: randomUUID(), name: maskSecrets(path.basename(file)).text,
        bytes: Buffer.byteLength(source.text, 'utf8'), ...planSections(source.text) };
      planDocument = { ...document, path: file, ...source };
      return document;
    } catch (error) {
      if (error instanceof AppError && error.code === 'LIMIT') throw new AppError('LIMIT', '문서가 256 KiB를 넘어 고를 수 없어요.');
      throw error;
    } finally { pickingPlan = false; }
  });
  handle(channels.recentProjects, async argument => {
    z.undefined().parse(argument);
    return storage.recentProjects(10);
  });
  handle(channels.openRecent, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    return openFolder(async () => {
      const root = storage.rootOf(projectId);
      if (root === null) throw new AppError('INVALID_REQUEST', '목록에 없는 프로젝트입니다.');
      // The stored root is a real path: one that resolves elsewhere now (a link put in its place) is not that folder.
      const found = await realpath(root).then(async real => real === root && (await stat(root)).isDirectory()).catch(() => false);
      if (!found) throw new AppError('IO', '이 폴더를 찾지 못했어요. 옮겼거나 지웠다면 ‘프로젝트 폴더 열기’로 다시 골라 주세요.');
      return root;
    });
  });
  handle(channels.learningSpot, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    const saved = storage.spotOf(projectId);
    if (!saved) return null;
    // A damaged or older value shows no card and stays stored.
    const parsed = learningSpotSchema.safeParse(saved.spot);
    return parsed.success ? { spot: parsed.data, savedAt: saved.savedAt } : null;
  });
  handle(channels.savedAnswers, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    return storage.answersOf(projectId).flatMap(row => {
      const parsed = learningResultSchema.safeParse(row.result);
      if (!parsed.success || parsed.data.jobId !== row.jobId || !answerReferencesMatch(projectId, parsed.data)) return [];
      return [{ jobId: row.jobId, question: parsed.data.question, savedAt: row.savedAt }];
    });
  });
  handle(channels.saveAnswer, async argument => {
    const { projectId, result } = saveAnswerSchema.parse(argument);
    const active = current(projectId);
    if (!answerReferencesMatch(projectId, result) ||
        result.sources.some(source => active.relativePathOf(source.evidence.fileId) !== source.relativePath)) {
      throw new AppError('NOT_ALLOWED', '현재 프로젝트에서 확인한 근거의 답만 저장할 수 있어요.');
    }
    const masked = learningResultSchema.parse({ ...result, question: maskSecrets(result.question).text });
    return { savedAt: storage.saveAnswer(projectId, result.jobId, masked) };
  });
  handle(channels.savedAnswer, async argument => {
    const { projectId, jobId } = savedAnswerRequestSchema.parse(argument);
    const active = current(projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    const saved = storedAnswer(projectId, jobId);
    if (!saved) return null;
    const { sources, changed } = await context.checkSources(saved.result.sources);
    if (session !== active || aiContext !== context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    return { result: { ...saved.result, sources, evidence: sources[0].evidence }, savedAt: saved.savedAt, changed };
  });
  handle(channels.openSavedEvidence, async argument => {
    const { projectId, jobId, evidenceId } = openSavedEvidenceSchema.parse(argument);
    const active = current(projectId);
    const context = aiContext;
    const revision = projectRevision;
    if (!context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    const saved = storedAnswer(projectId, jobId);
    if (!saved || !saved.result.sources.some(source => source.evidence.id === evidenceId)) {
      throw new AppError('NOT_ALLOWED', '저장된 답의 근거를 찾지 못했어요.');
    }
    const { sources, changed } = await context.checkSources(saved.result.sources);
    if (session !== active || aiContext !== context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    if (changed) throw new AppError('CHANGED', '답을 만든 뒤 코드가 바뀌어 열지 않았어요.');
    const evidence = sources.find(source => source.evidence.id === evidenceId)!.evidence;
    const source = await active.read(evidence.fileId);
    if (session !== active || aiContext !== context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    if (projectRevision !== revision || source.hash !== evidence.fileHash) {
      throw new AppError('CHANGED', '답을 만든 뒤 코드가 바뀌어 열지 않았어요.');
    }
    return { source, evidence };
  });
  handle(channels.deleteAnswer, async argument => {
    const { projectId, jobId } = savedAnswerRequestSchema.parse(argument);
    current(projectId);
    storage.deleteAnswer(projectId, jobId);
    return null;
  });
  handle(channels.savedOverview, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    const active = current(projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    const saved = storage.overviewOf(projectId);
    if (!saved) return null;
    const parsed = overviewResultSchema.safeParse(saved.result);
    if (!parsed.success || !overviewReferencesMatch(projectId, parsed.data)) return null;
    const { sources, changed } = await context.restoreSources(parsed.data.sources);
    if (session !== active || aiContext !== context) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
    return { result: { ...parsed.data, sources }, savedAt: saved.savedAt, changed };
  });
  handle(channels.saveOverview, async argument => {
    const { projectId, result } = saveOverviewSchema.parse(argument);
    const active = current(projectId);
    if (!overviewReferencesMatch(projectId, result) ||
        result.sources.some(source => active.relativePathOf(source.evidence.fileId) !== source.relativePath)) {
      throw new AppError('NOT_ALLOWED', '현재 프로젝트에서 확인한 근거의 개요만 저장할 수 있어요.');
    }
    return { savedAt: storage.saveOverview(projectId, result) };
  });
  handle(channels.deleteOverview, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    storage.deleteOverview(projectId);
    return null;
  });
  handle(channels.savedFeatureGuide, async argument => {
    const { projectId, routesId } = featureFlowsRequestSchema.parse(argument);
    const snapshot = current(projectId).captureFeatureGuide(routesId, projectRevision);
    const saved = storage.featureGuideOf(projectId);
    if (!saved) return null;
    const parsed = featureGuideResultSchema.safeParse(saved.result);
    if (!parsed.success || parsed.data.projectId !== projectId) return null;
    const changed = saved.materialHash !== snapshot.materialHash;
    if (!changed) {
      try { checkFeatureGuideRoutes(parsed.data.guide, snapshot.material.routes.map(route => route.index)); }
      catch { return null; }
    }
    return { result: { ...parsed.data, routesId }, savedAt: saved.savedAt, changed };
  });
  handle(channels.saveFeatureGuide, async argument => {
    const { projectId, result } = saveFeatureGuideSchema.parse(argument);
    const active = current(projectId);
    if (result.projectId !== projectId) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 기능 정리만 저장할 수 있어요.');
    const snapshot = active.captureFeatureGuide(result.routesId, projectRevision);
    try { checkFeatureGuideRoutes(result.guide, snapshot.material.routes.map(route => route.index)); }
    catch { throw new AppError('NOT_ALLOWED', '현재 자료에 있는 주소 번호만 저장할 수 있어요.'); }
    return { savedAt: storage.saveFeatureGuide(projectId, result, snapshot.materialHash) };
  });
  handle(channels.deleteFeatureGuide, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    storage.deleteFeatureGuide(projectId);
    return null;
  });
  handle(channels.savedFileExplanation, async argument => {
    const { projectId, fileId } = sourceRequestSchema.parse(argument);
    const relativePath = current(projectId).relativePathOf(fileId);
    const saved = storage.fileExplanationOf(projectId, relativePath);
    if (!saved) return null;
    const parsed = fileExplanationResultSchema.safeParse(saved.result);
    if (!parsed.success || parsed.data.relativePath !== relativePath) return null;
    const result = parsed.data;
    return { result: { ...result, range: { ...result.range, fileId },
      chunks: result.chunks.map(chunk => ({ ...chunk, range: { ...chunk.range, fileId } })) }, savedAt: saved.savedAt };
  });
  handle(channels.saveFileExplanation, async argument => {
    const { projectId, result } = saveFileExplanationSchema.parse(argument);
    const active = current(projectId);
    if (result.projectId !== projectId || active.relativePathOf(result.range.fileId) !== result.relativePath ||
        result.chunks.some(chunk => chunk.range.fileId !== result.range.fileId)) {
      throw new AppError('NOT_ALLOWED', '현재 프로젝트의 같은 파일 설명만 저장할 수 있어요.');
    }
    // Names come straight from the code (a computed method name can hold a token), so the stored copy is masked as the AI's was.
    const masked = { ...result, chunks: result.chunks.map(chunk => ({ ...chunk, name: maskSecrets(chunk.name).text })) };
    return { savedAt: storage.saveFileExplanation(projectId, result.relativePath, masked) };
  });
  handle(channels.deleteFileExplanation, async argument => {
    const { projectId, fileId } = sourceRequestSchema.parse(argument);
    const relativePath = current(projectId).relativePathOf(fileId);
    storage.deleteFileExplanation(projectId, relativePath);
    return null;
  });
  handle(channels.learningMarks, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    return storage.marksOf(projectId).flatMap(row => {
      const parsed = storedLearningMarkSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  });
  handle(channels.saveLearningMark, async argument => {
    const { projectId, mark } = saveLearningMarkSchema.parse(argument);
    current(projectId);
    return storage.saveMark(projectId, mark);
  });
  handle(channels.saveLearningSpot, async argument => {
    const { projectId, spot } = saveLearningSpotSchema.parse(argument);
    current(projectId);
    storage.saveSpot(projectId, spot);
    return null;
  });
  handle(channels.routes, async argument => {
    const input = projectRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(input.projectId);
    const revision = projectRevision;
    const result = await active.routes(revision);
    if (session !== active || projectRevision !== revision) {
      active.cancelRoutes();
      throw new AppError('CHANGED', '프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.');
    }
    return result;
  });
  handle(channels.cancelRoutes, async argument => {
    current(projectRequestSchema.parse(argument).projectId).cancelRoutes();
    return null;
  });
  handle(channels.featureFlows, async argument => {
    const input = featureFlowsRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(input.projectId);
    const revision = projectRevision;
    const result = await active.featureFlows(input.routesId, revision);
    if (session !== active || projectRevision !== revision) throw new AppError('CHANGED', '프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.');
    return result;
  });
  handle(channels.cancelFeatureFlows, async argument => {
    current(projectRequestSchema.parse(argument).projectId).cancelFeatureFlows();
    return null;
  });
  handle(channels.featureFlow, async argument => {
    const input = featureFlowRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(input.projectId);
    const revision = projectRevision;
    const result = await active.featureFlow(input.routesId, input.routeIndex, revision);
    if (session !== active || projectRevision !== revision) throw new AppError('CHANGED', '프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.');
    return result;
  });
  handle(channels.cancelFeatureFlow, async argument => {
    current(projectRequestSchema.parse(argument).projectId).cancelFeatureFlow();
    return null;
  });
  handle(channels.map, async argument => {
    const input = projectRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(input.projectId);
    const revision = projectRevision;
    const map = await active.map();
    // Waking from sleep raises only projectRevision, not the session's own change count.
    if (session !== active || projectRevision !== revision) {
      throw new AppError('CHANGED', '지도를 만드는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 만들어 주세요.');
    }
    return map;
  });
  handle(channels.cancelMap, async argument => {
    const input = projectRequestSchema.parse(argument);
    current(input.projectId).cancelMap();
    return null;
  });
  handle(channels.calls, async argument => {
    const { projectId, ...target } = callsRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(projectId);
    const revision = projectRevision;
    const calls = await active.calls(target);
    // As with the map: waking from sleep raises only projectRevision.
    if (session !== active || projectRevision !== revision) {
      throw new AppError('CHANGED', '호출을 찾는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 찾아 주세요.');
    }
    return calls;
  });
  handle(channels.cancelCalls, async argument => {
    const input = projectRequestSchema.parse(argument);
    current(input.projectId).cancelCalls();
    return null;
  });
  handle(channels.shapes, async argument => {
    const { projectId, names, ...target } = shapesRequestSchema.parse(argument);
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(projectId);
    const revision = projectRevision;
    const shapes = await active.shapes(target, names);
    // As with the calls: waking from sleep raises only projectRevision.
    if (session !== active || projectRevision !== revision) {
      throw new AppError('CHANGED', '값의 모양을 찾는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 찾아 주세요.');
    }
    return shapes;
  });
  handle(channels.cancelShapes, async argument => {
    const input = projectRequestSchema.parse(argument);
    current(input.projectId).cancelShapes();
    return null;
  });
  // Plan v2.3 C-2. Like the calls: refused while quitting, and dropped when the folder changed meanwhile.
  const fresh = async <T>(projectId: string, work: (active: ProjectSession) => Promise<T>, changed: string): Promise<T> => {
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    const active = current(projectId);
    const revision = projectRevision;
    const value = await work(active);
    if (session !== active || projectRevision !== revision) throw new AppError('CHANGED', changed);
    return value;
  };
  handle(channels.history, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    return fresh(projectId, active => active.gitHistory(), 'Git 기록을 읽는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 읽어 주세요.');
  });
  handle(channels.changes, async argument => {
    const { projectId, commit } = changesRequestSchema.parse(argument);
    return fresh(projectId, active => active.changes(commit), '비교하는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 비교해 주세요.');
  });
  handle(channels.diff, async argument => {
    const { projectId, commit, oldPath, fileId } = diffRequestSchema.parse(argument);
    return fresh(projectId, active => active.fileDiff(commit, oldPath, fileId), '코드를 여는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 열어 주세요.');
  });
  handle(channels.cancelChanges, async argument => {
    const input = projectRequestSchema.parse(argument);
    current(input.projectId).cancelChanges();
    return null;
  });
  handle(channels.read, async argument => {
    const input = sourceRequestSchema.parse(argument);
    const active = current(input.projectId);
    const result = await active.read(input.fileId);
    if (session !== active) throw new AppError('CANCELLED', '이전 프로젝트 결과를 버렸습니다.');
    return result;
  });
  handle(channels.evidence, async argument => {
    const input = evidenceRequestSchema.parse(argument);
    const active = current(input.projectId);
    const result = await readEvidence(active, input.evidenceId);
    if (session !== active) throw new AppError('CANCELLED', '이전 프로젝트 결과를 버렸습니다.');
    // Code chosen here can become the question while another file is read before sending (ProjectAiContext.keep).
    aiContext?.keep(result.evidence);
    return result;
  });
  handle(channels.cancel, async argument => { z.undefined().parse(argument); await dispose(); return null; });
  handle(channels.connections, async argument => aiRuntime.checkConnections(checkConnectionsSchema.parse(argument)));
  handle(channels.explain, async argument => {
    const input = explainRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 질문해 주세요.');
    current(input.projectId);
    return learning.start(input);
  });
  handle(channels.planCompare, async argument => {
    const input = planCompareRequestSchema.parse(argument);
    if (opening || pickingPlan) throw new AppError('INVALID_REQUEST', '폴더와 문서를 고른 뒤 대조해 주세요.');
    current(input.projectId);
    if (!planDocument || input.selection.documentId !== planDocument.documentId) throw new AppError('INVALID_REQUEST', '기획 문서를 다시 골라 주세요');
    planSelection(planDocument, input.selection);
    return learning.startPlanCompare(input);
  });
  handle(channels.savePlanCompare, async argument => {
    const { projectId, jobId } = savePlanCompareSchema.parse(argument);
    current(projectId);
    if (!finishedPlanCompare || finishedPlanCompare.result.projectId !== projectId || finishedPlanCompare.result.jobId !== jobId) {
      throw new AppError('NOT_ALLOWED', '이번에 끝난 대조 결과만 저장할 수 있어요.');
    }
    // The import line is project code: mask it like other saved text. Highlighting uses only the hash and offsets.
    const { result, planPath } = finishedPlanCompare;
    const masked = (text: string) => maskSecrets(text).text;
    const stored: PlanCompareResult = { ...result, edges: result.edges.map(edge => ({ ...edge, site: { ...edge.site,
      text: masked(edge.site.text), specifier: edge.site.specifier === null ? null : masked(edge.site.specifier) } })) };
    return { savedAt: storage.savePlanCompare(projectId, stored, planPath) };
  });
  handle(channels.savedPlanCompare, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    const active = current(projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    const saved = storedPlanCompare(projectId);
    if (!saved) return null;
    const restored = await restorePlanCompare(planSource(active, context), saved.result, saved.planPath);
    if (session !== active || aiContext !== context) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다.');
    return { ...restored, savedAt: saved.savedAt };
  });
  handle(channels.deletePlanCompare, async argument => {
    const { projectId } = projectRequestSchema.parse(argument);
    current(projectId);
    storage.deletePlanCompare(projectId);
    return null;
  });
  handle(channels.planCompareCheck, async argument => {
    const input = planCompareCheckSchema.parse(argument);
    if (opening || pickingPlan) throw new AppError('INVALID_REQUEST', '폴더와 문서를 고른 뒤 확인해 주세요.');
    const active = current(input.projectId);
    const context = aiContext;
    const document = planDocument;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    // A restored result has no picked document; its saved location is checked instead.
    let planPath = document?.documentId === input.documentId ? document.path : null;
    if (!planPath) {
      const saved = storedPlanCompare(input.projectId);
      if (saved?.result.document.documentId === input.documentId) planPath = saved.planPath;
    }
    if (!planPath) throw new AppError('INVALID_REQUEST', '기획 문서를 다시 골라 주세요');
    const reasons = await checkPlanCompareBasis(planSource(active, context), planPath, input);
    if (session !== active || aiContext !== context || planDocument !== document) {
      throw new AppError('CHANGED', '대조 자료가 바뀌었어요. 다시 골라 주세요.');
    }
    return { reasons };
  });
  handle(channels.overview, async argument => {
    const input = overviewRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 개요를 만들어 주세요.');
    current(input.projectId);
    return learning.startOverview(input);
  });
  handle(channels.featureGuide, async argument => {
    const input = featureGuideRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 정리해 주세요.');
    current(input.projectId).validateFeatureGuide(input.routesId, projectRevision);
    return learning.startFeatureGuide(input);
  });
  handle(channels.fileExplanation, async argument => {
    const input = fileExplanationRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 설명을 만들어 주세요.');
    current(input.projectId);
    return learning.startFileExplanation(input);
  });
  handle(channels.cancelExplanation, async argument => {
    const input = cancelExplanationSchema.parse(argument);
    await learning.cancel(input.jobId);
    return null;
  });
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
}).catch(() => { dialog.showErrorBox('시작 실패', '앱 저장소 또는 실행 환경을 열지 못했습니다.'); app.exit(1); });

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  // Workers end only after replying (ending one mid-parse aborts the app), so quitting waits for them all,
  // including ones a window close or a cancel started closing before this.
  void dispose().then(() => workersStopped()).finally(() => { storage?.close(); quitReady = true; app.quit(); });
});
