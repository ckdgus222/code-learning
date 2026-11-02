import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Shared by development and packaged smoke tests. The picker can return only these temporary fixtures.
export async function checkPlanCompare(app, page, temporary, project) {
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(profile.startsWith(temporary + path.sep), 'Plan tests require an isolated test profile');
  const documents = {
    'small.md': '# 작은 기획\r\n한 줄\r\n',
    'sections.md': '# 부모 장\n' + 'a'.repeat(30000) + '\n## 하위 절\n' + 'b'.repeat(21000) + '\n# 다른 장\n작음',
    'no-headings.txt': '가\r\n'.repeat(11000),
    'one-section.md': '# 큰 절\n' + '가\r\n'.repeat(11000),
    'parent-body.md': '# 부모 본문\n' + '가'.repeat(9000) + '\r\n' + '나'.repeat(9000) + '\r\n## 작은 절\n작음',
    'too-large.md': 'x'.repeat(300 * 1024),
  };
  for (const [name, text] of Object.entries(documents)) await writeFile(path.join(temporary, name), text);
  await app.evaluate(({ ipcMain }) => {
    const channels = ['learning:plan-compare', 'learning:explain', 'learning:overview', 'learning:feature-guide', 'learning:file-explanation'];
    globalThis.planTestAiCalls = [];
    globalThis.planTestAiHandlers = channels.map(channel => [channel, ipcMain._invokeHandlers.get(channel)]);
    for (const channel of channels) ipcMain._invokeHandlers.set(channel, async () => {
      globalThis.planTestAiCalls.push(channel);
      return { ok: false, code: 'NOT_ALLOWED', message: 'No AI in plan document tests' };
    });
  });
  const card = page.getByRole('region', { name: '기획과 비교', exact: true });
  const more = page.locator('details[aria-label="더 알아보기"]');
  const showCard = async () => {
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await more.waitFor();
    if (!await more.evaluate(element => element.open)) await more.locator(':scope > summary').click();
    await card.waitFor();
  };
  const dialogTo = file => app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: file === null, filePaths: file === null ? [] : [file] });
  }, file);
  const pick = async name => {
    await dialogTo(path.join(temporary, name));
    await card.getByRole('button', { name: /^(기획 문서 고르기|다른 문서 고르기)$/ }).click();
    await card.getByText(new RegExp(`^${name.replace('.', '\\.')} ·`)).waitFor();
    await card.getByRole('button', { name: '다른 문서 고르기', exact: true }).waitFor();
  };
  try {
    await dialogTo(project);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(project), exact: true }).waitFor();
    await showCard();
    await card.getByRole('button', { name: '기획 문서 고르기', exact: true }).waitFor();
    await dialogTo(null);
    await card.getByRole('button', { name: '기획 문서 고르기', exact: true }).click();
    await card.getByRole('button', { name: '기획 문서 고르기', exact: true }).waitFor();
    assert.equal(await card.getByRole('alert').count(), 0);

    await pick('small.md');
    await card.getByText('문서 전체를 보내요.', { exact: true }).waitFor();
    assert.equal(await card.getByRole('checkbox', { name: '보낼 자료에 동의', exact: true }).count(), 1);
    assert.equal(await card.getByRole('button', { name: '대조하기', exact: true }).isDisabled(), true);

    await pick('sections.md');
    assert.equal(await card.getByRole('checkbox').count(), 3);
    await card.getByRole('checkbox', { name: /^부모 장 ·/ }).check();
    const child = card.getByRole('checkbox', { name: /^하위 절 ·/ });
    assert.equal(await child.isChecked(), true);
    assert.equal(await child.isDisabled(), true);
    const parentBytes = Buffer.byteLength(documents['sections.md'].split('# 다른 장')[0]);
    await card.getByRole('status').filter({ hasText: `${parentBytes.toLocaleString()} 바이트 /` }).waitFor();
    await card.getByRole('alert').filter({ hasText: '48 KiB를 넘어요' }).waitFor();
    await card.getByText('대조하지 않을 범위: 다른 장', { exact: true }).waitFor();

    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('region', { name: '파일 목록', exact: true }).waitFor();
    await showCard();
    assert.equal(await card.getByRole('checkbox', { name: /^부모 장 ·/ }).isChecked(), true);
    await card.getByText(/^sections\.md ·/).waitFor();
    await card.getByRole('radio', { name: '줄 범위로 고르기', exact: true }).check();
    assert.equal(await card.getByRole('checkbox').count(), 0);
    await card.getByLabel('시작 줄', { exact: true }).fill('2');
    await card.getByLabel('끝 줄', { exact: true }).fill('2');
    await card.getByRole('status').filter({ hasText: '30,001 바이트 /' }).waitFor();
    await card.getByText('대조하지 않을 범위: 1–1줄, 3–6줄', { exact: true }).waitFor();
    assert.equal(await card.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('region', { name: '파일 목록', exact: true }).waitFor();
    await showCard();
    assert.equal(await card.getByLabel('시작 줄', { exact: true }).inputValue(), '2');
    assert.equal(await card.getByLabel('끝 줄', { exact: true }).inputValue(), '2');
    const beforeCancel = await card.innerText();
    await dialogTo(null);
    await card.getByRole('button', { name: '다른 문서 고르기', exact: true }).click();
    await card.getByRole('button', { name: '다른 문서 고르기', exact: true }).waitFor();
    assert.equal(await card.innerText(), beforeCancel);

    for (const name of ['no-headings.txt', 'one-section.md']) {
      await pick(name);
      const noHeadings = name === 'no-headings.txt';
      if (noHeadings) assert.equal(await card.getByRole('radio', { name: '장·절로 고르기', exact: true }).count(), 0);
      if (!noHeadings) {
        await card.getByRole('checkbox', { name: /^큰 절 ·/ }).check();
        await card.getByRole('alert').filter({ hasText: '48 KiB를 넘어요' }).waitFor();
        await card.getByRole('radio', { name: '줄 범위로 고르기', exact: true }).check();
      }
      await card.getByRole('alert').filter({ hasText: '48 KiB를 넘어요' }).waitFor();
      await card.getByLabel('시작 줄', { exact: true }).fill('2');
      await card.getByLabel('끝 줄', { exact: true }).fill('3');
      await card.getByRole('status').filter({ hasText: '10 바이트 /' }).waitFor();
      await card.getByText(`대조하지 않을 범위: 1–1줄, 4–${noHeadings ? 11001 : 11002}줄`, { exact: true }).waitFor();
      assert.equal(await card.getByRole('alert').count(), 0);
    }

    await pick('parent-body.md');
    await card.getByRole('checkbox', { name: /^부모 본문 ·/ }).check();
    await card.getByRole('alert').filter({ hasText: '48 KiB를 넘어요' }).waitFor();
    await card.getByRole('radio', { name: '줄 범위로 고르기', exact: true }).check();
    await card.getByLabel('시작 줄', { exact: true }).fill('2');
    await card.getByLabel('끝 줄', { exact: true }).fill('2');
    await card.getByRole('status').filter({ hasText: '27,002 바이트 /' }).waitFor();
    assert.equal(await card.getByRole('alert').count(), 0);
    await dialogTo(path.join(temporary, 'too-large.md'));
    await card.getByRole('button', { name: '다른 문서 고르기', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: '256 KiB를 넘어 고를 수 없어요' }).waitFor();
    await card.getByText(/^parent-body\.md ·/).waitFor();
    assert.equal(await card.getByLabel('끝 줄', { exact: true }).inputValue(), '2');

    // Reopening a project clears the document even if the project ID stays the same.
    await dialogTo(project);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await showCard();
    await card.getByRole('button', { name: '기획 문서 고르기', exact: true }).waitFor();
    assert.equal(await card.getByText(/^parent-body\.md ·/).count(), 0);
    assert.deepEqual(await app.evaluate(() => globalThis.planTestAiCalls), []);
    await checkPlanCompareRequests(app, page, card, pick, temporary, showCard, dialogTo);
    // The checks that follow start from the welcome screen, so leave the app as it was found.
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
    // Installation state is shared across projects; reload to discard the fake readiness report too.
    await page.reload();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
  } finally {
    await app.evaluate(({ ipcMain, dialog }, project) => {
      for (const [channel, handler] of globalThis.planTestAiHandlers) ipcMain._invokeHandlers.set(channel, handler);
      delete globalThis.planTestAiHandlers;
      delete globalThis.planTestAiCalls;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, project);
  }
}


