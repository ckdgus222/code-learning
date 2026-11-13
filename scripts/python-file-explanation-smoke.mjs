import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Real parser and storage, with only the AI connection and result supplied by the test. */
export async function checkPythonFileExplanation(app, page, folder) {
  await mkdir(folder, { recursive: true });
  const original = '# 한국어 😀\nLIMIT = 1\n@decorate\nasync def explained(value):\n    return value\n\nclass Detail:\n    @staticmethod\n    def render():\n        return LIMIT\n';
  const file = path.join(folder, 'explained.py');
  await writeFile(file, original);
  await writeFile(path.join(folder, 'other.py'), 'NEVER_SEND_OTHER_FILE = 2\n');
  await app.evaluate(({ ipcMain, dialog }, folder) => {
    const channels = ['learning:connections', 'learning:file-explanation'];
    const handlers = channels.map(channel => ipcMain._invokeHandlers.get(channel));
    const open = dialog.showOpenDialog;
    globalThis.pythonExplanationCalls = 0;
    globalThis.restorePythonExplanation = () => {
      channels.forEach((channel, index) => {
        ipcMain.removeHandler(channel);
        if (handlers[index]) ipcMain.handle(channel, handlers[index]);
      });
      dialog.showOpenDialog = open;
      delete globalThis.restorePythonExplanation;
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    channels.forEach(channel => ipcMain.removeHandler(channel));
    ipcMain.handle('learning:connections', () => ({ ok: true, value: { checkedAt: new Date().toISOString(), providers: [],
      modes: [{ mode: 'codex', ready: true, reason: 'Python 설명 테스트 전용 가짜 실행기' }] } }));
    ipcMain.handle('learning:file-explanation', async (event, request) => {
      if (!request.consent || request.mode !== 'codex') return { ok: false, code: 'INVALID_REQUEST', message: 'Test consent required' };
      const read = ipcMain._invokeHandlers.get('learning:read');
      const opened = await read(event, { projectId: request.projectId, fileId: request.fileId });
      if (!opened.ok) return opened;
      const source = opened.value;
      if (source.relativePath !== 'explained.py' || source.hash !== request.expectedFileHash || !source.guide) {
        return { ok: false, code: 'CHANGED', message: 'Test source changed' };
      }
      globalThis.pythonExplanationCalls++;
      const { randomUUID } = process.getBuiltinModule('node:crypto');
      const jobId = randomUUID();
      const chunks = source.guide.chunks.map(item => item.chunk);
      const result = { jobId, projectId: request.projectId, relativePath: source.relativePath, mode: request.mode,
        range: { fileId: source.fileId, fileHash: source.hash, startUtf16: 0, endUtf16: source.text.length, startLine: 1,
          endLine: source.text.split('\n').length - (source.text.endsWith('\n') ? 1 : 0) }, chunks,
        explanation: { summary: 'Python 파일 가짜 설명',
          chunks: chunks.map(chunk => ({ chunkId: chunk.id, summary: `${chunk.name} Python 가짜 설명` })), unknowns: ['실행하지 않았어요.'] },
        limitations: [], review: 'AI 대조 없음',
        models: [{ stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: 'test-python-model' }] };
      event.sender.send('learning:ai-event', { kind: 'file-explanation-completed', jobId, projectId: request.projectId, result });
      return { ok: true, value: { jobId } };
    });
  }, folder);
  const openPanel = async () => {
    const button = page.getByRole('banner').getByRole('button', { name: /^질문(?: · 진행 중)?$/ });
    if (await button.getAttribute('aria-pressed') === 'false') await button.click();
    const disclosure = page.locator('.panel > details').filter({ has: page.getByText('AI로 이 파일 설명 만들기', { exact: true }) });
    if (!await disclosure.evaluate(element => element.open)) await disclosure.locator(':scope > summary').click();
  };
  const openProject = async () => {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'explained.py', exact: true }).click();
    await page.getByRole('heading', { name: 'explained.py', exact: true }).waitFor();
    await openPanel();
  };
  try {
    await openProject();
    const connection = page.getByRole('group', { name: 'AI 연결', exact: true });
    const settings = connection.getByRole('button', { name: '설정', exact: true });
    if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
    await page.locator('.ai-panel').getByRole('combobox', { name: 'AI 사용 방식', exact: true }).selectOption('codex');
    const card = page.locator('.panel').getByRole('region', { name: '이 파일 설명', exact: true });
    assert.equal(await app.evaluate(() => globalThis.pythonExplanationCalls), 0);
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    await card.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await card.getByText('Python 설명 테스트 전용 가짜 실행기', { exact: true }).waitFor();
    const submit = card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true });
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await app.evaluate(() => globalThis.pythonExplanationCalls), 0);
    await card.getByRole('checkbox').check();
    await submit.click();
    await card.getByTestId('file-summary').getByText('Python 파일 가짜 설명', { exact: true }).waitFor();
    await card.getByText(/^저장됨 ·/).waitFor();
    assert.equal(await app.evaluate(() => globalThis.pythonExplanationCalls), 1);
    const guide = page.getByRole('region', { name: '이 파일 안내', exact: true }).locator('.file-guide');
    if (!await guide.evaluate(element => element.open)) await guide.locator(':scope > summary').click();
    const functionCard = guide.locator('.file-guide__functions > li').filter({ has: page.locator('strong', { hasText: /^explained$/ }) });
    await functionCard.getByText('AI 해석', { exact: true }).waitFor();
    await functionCard.getByText('explained Python 가짜 설명', { exact: false }).waitFor();
    const chunk = card.locator('.file-explanation__chunks > li').filter({ has: page.locator('b', { hasText: /^explained$/ }) });
    await chunk.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: explained.py · 3–5줄', { exact: true }).waitFor();
    assert.equal(await readFile(file, 'utf8'), original);
    await openProject();
    await card.getByTestId('file-summary').getByText('Python 파일 가짜 설명', { exact: true }).waitFor();
    await card.getByText(/^저장됨 ·/).waitFor();
    assert.equal(await app.evaluate(() => globalThis.pythonExplanationCalls), 1);
    await chunk.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: explained.py · 3–5줄', { exact: true }).waitFor();
    await writeFile(file, '# changed\n' + original);
    await card.getByText('다시 확인 필요: 설명을 만든 뒤 코드가 바뀌었어요.', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '파일 전체 근거', exact: true }).isDisabled(), true);
    assert.equal(await chunk.getByRole('button', { name: '코드 보기', exact: true }).isDisabled(), true);
  } catch (error) {
    await page.screenshot({ path: path.join(process.cwd(), 'test-results/python-file-explanation-failure.png') });
    throw error;
  } finally {
    await app.evaluate(() => globalThis.restorePythonExplanation());
  }
}
