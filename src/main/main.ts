import { app, BrowserWindow, dialog, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { channels, sourceRequestSchema, evidenceRequestSchema, projectRequestSchema, callsRequestSchema, shapesRequestSchema, changesRequestSchema, diffRequestSchema, type Result, type Evidence } from '../shared/contracts';
import { AppError, failure } from '../shared/errors';
import { ProjectStorage } from '../core/storage/projects';
import { ProjectSession, workersStopped } from './project-session';
import { explainRequestSchema, cancelExplanationSchema, overviewRequestSchema } from '../shared/ai';
import { LocalAiRuntime } from '../core/ai/runtime';
import { LocalWorkerWorkflow } from '../core/ai/workflow';
import { ProjectAiContext } from '../core/ai/context';

let window: BrowserWindow | null = null;
let session: ProjectSession | undefined;
let storage: ProjectStorage;
let generation = 0;
let opening = false;
let quitting = false;
// Set only once every worker has ended; until then each quit request is held back.
let quitReady = false;
let projectRevision = 0;
let aiContext: ProjectAiContext | undefined;
// App-only Codex and Antigravity folders keep the user's own AI settings out of app runs.
const aiRuntime = new LocalAiRuntime(path.join(app.getPath('userData'), 'codex-home'), path.join(app.getPath('userData'), 'agy-home'));
const learning = new LocalWorkerWorkflow({
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
  captureOverview: async (request, signal) => {
    const revision = projectRevision;
    const active = current(request.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트를 먼저 열어 주세요.');
    const snapshot = await context.captureOverview(request.startFileId, revision, signal);
    if (session !== active || aiContext !== context || projectRevision !== revision) throw new AppError('CHANGED', '자료를 모으는 동안 프로젝트가 바뀌었습니다.');
    return snapshot;
  },
  expand: async (snapshot, ids, signal) => {
    const active = current(snapshot.projectId);
    const context = aiContext;
    if (!context) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다.');
    await context.expand(snapshot, ids, signal);
    if (session !== active || aiContext !== context || projectRevision !== snapshot.revision) throw new AppError('CHANGED', '관련 파일을 읽는 동안 프로젝트가 바뀌었습니다.');
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
  emit: event => { if (window && !window.isDestroyed()) window.webContents.send(channels.learningEvent, event); },
});
const rendererFile = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
const rendererUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL || pathToFileURL(rendererFile).href).href;

function validateSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== rendererUrl) throw new AppError('NOT_ALLOWED', '이 요청은 허용된 앱 화면에서만 사용할 수 있습니다.');
}

function current(projectId: string) {
  if (!session || session.id !== projectId) throw new AppError('PROJECT_CLOSED', '현재 선택한 프로젝트가 아닙니다.');
  return session;
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
  const previous = session;
  session = undefined;
  aiContext = undefined;
  projectRevision++;
  await Promise.all([learning.close(), aiRuntime.close(), previous?.close()]);
}

function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 800, minWidth: 760, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false },
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
  await mkdir(app.getPath('userData'), { recursive: true });
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
    // A worker started now would not be among those quitting waits for.
    if (quitting) throw new AppError('CANCELLED', '앱을 끝내는 중이에요.');
    if (opening) throw new AppError('INVALID_REQUEST', '폴더 선택 작업이 이미 진행 중입니다.');
    opening = true;
    const requestedAt = ++generation;
    try {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: '읽을 프로젝트 폴더 선택' });
      if (generation !== requestedAt) throw new AppError('CANCELLED', '폴더 열기를 취소했습니다.');
      if (selected.canceled || !selected.filePaths[0]) return null;
      const root = await realpath(selected.filePaths[0]);
      if (generation !== requestedAt) throw new AppError('CANCELLED', '폴더 열기를 취소했습니다.');
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
  handle(channels.connections, async argument => { z.undefined().parse(argument); return aiRuntime.checkConnections(); });
  handle(channels.explain, async argument => {
    const input = explainRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 질문해 주세요.');
    current(input.projectId);
    return learning.start(input);
  });
  handle(channels.overview, async argument => {
    const input = overviewRequestSchema.parse(argument);
    if (opening) throw new AppError('INVALID_REQUEST', '프로젝트를 연 뒤 개요를 만들어 주세요.');
    current(input.projectId);
    return learning.startOverview(input);
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