// No provider runs: every start, installation check and cancellation uses an IPC fake.
async function checkPlanCompareRequests(app, page, card, pick, temporary, showCard, dialogTo) {
  await app.evaluate(({ ipcMain }) => {
    const channels = ['learning:plan-compare', 'learning:connections', 'learning:cancel-explanation', 'learning:plan-compare-check'];
    globalThis.compareTestHandlers = channels.map(channel => [channel, ipcMain._invokeHandlers.get(channel)]);
    globalThis.compareTestRequests = [];
    globalThis.compareTestCancelled = [];
    ipcMain._invokeHandlers.set('learning:plan-compare-check', async () => ({ ok: true, value: { reasons: [] } }));
    ipcMain._invokeHandlers.set('learning:connections', async () => ({ ok: true, value: {
      checkedAt: new Date().toISOString(), providers: [],
      modes: ['local-worker', 'codex', 'antigravity'].map(mode => ({ mode, ready: true, reason: '가짜 AI 시험 준비됨' })),
    } }));
    ipcMain._invokeHandlers.set('learning:plan-compare', async (_event, input) => {
      const index = globalThis.compareTestRequests.length + 1;
      const jobId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      globalThis.compareTestRequests.push({ jobId, input });
      return { ok: true, value: { jobId } };
    });
    ipcMain._invokeHandlers.set('learning:cancel-explanation', async (_event, input) => {
      globalThis.compareTestCancelled.push(input.jobId);
      return { ok: true, value: null };
    });
  });
  const start = async () => {
    await card.getByRole('checkbox', { name: '보낼 자료에 동의', exact: true }).check();
    await card.getByRole('button', { name: '대조하기', exact: true }).click();
    await card.getByRole('button', { name: '대조 작업 취소', exact: true }).waitFor();
    return app.evaluate(() => globalThis.compareTestRequests.at(-1));
  };
  const send = async (job, kind) => app.evaluate(({ BrowserWindow }, { job, kind }) => {
    const { jobId, input } = job;
    const event = { kind, jobId, projectId: input.projectId };
    if (kind === 'progress') event.phase = 'reviewing';
    if (kind === 'plan-compare-completed') {
      const single = input.mode !== 'local-worker';
      const range = 'startLine' in input.selection ? { startLine: input.selection.startLine, endLine: input.selection.endLine }
        : { startLine: 3, endLine: 4 };
      const fileId = '00000000-0000-4000-8000-000000000099';
      event.result = { jobId, projectId: input.projectId, mode: input.mode, structureOnly: false, models: [],
        review: single ? 'AI 대조 없음' : 'AI 검토됨', document: { documentId: input.selection.documentId, name: 'fixture.md' },
        sent: [range], excluded: [], plan: [{ startLine: range.startLine, text: '시험\n'.repeat(range.endLine - range.startLine + 1) }], files: [{ id: fileId, relativePath: 'main.ts' }], edges: [], read: [],
        compare: { items: [{ title: '시험', plan: range, status: 'matches', files: [fileId],
          difference: null, missingEvidence: null, searched: null }],
          unrequested: [], designMismatches: [], unknowns: [] },
        basis: { planHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), mapHash: 'c'.repeat(64) }, limitations: [] };
    }
    BrowserWindow.getAllWindows()[0].webContents.send('learning:ai-event', event);
  }, { job, kind });
  try {
    await pick('small.md');
    await card.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await card.getByText('가짜 AI 시험 준비됨', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '대조하기', exact: true }).isDisabled(), true);
    const first = await start();
    assert.deepEqual(Object.keys(first.input).sort(), ['consent', 'mode', 'projectId', 'selection']);
    assert.deepEqual(Object.keys(first.input.selection).sort(), ['documentId', 'endLine', 'startLine']);
    assert.equal(await card.getByRole('button', { name: '다른 문서 고르기', exact: true }).isDisabled(), true);
    assert.equal(await card.getByRole('checkbox', { name: '보낼 자료에 동의', exact: true }).isChecked(), false);
    await send(first, 'progress');
    await card.getByRole('status').filter({ hasText: 'Codex가 대조 검토 중' }).waitFor();
    await send(first, 'plan-compare-completed');
    await card.getByRole('status').filter({ hasText: '대조 결과 · 기획대로 1 · 다름 0' }).waitFor();
    await card.getByText('새 파일과 기획 문서 변경은 10초마다 확인해요', { exact: true }).waitFor();
    assert.match(await card.innerText(), /대조한 범위: 1–3줄/);

    const cancelled = await start();
    await card.getByRole('button', { name: '대조 작업 취소', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: '대조 작업을 취소했어요.' }).waitFor();
    assert.ok((await app.evaluate(() => globalThis.compareTestCancelled)).includes(cancelled.jobId));
    await pick('sections.md');
    await send(cancelled, 'plan-compare-completed');
    // An event round trip through the renderer ensures the late result has been processed before asserting.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await card.getByRole('status').filter({ hasText: '대조 결과' }).count(), 0);

    await card.getByRole('checkbox', { name: /^하위 절 ·/ }).check();
    const section = await start();
    assert.deepEqual(Object.keys(section.input.selection).sort(), ['documentId', 'sectionIds']);
    assert.equal(await card.getByRole('checkbox', { name: /^다른 장 ·/ }).isDisabled(), true);
    await send(section, 'plan-compare-completed');
    await card.getByRole('status').filter({ hasText: '대조 결과' }).waitFor();
    await card.getByRole('checkbox', { name: /^하위 절 ·/ }).uncheck();
    await card.getByRole('checkbox', { name: /^다른 장 ·/ }).check();
    assert.equal(await card.getByRole('status').filter({ hasText: '대조 결과' }).count(), 0);
    const nextSection = await start();
    await send(nextSection, 'plan-compare-completed');
    await card.getByRole('status').filter({ hasText: '대조 결과' }).waitFor();
    await card.getByRole('radio', { name: '줄 범위로 고르기', exact: true }).check();
    assert.equal(await card.getByRole('status').filter({ hasText: '대조 결과' }).count(), 0);
    await card.getByLabel('시작 줄', { exact: true }).fill('3');
    await card.getByLabel('끝 줄', { exact: true }).fill('4');
    const lines = await start();
    await send(lines, 'plan-compare-completed');
    await card.getByRole('status').filter({ hasText: '대조 결과' }).waitFor();
    await card.getByLabel('끝 줄', { exact: true }).fill('3');
    assert.equal(await card.getByRole('status').filter({ hasText: '대조 결과' }).count(), 0);

    const panel = page.getByRole('complementary', { name: 'AI 질문', exact: true });
    const settings = panel.getByRole('button', { name: '설정', exact: true });
    if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
    await panel.getByLabel('AI 사용 방식', { exact: true }).selectOption('codex');
    await pick('small.md');
    const single = await start();
    assert.equal(single.input.mode, 'codex');
    await send(single, 'plan-compare-completed');
    await card.getByRole('status').filter({ hasText: '대조 결과 · 기획대로 1 · 다름 0 · 확인 못 함 0' }).waitFor();
    assert.doesNotMatch(await card.locator('.plan-compare-result').innerText(), /코드를 읽지 않은 구조 비교/);
    await card.locator('.plan-compare-result').getByText('AI 대조 · 정확성을 보장하지 않아요 · Codex 단독 · AI 대조 없음', { exact: true }).waitFor();
    await panel.getByLabel('AI 사용 방식', { exact: true }).selectOption('local-worker');
    await checkPlanCompareResults(app, page, card, pick, temporary, showCard, dialogTo, start);
  } finally {
    await app.evaluate(({ ipcMain }) => {
      for (const [channel, handler] of globalThis.compareTestHandlers) ipcMain._invokeHandlers.set(channel, handler);
      delete globalThis.compareTestHandlers;
      delete globalThis.compareTestRequests;
      delete globalThis.compareTestCancelled;
    });
  }
}

// Real document/scope checks and real import sites; only AI results are fabricated.
async function checkPlanCompareResults(app, page, card, pick, temporary, showCard, dialogTo, start) {
  const root = path.join(temporary, 'plan-result-project');
  const code = "import { value } from './other';\nexport const result = value;\n";
  await mkdir(root, { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const scopeHash = hash(JSON.stringify({ paths: ['main.ts', 'other.ts'], rules: [{ path: '.gitignore', hash: null }] }));
  const resultCard = card.locator('.plan-compare-result');
  const fileButton = resultCard.getByRole('button', { name: 'main.ts', exact: true }).first();
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fresh = async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('.plan-compare-result button');
      return button && !button.disabled;
    });
    assert.equal(await resultCard.getByRole('alert').count(), 0);
  };
  const stale = async (reason, timeout = 5000) => {
    await resultCard.getByRole('alert').filter({ hasText: reason }).waitFor({ timeout });
    assert.equal(await resultCard.locator('button:not(:disabled)').count(), 0);
  };
  const restoreCheck = () => app.evaluate(({ ipcMain }) => {
    const handler = globalThis.compareTestHandlers.find(([channel]) => channel === 'learning:plan-compare-check')[1];
    ipcMain._invokeHandlers.set('learning:plan-compare-check', handler);
  });
  const projectEvent = kind => app.evaluate(({ BrowserWindow }, kind) => {
    const request = globalThis.compareTestRequests.at(-1);
    BrowserWindow.getAllWindows()[0].webContents.send('learning:project-event', { projectId: request.input.projectId, kind });
  }, kind);
  const complete = async job => {
    const response = await page.evaluate(projectId => window.learning.projectMap({ projectId }), job.input.projectId);
    assert.equal(response.ok, true);
    const map = response.value;
    const from = map.files.find(file => file.relativePath === 'main.ts');
    const to = map.files.find(file => file.relativePath === 'other.ts');
    const { toFileId: _to, names: _names, ...site } = map.edges.find(edge => edge.fromFileId === from.id && edge.toFileId === to.id);
    const text = await readFile(path.join(temporary, 'small.md'), 'utf8');
    const range = { startLine: 1, endLine: 2 };
    const item = { title: '대조 항목', plan: range, files: [from.id], difference: null, missingEvidence: null, searched: null };
    const result = {
      jobId: job.jobId, projectId: job.input.projectId, mode: 'local-worker', structureOnly: false, models: [], review: 'AI 검토됨',
      document: { documentId: job.input.selection.documentId, name: 'small.md' }, plan: [{ startLine: 1, text }],
      sent: [{ startLine: 1, endLine: text.split('\n').length }], excluded: [],
      files: [{ id: from.id, relativePath: from.relativePath }, { id: to.id, relativePath: to.relativePath }],
      read: [{ fileId: from.id, relativePath: from.relativePath, fileHash: site.fileHash }],
      edges: [{ index: 0, from: from.relativePath, to: to.relativePath, line: site.startLine, site }],
      compare: {
        items: [
          { ...item, status: 'differs', difference: '기획과 다른 동작' },
          { ...item, status: 'missing', files: [], searched: '전체 파일 목록' },
          { ...item, status: 'unverified', files: [to.id], missingEvidence: '실행은 확인 못 함' },
          { ...item, status: 'matches' },
        ],
        unrequested: [{ title: '추가 후보', files: [to.id], note: '기획 범위에서 못 찾음' }],
        designMismatches: [{ plan: range, edge: 0, note: '직접 연결' }], unknowns: [],
      },
      basis: { planHash: hash(text), scopeHash, mapHash: 'c'.repeat(64) }, limitations: [],
    };
    await app.evaluate(({ BrowserWindow }, result) => {
      BrowserWindow.getAllWindows()[0].webContents.send('learning:ai-event', {
        kind: 'plan-compare-completed', jobId: result.jobId, projectId: result.projectId, result,
      });
    }, result);
    await resultCard.getByRole('status').filter({ hasText: '대조 결과' }).waitFor();
  };
  const reopen = async () => {
    await restoreCheck();
    await rm(path.join(root, 'new.ts'), { force: true });
    await writeFile(path.join(root, 'main.ts'), code);
    await writeFile(path.join(root, 'other.ts'), 'export const value = 1;\n');
    await writeFile(path.join(temporary, 'small.md'), '# 작은 기획\r\n한 줄\r\n');
    await dialogTo(root);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await showCard();
    await pick('small.md');
    await complete(await start());
    await fresh();
  };
  const holdCheck = async () => {
    await app.evaluate(({ ipcMain }) => {
      globalThis.planCheckPending = [];
      ipcMain._invokeHandlers.set('learning:plan-compare-check', () => new Promise(resolve => globalThis.planCheckPending.push(resolve)));
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await resultCard.getByRole('status').filter({ hasText: '지금 파일과 맞는지 확인 중' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await flush();
    assert.equal(await app.evaluate(() => globalThis.planCheckPending.length), 1, 'Overlapping checks must coalesce');
  };
  const releaseCheck = reasons => app.evaluate((_electron, reasons) => {
    globalThis.planCheckPending.shift()({ ok: true, value: { reasons } });
  }, reasons);

  // Hidden BrowserWindows need a visible-document state to exercise the foreground-only timer.
  await page.evaluate(() => {
    globalThis.planVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
  try {
    await reopen();
    assert.deepEqual(await resultCard.locator(':scope > details > summary').allTextContents(), [
      '있지만 기획과 다름 (1)', '기획에 있는데 못 찾음 (1)', '찾았지만 확인 못 함 (1)',
      '시키지 않은 작업 후보 (1)', '설계와 다른 연결 (1)', '기획대로 있음 (1)',
    ]);
    await fileButton.click();
    await page.getByRole('region', { name: '파일 목록', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('export const result = value;'));
    await showCard(); await fresh();
    await resultCard.getByRole('button', { name: 'main.ts → other.ts · 1행', exact: true }).click();
    await page.locator('.cm-selectionBackground').first().waitFor();
    await page.locator('.cm-content').focus();
    await page.waitForFunction(() => getSelection()?.toString() === "import { value } from './other';");
    await showCard(); await fresh();

    await writeFile(path.join(root, 'main.ts'), code + '// changed\n');
    await stale('대조 뒤 코드나 제외 규칙이 바뀌었어요');

    await reopen();
    await writeFile(path.join(root, 'new.ts'), 'export {};');
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await showCard();
    await stale('폴더에 새 파일이 생겼거나 없어졌어요');

    await reopen();
    await writeFile(path.join(temporary, 'small.md'), '# 바뀐 기획\n내용');
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await showCard();
    await stale('기획 문서가 바뀌었어요');

    await reopen();
    const more = page.locator('details[aria-label="더 알아보기"]');
    const foldedAt = Date.now();
    await more.locator(':scope > summary').click();
    assert.equal(await more.evaluate(element => element.open), false);
    await writeFile(path.join(temporary, 'small.md'), '# 접힌 동안 수정\n내용');
    await more.locator(':scope > summary').click();
    await stale('기획 문서가 바뀌었어요');
    assert.ok(Date.now() - foldedAt < 10_000, 'Expanding must check before the periodic interval');

    await reopen();
    await writeFile(path.join(root, 'new.ts'), 'export {};');
    await stale('폴더에 새 파일이 생겼거나 없어졌어요', 12_000);

    await reopen();
    await projectEvent('watch-error');
    await stale('파일 감시가 멈춰');
    await app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('learning:plan-compare-check', async () => ({ ok: true, value: { reasons: [] } }));
    });
    await complete(await start());
    await stale('파일 감시가 멈춰');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await flush();
    await stale('파일 감시가 멈춰');
    await reopen(); // forget() clears the broken-watch latch even for the same project ID.

    // A watch failure before any result must also latch until the folder is reopened.
    const withoutResult = await start();
    await projectEvent('watch-error');
    await complete(withoutResult);
    await stale('파일 감시가 멈춰');
    await reopen();

    // Failed checks lock evidence but can recover on the next focus.
    await app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('learning:plan-compare-check', async () => ({ ok: false, code: 'INTERNAL', message: '시험 확인 실패' }));
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await resultCard.getByRole('alert').filter({ hasText: '지금 파일과 맞는지 확인하지 못했어요: 시험 확인 실패' }).waitFor();
    assert.equal(await resultCard.locator('button:not(:disabled)').count(), 0);
    await restoreCheck();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await fresh();

    // A late stale response must not attach to a replacement result.
    await holdCheck();
    const next = await start();
    await restoreCheck();
    await complete(next); await fresh();
    await releaseCheck(['이전 결과의 늦은 응답']);
    await flush(); await fresh();

    // A changed event wins over an already-running check that later replies with no reasons.
    await holdCheck();
    await projectEvent('changed');
    await stale('대조 뒤 코드나 제외 규칙이 바뀌었어요');
    await releaseCheck([]);
    await flush();
    await stale('대조 뒤 코드나 제외 규칙이 바뀌었어요');
  } finally {
    await restoreCheck();
    await app.evaluate(() => { delete globalThis.planCheckPending; });
    await page.evaluate(() => {
      if (globalThis.planVisibilityDescriptor) Object.defineProperty(document, 'visibilityState', globalThis.planVisibilityDescriptor);
      if (!globalThis.planVisibilityDescriptor) delete document.visibilityState;
      delete globalThis.planVisibilityDescriptor;
    });
  }
}

// Restart uses the caller's existing hidden-window bootstrap and the same isolated profile.
// Only AI completion and its save are fabricated; restoration, checks, deletion and evidence opening use real IPC.
export async function checkSavedPlanCompare(app, page, temporary, restart) {
  const root = path.join(temporary, 'saved-plan-project');
  const planPath = path.join(temporary, 'saved-plan.md');
  const planText = '# 저장 기획\n값을 읽는다\n직접 연결하지 않는다';
  const code = 'export const value = 1;\n';
  const importText = "import { value } from './main';";
  const unread = `${importText}\nexport const result = value;\n`;
  await mkdir(root);
  const resetFiles = async () => {
    await writeFile(path.join(root, 'main.ts'), code);
    await writeFile(path.join(root, 'unread.ts'), unread);
    await writeFile(planPath, planText);
    await rm(path.join(root, 'new.ts'), { force: true });
  };
  await resetFiles();
  let projectId;
  const card = () => page.getByRole('region', { name: '기획과 비교', exact: true });
  const result = () => card().locator('.plan-compare-result');
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const show = async () => {
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    const more = page.locator('details[aria-label="더 알아보기"]');
    if (!await more.evaluate(element => element.open)) await more.locator(':scope > summary').click();
    await card().waitFor();
  };
  const prepare = async () => {
    const state = await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
      globalThis.savedPlanAiCalls = 0;
      for (const channel of ['learning:plan-compare', 'learning:explain', 'learning:overview', 'learning:feature-guide', 'learning:file-explanation']) {
        ipcMain._invokeHandlers.set(channel, async () => {
          globalThis.savedPlanAiCalls++;
          return { ok: false, code: 'NOT_ALLOWED', message: 'No real AI in saved plan tests' };
        });
      }
      globalThis.savedPlanRead = ipcMain._invokeHandlers.get('learning:saved-plan-compare');
      return { profile: app.getPath('userData'), visible: BrowserWindow.getAllWindows()[0].isVisible() };
    });
    assert.ok(state.profile.startsWith(temporary + path.sep));
    assert.equal(state.visible, false);
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }));
  };
  const open = async () => {
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(root), exact: true }).waitFor();
    await show();
    const recent = await page.evaluate(() => window.learning.recentProjects());
    projectId = recent.value.find(item => item.root === root).id;
  };
  const reboot = async change => {
    ({ app, page } = await restart(change));
    await prepare();
    await open();
  };
  const fresh = async () => {
    await card().getByText(/저장됨 ·/).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('.plan-compare-result button');
      return button && !button.disabled;
    });
    assert.equal(await result().getByRole('alert').count(), 0);
  };
  const stale = async (reason, timeout = 5000) => {
    await result().getByRole('alert').filter({ hasText: reason }).waitFor({ timeout });
    assert.equal(await result().locator('button:not(:disabled)').count(), 0);
  };
  const pick = async () => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, planPath);
    await card().getByRole('button', { name: /^(기획 문서 고르기|다른 문서 고르기)$/ }).click();
    await card().getByText(/^saved-plan.md ·/).waitFor();
  };
  const generate = async (failSave = false) => {
    await pick();
    const mapResponse = await page.evaluate(projectId => window.learning.projectMap({ projectId }), projectId);
    assert.equal(mapResponse.ok, true);
    const map = mapResponse.value;
    const source = await page.evaluate(({ projectId, fileId }) => window.learning.readSource({ projectId, fileId }),
      { projectId, fileId: map.files.find(file => file.relativePath === 'main.ts').id });
    assert.equal(source.ok, true);
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const paths = new Map(map.files.map(file => [file.id, file.relativePath]));
    const mapHash = hash({
      files: map.files.map(file => ({ path: file.relativePath, checked: file.checked })),
      edges: map.edges.map(edge => ({ from: paths.get(edge.fromFileId), to: paths.get(edge.toFileId), line: edge.startLine, specifier: edge.specifier })),
      unresolved: map.unresolved.map(edge => ({ from: paths.get(edge.fromFileId), specifier: edge.specifier, reason: edge.reason })),
      external: map.external.map(edge => ({ from: paths.get(edge.fromFileId), specifier: edge.specifier })),
    });
    const { toFileId: _to, names: _names, ...site } = map.edges[0];
    const fixture = {
      projectId, mode: 'local-worker', structureOnly: false, models: [], review: 'AI 검토됨',
      document: { name: 'saved-plan.md' }, plan: [{ startLine: 1, text: planText }],
      sent: [{ startLine: 1, endLine: 3 }], excluded: [],
      files: map.files.map(file => ({ id: file.id, relativePath: file.relativePath })),
      read: [{ fileId: source.value.fileId, relativePath: source.value.relativePath, fileHash: source.value.hash }],
      edges: [{ index: 0, from: 'unread.ts', to: 'main.ts', line: 1, site }],
      compare: { items: [{ title: '저장된 판정', plan: { startLine: 2, endLine: 2 }, status: 'differs',
        files: [source.value.fileId], difference: '기획과 다른 값', missingEvidence: null, searched: null }],
        unrequested: [], designMismatches: [{ plan: { startLine: 3, endLine: 3 }, edge: 0, note: '직접 연결' }], unknowns: [] },
      basis: { planHash: createHash('sha256').update(planText).digest('hex'),
        scopeHash: hash({ paths: ['main.ts', 'unread.ts'], rules: [{ path: '.gitignore', hash: null }] }), mapHash }, limitations: [],
    };
    await app.evaluate(({ ipcMain, app }, { fixture, planPath, failSave }) => {
      ipcMain._invokeHandlers.set('learning:connections', async () => ({ ok: true, value: { checkedAt: new Date().toISOString(), providers: [],
        modes: [{ mode: 'local-worker', ready: true, reason: '저장 시험용 가짜 AI' }] } }));
      ipcMain._invokeHandlers.set('learning:plan-compare', async (event, input) => {
        const jobId = process.getBuiltinModule('node:crypto').randomUUID();
        const result = { ...fixture, jobId, document: { ...fixture.document, documentId: input.selection.documentId } };
        globalThis.savedPlanFixture = result;
        globalThis.savedPlanAiCalls++;
        event.sender.send('learning:ai-event', { kind: 'plan-compare-completed', projectId: input.projectId, jobId, result });
        return { ok: true, value: { jobId } };
      });
      ipcMain._invokeHandlers.set('learning:save-plan-compare', async (_event, input) => {
        if (failSave) return { ok: false, code: 'IO', message: '시험 저장 실패' };
        const result = globalThis.savedPlanFixture;
        if (input.jobId !== result.jobId || input.projectId !== result.projectId || Object.keys(input).length !== 2) throw new Error('Unexpected save request');
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
        const db = new DatabaseSync(process.getBuiltinModule('node:path').join(app.getPath('userData'), 'learning.sqlite'));
        const savedAt = new Date().toISOString();
        try { db.prepare('INSERT OR REPLACE INTO plan_compares VALUES (?, ?, ?, ?)').run(input.projectId, JSON.stringify(result), planPath, savedAt); }
        finally { db.close(); }
        return { ok: true, value: { savedAt } };
      });
    }, { fixture, planPath, failSave });
    await card().getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await card().getByText('저장 시험용 가짜 AI', { exact: true }).waitFor();
    await card().getByRole('checkbox', { name: '보낼 자료에 동의', exact: true }).check();
    await card().getByRole('button', { name: '대조하기', exact: true }).click();
    await result().getByText('저장된 판정', { exact: true }).waitFor();
    if (!failSave) await fresh();
  };
  const openEvidence = async () => {
    await result().getByRole('button', { name: 'main.ts', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('export const value = 1;'));
    await show(); await fresh();
    await result().getByRole('button', { name: 'unread.ts → main.ts · 1행', exact: true }).click();
    await page.locator('.cm-selectionBackground').first().waitFor();
    await page.locator('.cm-content').focus();
    await page.waitForFunction(text => getSelection()?.toString() === text, importText);
    await show(); await fresh();
  };
  const holdLoad = async () => {
    await app.evaluate(({ ipcMain }) => {
      globalThis.savedPlanPending = [];
      ipcMain._invokeHandlers.set('learning:saved-plan-compare', async (event, input) => {
        const response = await globalThis.savedPlanRead(event, input);
        return new Promise(resolve => globalThis.savedPlanPending.push(() => resolve(response)));
      });
    });
    await open();
    for (let tries = 0; ; tries++) {
      if (await app.evaluate(() => globalThis.savedPlanPending.length === 1)) break;
      assert.ok(tries < 100, 'Restore did not reach the held response');
      await page.waitForTimeout(50);
    }
  };
  const releaseLoad = async () => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('learning:saved-plan-compare', globalThis.savedPlanRead);
      globalThis.savedPlanPending.shift()();
    });
    await flush();
  };

  await prepare(); await open(); await generate();
  await reboot(); await fresh();
  await card().getByRole('button', { name: '기획 문서 고르기', exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.savedPlanAiCalls), 0);
  await openEvidence();
  console.log('PASS Saved plan: restart restores current evidence without selecting a document or calling AI');

  await reboot(() => writeFile(path.join(root, 'main.ts'), 'export const value = 2;\n'));
  await stale('대조한 뒤 코드가 바뀌었어요');
  await reboot(async () => { await resetFiles(); await writeFile(planPath, '# changed'); });
  await stale('기획 문서가 바뀌었어요');
  await reboot(async () => { await resetFiles(); await rm(planPath); });
  await stale('기획 문서를 다시 읽지 못했어요');
  await reboot(async () => { await resetFiles(); await writeFile(path.join(root, 'new.ts'), 'export {};'); });
  await stale('파일 목록이나 제외 규칙(.gitignore)이 바뀌었어요');
  console.log('PASS Saved plan: offline code, document, deleted document and file-list changes lock evidence');

  await reboot(async () => { await resetFiles(); await writeFile(path.join(root, 'unread.ts'), `${importText}\nexport const result = value + 2;\n`); });
  await fresh(); await openEvidence();
  await writeFile(planPath, '# changed after restore');
  await stale('기획 문서가 바뀌었어요', 12_000);
  console.log('PASS Saved plan: unread source changes refresh import evidence and periodic checks use the saved document');

  await reboot(resetFiles); await fresh();
  await holdLoad(); await pick();
  // A selection change also invalidates the held load.
  assert.equal(await result().count(), 0);
  await releaseLoad();
  assert.equal(await result().count(), 0);
  console.log('PASS Saved plan: selecting a document discards a late restore');

  await holdLoad();
  await page.evaluate(() => {
    globalThis.savedPlanChanged = false;
    const off = window.learning.onProjectEvent(event => {
      if (event.kind === 'changed') { off(); globalThis.savedPlanChanged = true; }
    });
  });
  await writeFile(path.join(root, 'main.ts'), code + '// changed while loading\n');
  await page.waitForFunction(() => globalThis.savedPlanChanged);
  await releaseLoad();
  await stale('대조 뒤 코드나 제외 규칙이 바뀌었어요');
  console.log('PASS Saved plan: project events during restoration override a fresh response');

  await reboot(resetFiles); await fresh();
  await generate(true);
  await card().getByRole('alert').filter({ hasText: '대조 결과를 저장하지 못했어요. 앱을 닫으면 사라져요.' }).waitFor();
  await card().getByText('저장 전', { exact: false }).waitFor();
  await reboot(); await fresh(); // Failed replacement leaves the previously saved comparison intact.
  await app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('learning:saved-plan-compare', async () => ({ ok: false, code: 'IO', message: '시험 읽기 실패' }));
  });
  await open();
  await card().getByRole('alert').filter({ hasText: '저장한 대조 결과를 불러오지 못했어요.' }).waitFor();
  console.log('PASS Saved plan: save and restore failures show their recovery messages');

  await reboot(); await fresh();
  await card().getByRole('button', { name: '지우기', exact: true }).click();
  await result().waitFor({ state: 'detached' });
  await reboot();
  assert.deepEqual(await page.evaluate(projectId => window.learning.savedPlanCompare({ projectId }), projectId), { ok: true, value: null });
  assert.equal(await result().count(), 0);
  console.log('PASS Saved plan: deletion survives restart');
  // Reset test-only handlers before the caller continues the rest of the smoke suite.
  ({ app, page } = await restart());
}
