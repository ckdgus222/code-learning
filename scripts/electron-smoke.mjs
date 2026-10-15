import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp('/private/tmp/code-learning-electron-');
const fixture = path.join(temporary, '한글 프로젝트');
const second = path.join(temporary, '다른 프로젝트');
const profile = path.join(temporary, 'profile');
const artifacts = path.join(root, 'test-results');
await Promise.all([mkdir(fixture), mkdir(second), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const source = '\uFEFFexport function 주문(수량: number) {\r\n\tif (수량 < 1) {\r\n\t\treturn "실패 📦";\r\n\t}\r\n\treturn "성공 e\u0301";\r\n}\r\n';
await writeFile(path.join(fixture, 'order.ts'), source);
// A loop whose last if has no known next step, a throw that a catch picks up, and a return under finally.
const loopSource = 'export function 모두(목록: string[]) {\n  for (const 항목 of 목록) {\n    if (항목) {\n      보내기(항목);\n    }\n  }\n  try {\n    throw new Error("다시");\n  } catch {\n    return 0;\n  } finally {\n    정리();\n  }\n}\n';
await writeFile(path.join(fixture, 'loop.ts'), loopSource);
await writeFile(path.join(fixture, '.env'), 'TEST_NOT_A_REAL_SECRET=canary');
await writeFile(path.join(fixture, 'auth.json'), '{"test":"not-real-auth"}');
await writeFile(path.join(fixture, 'README.md'), '# 주문 예제\n\n주문 수량을 확인하는 작은 시험 자료입니다.\n\n<script>globalThis.attacked=true</script> ![x](https://example.com/test)');
await writeFile(path.join(second, 'other.ts'), 'export function other() { return 2; }');
// Test harness lives outside the shipped app. Production IPC has no path injection/test API.
const bootstrap = path.join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(root, '.vite/build/main.cjs'))});\n`);
let app;
let page;
const checks = [];
const failures = [];
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function dialogTo(folder) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
}
async function until(callback) {
  const deadline = Date.now() + 8000;
  while (!await callback()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for an observed condition');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root,
    chromiumSandbox: true, timeout: 30_000 });
  page = await app.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).waitFor();
  await check('SQLite uses isolated profile; renderer is sandboxed', async () => {
    const state = await app.evaluate(({ app, BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { profile: app.getPath('userData'), sandbox: prefs.sandbox, isolated: prefs.contextIsolation, node: prefs.nodeIntegration };
    });
    assert.equal(state.profile, profile); assert.equal(state.sandbox, true); assert.equal(state.isolated, true); assert.equal(state.node, false);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.ok((await readFile(path.join(profile, 'learning.sqlite'))).length > 0);
  });
  await dialogTo(fixture);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
  await check('Open a real folder; secret filenames excluded', async () => {
    assert.equal(await page.getByRole('button', { name: '.env', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'auth.json', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '한눈에 보기', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
  });
  await check('Function → branch → exact original code range (CRLF/emoji/BOM)', async () => {
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    const label = await page.getByTestId('evidence-range').innerText();
    const offsets = label.match(/UTF-16 \[(\d+), (\d+)\)/);
    assert.ok(offsets);
    const selected = source.slice(Number(offsets[1]), Number(offsets[2]));
    assert.equal(selected, 'if (수량 < 1) {\r\n\t\treturn "실패 📦";\r\n\t}');
    assert.equal(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n')), source.slice(0, -2) + '\r\n');
    await page.locator('.cm-selectionBackground').first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'local-code-flow.png') });
  });
  await check('Switching views preserves the selected function, step and evidence', async () => {
    const evidence = await page.getByTestId('evidence-range').innerText();
    for (const name of ['한눈에 보기', '흐름 따라가기', '달라진 내용']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
    }
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '조건 확인', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('evidence-range').innerText(), evidence);
  });
  await check('Flow view walks one function step by step, marks unknown links and returns to the same code', async () => {
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    // The step chosen in code reading is the current flow step.
    const card = page.getByRole('article', { name: '현재 단계' });
    await card.getByRole('heading', { name: '조건 확인', exact: true }).waitFor();
    await card.getByText('수량 < 1', { exact: true }).waitFor();
    const snippet = await page.getByTestId('flow-snippet').innerText();
    assert.ok(snippet.includes('if (수량 < 1) {') && snippet.includes('return "실패 📦";'));
    await page.screenshot({ path: path.join(artifacts, 'local-flow.png') });
    await card.getByRole('button', { name: '2. 반환문', exact: true }).click();
    await card.getByText('"실패 📦"', { exact: true }).waitFor();
    await card.getByRole('button', { name: '다음 단계', exact: true }).click();
    await card.getByText('"성공 é"', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '다음 단계', exact: true }).isDisabled(), true);
    await card.getByRole('button', { name: '이전 단계', exact: true }).click();
    await card.getByText('"실패 📦"', { exact: true }).waitFor();
    await card.getByRole('button', { name: '코드 크게 보기', exact: true }).click();
    const offsets = (await page.getByTestId('evidence-range').innerText()).match(/UTF-16 \[(\d+), (\d+)\)/);
    assert.equal(source.slice(Number(offsets[1]), Number(offsets[2])), 'return "실패 📦";');
    await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
    await card.getByText('"실패 📦"', { exact: true }).waitFor();

    // Choosing another file keeps the flow view; returns and throws are listed without claiming the function ends there.
    await page.getByRole('button', { name: 'loop.ts', exact: true }).click();
    await page.getByRole('button', { name: '모두', exact: true }).click();
    const summary = page.getByRole('article', { name: '함수 요약' });
    await summary.getByRole('button', { name: '6. 오류 던지기', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    assert.match(await summary.innerText(), /함수가 실제로 어디서 끝나는지는 확인하지 않았어요/);
    assert.doesNotMatch(await summary.innerText(), /끝나는 곳/);
    // Under finally, a return is not described as the certain end, and try only goes to catch when one exists.
    await summary.getByRole('button', { name: '8. 반환문', exact: true }).click();
    await card.getByRole('heading', { name: '반환문', exact: true }).waitFor();
    assert.match(await card.innerText(), /finally가 있으면 그 부분을 먼저 지나고/);
    assert.doesNotMatch(await card.innerText(), /이 함수가 끝나요/);
    // Every throw card uses the same wording: it names no catch/finally order.
    await page.getByRole('navigation', { name: '함수와 단계' }).getByRole('button', { name: '오류 던지기', exact: true }).click();
    await card.getByRole('heading', { name: '오류 던지기', exact: true }).waitFor();
    assert.match(await card.innerText(), /어디서 받는지는 감싼 코드 구조에 따라 달라요/);
    assert.doesNotMatch(await card.innerText(), /먼저 지나고 거기서 흐름/);
    await page.getByRole('navigation', { name: '함수와 단계' }).getByRole('button', { name: '오류 처리 구문', exact: true }).click();
    await card.getByRole('heading', { name: '오류 처리 구문', exact: true }).waitFor();
    assert.match(await card.innerText(), /catch가 있을 때 그쪽으로/);
    await page.getByRole('button', { name: '모두', exact: true }).click();
    await summary.getByRole('button', { name: '다음 단계', exact: true }).click();
    await card.getByRole('heading', { name: '반복문', exact: true }).waitFor();
    await card.getByText('한 번도 안 돌 수도 있어요', { exact: false }).waitFor();
    await card.getByRole('button', { name: '다음 단계', exact: true }).click();
    await card.getByRole('heading', { name: '조건 확인', exact: true }).waitFor();
    await card.getByText('다음 연결을 확인하지 못했어요.', { exact: true }).waitFor();
    assert.equal(await card.locator('.flow-link').count(), 1);

    // A changed file hides the old code and locks every move until the file is read again.
    await writeFile(path.join(fixture, 'loop.ts'), loopSource.replace('다시', '변경'));
    await page.getByText('코드 변경 또는 창 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('flow-snippet').count(), 0);
    for (const name of ['이전 단계', '다음 단계']) assert.equal(await card.getByRole('button', { name, exact: true }).isDisabled(), true);
    assert.equal(await card.locator('.flow-link').isDisabled(), true);
    await page.getByRole('button', { name: 'loop.ts', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '모두', exact: true }).isEnabled());
    assert.equal(await page.getByText('코드 변경 또는 창 복귀:', { exact: false }).count(), 0);

    // Leave the following checks in code reading with order.ts open.
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  });
  await check('Overview shows the README intro as text and start candidates that open the flow view', async () => {
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    const intro = page.getByRole('region', { name: '이 프로젝트는 무엇을 하나요?' });
    await intro.getByText('주문 수량을 확인하는 작은 시험 자료입니다.', { exact: true }).waitFor();
    assert.match(await intro.innerText(), /README\.md · 3–3줄 · 문서 내용이 실제 코드와 맞는지는 확인하지 않았어요/);
    assert.equal(await page.evaluate(() => globalThis.attacked), undefined);
    // loop.ts changed in the flow check and files were read again since; the overview still asks for a re-check.
    await page.getByText('다시 확인 필요:', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'local-overview.png') });
    const starts = page.getByRole('region', { name: '어디부터 읽을까요?' });
    await starts.getByRole('button', { name: '주문 order.ts', exact: true }).click();
    await page.getByRole('article', { name: '함수 요약' }).getByRole('heading', { name: '주문', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    // A candidate in a file that changed after opening is not trusted to point at the same function.
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await starts.getByRole('button', { name: '모두 loop.ts', exact: true }).click();
    await page.getByText('파일이 폴더를 열 때와 달라', { exact: false }).waitFor();
    assert.equal(await page.getByRole('article', { name: '함수 요약' }).count(), 0);
    // Opening the folder again computes the overview anew and clears the re-check notice.
    // Reopening the same folder keeps its project ID, so the current view stays; go back to the overview.
    await dialogTo(fixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await until(async () => await page.getByText('다시 확인 필요:', { exact: false }).count() === 0);
    await starts.getByRole('button', { name: '모두 loop.ts', exact: true }).click();
    await page.getByRole('article', { name: '함수 요약' }).getByRole('heading', { name: '모두', exact: true }).waitFor();
    // Leave the following checks in code reading with order.ts open.
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.locator('.cm-content').waitFor();
  });
  await check('Source cannot be edited; malicious text is not executed', async () => {
    await page.locator('.cm-content').click();
    await page.keyboard.type('MUST_NOT_WRITE');
    assert.equal(await readFile(path.join(fixture, 'order.ts'), 'utf8'), source);
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await until(async () => (await page.locator('.cm-content').innerText()).includes('<script>'));
    assert.equal(await page.evaluate(() => globalThis.attacked), undefined);
    assert.equal(await page.locator('img').count(), 0);
  });
  await check('Changed source clears evidence and requires a new read', async () => {
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await writeFile(path.join(fixture, 'order.ts'), source.replace('성공', '변경'));
    await page.getByText('코드 변경 또는 창 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    await page.getByText('프로젝트를 연 뒤 코드가 바뀌었을 수 있어요. 파일을 다시 읽어 최신 코드를 확인해 주세요.', { exact: true }).waitFor();
    await page.getByText('변경 이력과 수정 전후 비교는 아직 준비 중이에요.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '주문', exact: true }).isEnabled());
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    await page.getByText('변경 이력과 수정 전후 비교는 아직 준비 중이에요.', { exact: true }).waitFor();
    assert.equal(await page.getByText('프로젝트를 연 뒤 감지된 변경이 없어요.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('코드 변경 또는 창 복귀:', { exact: false }).count(), 0);
  });
  await check('IPC rejects path injection and another window', async () => {
    const bad = await page.evaluate(() => window.learning.readSource({ projectId: 'bad', fileId: '../../auth.json' }));
    assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_REQUEST');
    const untrusted = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const trusted = BrowserWindow.getAllWindows()[0];
      const probe = new BrowserWindow({ show: false, webPreferences: { preload,
        sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await probe.loadURL(trusted.webContents.getURL());
        return await probe.webContents.executeJavaScript('window.learning.openProject()');
      } finally { probe.destroy(); }
    }, path.join(root, '.vite/build/preload.cjs'));
    assert.equal(untrusted.ok, false); assert.equal(untrusted.code, 'NOT_ALLOWED');
  });
  await check('Late cancellation cannot overwrite a new open in the UI', async () => {
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      globalThis.testOriginalTerminate = Worker.prototype.terminate;
      Worker.prototype.terminate = async function () {
        globalThis.testUiTerminateWaiting = true;
        await new Promise(resolve => { globalThis.testUiReleaseTerminate = resolve; });
        return globalThis.testOriginalTerminate.call(this);
      };
    });
    await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
    await until(() => app.evaluate(() => globalThis.testUiTerminateWaiting === true));
    await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
    await until(() => page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isEnabled());
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => {
        globalThis.testUiDialogWaiting = true;
        await new Promise(resolve => { globalThis.testUiReleaseDialog = resolve; });
        return { canceled: false, filePaths: [folder] };
      };
    }, second);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await until(() => app.evaluate(() => globalThis.testUiDialogWaiting === true));
    await app.evaluate(() => {
      process.getBuiltinModule('node:worker_threads').Worker.prototype.terminate = globalThis.testOriginalTerminate;
      globalThis.testUiReleaseTerminate();
    });
    // An IPC round-trip and browser frame allow the late cancellation response to settle.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isDisabled(), true);
    await app.evaluate(() => globalThis.testUiReleaseDialog());
    await page.getByRole('heading', { name: '다른 프로젝트', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '한눈에 보기', exact: true }).getAttribute('aria-current'), 'page');
  });
  await check('Old project IDs cannot read after project switch', async () => {
    await dialogTo(fixture);
    const first = await page.evaluate(() => window.learning.openProject());
    assert.equal(first.ok, true);
    const old = first.value;
    await dialogTo(second);
    const next = await page.evaluate(() => window.learning.openProject());
    assert.equal(next.ok, true);
    const rejected = await page.evaluate(input => window.learning.readSource(input), { projectId: old.id, fileId: old.files[0].id });
    assert.equal(rejected.ok, false); assert.equal(rejected.code, 'PROJECT_CLOSED');
  });
  await check('Cancel while resolving folder does not resurrect a session', async () => {
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs/promises');
      globalThis.testOriginalRealpath = fs.realpath;
      fs.realpath = async (...args) => {
        globalThis.testRealpathWaiting = true;
        await new Promise(resolve => { globalThis.testReleaseRealpath = resolve; });
        return globalThis.testOriginalRealpath(...args);
      };
    });
    await dialogTo(fixture);
    const pending = page.evaluate(() => window.learning.openProject());
    await until(() => app.evaluate(() => globalThis.testRealpathWaiting === true));
    await page.evaluate(() => window.learning.cancel());
    await app.evaluate(() => { process.getBuiltinModule('node:fs/promises').realpath = globalThis.testOriginalRealpath; globalThis.testReleaseRealpath(); });
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'CANCELLED');
  });
  await check('Cancel while closing previous worker does not reopen a project', async () => {
    await dialogTo(fixture);
    const first = await page.evaluate(() => window.learning.openProject());
    assert.equal(first.ok, true);
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      globalThis.testOriginalTerminate = Worker.prototype.terminate;
      Worker.prototype.terminate = async function () {
        globalThis.testTerminateWaiting = true;
        await new Promise(resolve => { globalThis.testReleaseTerminate = resolve; });
        return globalThis.testOriginalTerminate.call(this);
      };
    });
    await dialogTo(second);
    const pending = page.evaluate(() => window.learning.openProject());
    await until(() => app.evaluate(() => globalThis.testTerminateWaiting === true));
    await page.evaluate(() => window.learning.cancel());
    await app.evaluate(() => { process.getBuiltinModule('node:worker_threads').Worker.prototype.terminate = globalThis.testOriginalTerminate; globalThis.testReleaseTerminate(); });
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'CANCELLED');
    const rejected = await page.evaluate(input => window.learning.readSource(input), { projectId: first.value.id, fileId: first.value.files[0].id });
    assert.equal(rejected.ok, false); assert.equal(rejected.code, 'PROJECT_CLOSED');
  });
  await check('Errors are alerts; successful cancellation is a status cleared by the next open', async () => {
    await dialogTo(path.join(temporary, 'missing-project'));
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.notice--info').count(), 0);
    await dialogTo(fixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
    const notice = page.getByRole('status').filter({ hasText: '작업을 취소했습니다.' });
    await notice.waitFor();
    assert.equal(await notice.innerText(), '작업을 취소했습니다.');
    assert.match(await notice.getAttribute('class'), /(?:^|\s)notice--info(?:\s|$)/);
    assert.equal(await page.getByRole('alert').count(), 0);
    await dialogTo(second);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '다른 프로젝트', exact: true }).waitFor();
    assert.equal(await page.getByText('작업을 취소했습니다.', { exact: true }).count(), 0);
  });
  await check('Local worker defaults, real installation inspection and real IPC readiness/input gates', async () => {
    await page.getByRole('tab', { name: '질문', exact: true }).click();
    const selector = page.getByRole('combobox', { name: 'AI 사용 방식' });
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)),
      ['local-worker', 'codex', 'claude-code', 'antigravity']);
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('설정 보존 확인');
    // Original production handler: fixed installation candidates and --version only.
    // No authentication or AI request is performed by this button.
    await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await page.getByRole('list', { name: '로컬 AI 설치 상태' }).waitFor({ timeout: 35_000 });
    assert.match(await page.getByTestId('ai-readiness').innerText(), /질문 전송을 잠갔습니다/);
    assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '패널 접기', exact: true }).click();
    await page.getByRole('button', { name: '설명 패널 펼치기', exact: true }).click();
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.equal(await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue(), '설정 보존 확인');
    await dialogTo(fixture);
    const gate = await page.evaluate(async () => {
      const opened = await window.learning.openProject();
      if (!opened.ok || !opened.value) throw new Error('fixture open failed');
      const file = opened.value.files.find(item => item.relativePath === 'order.ts');
      if (!file) throw new Error('fixture file absent');
      const source = await window.learning.readSource({ projectId: opened.value.id, fileId: file.id });
      if (!source.ok) throw new Error('fixture source failed');
      const evidence = source.value.analysis.symbols[0].evidence;
      const request = { projectId: evidence.projectId, evidenceId: evidence.id, expectedFileHash: evidence.fileHash,
        question: '값을 설명해 주세요', mode: 'local-worker', consent: true };
      return {
        ready: await window.learning.startExplanation(request),
        consent: await window.learning.startExplanation({ ...request, consent: false }),
        path: await window.learning.startExplanation({ ...request, path: '/etc/passwd' }),
      };
    });
    assert.equal(gate.ready.ok, false); assert.equal(gate.ready.code, 'AI_UNAVAILABLE');
    assert.equal(gate.consent.ok, false); assert.equal(gate.consent.code, 'INVALID_REQUEST');
    assert.equal(gate.path.ok, false); assert.equal(gate.path.code, 'INVALID_REQUEST');
    // Restore renderer/main agreement after direct IPC fixture setup.
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('tab', { name: '질문', exact: true }).click();
  });
  await check('FAKE AI IPC: completion before start response is retained across panel/tab changes', async () => {
    // Test-only replacement after ALL real IPC checks. This never starts an AI CLI.
    await app.evaluate(({ ipcMain }) => {
      for (const channel of ['learning:connections', 'learning:explain', 'learning:cancel-explanation']) ipcMain.removeHandler(channel);
      globalThis.testFakeAiCalls = [];
      globalThis.testFakeAiCancelled = [];
      globalThis.testFakeAiBehavior = 'early';
      globalThis.testFakeAiEvidence = new Map();
      const originalEvidence = ipcMain._invokeHandlers.get('learning:evidence');
      ipcMain.removeHandler('learning:evidence');
      ipcMain.handle('learning:evidence', (event, request) => {
        const related = globalThis.testFakeAiEvidence.get(request.evidenceId);
        return related ? { ok: true, value: related } : originalEvidence(event, request);
      });
      ipcMain.handle('learning:connections', () => ({ ok: true, value: {
        checkedAt: new Date().toISOString(), providers: [],
        modes: [{ mode: 'local-worker', ready: true, reason: '테스트 전용 가짜 실행기 · 실제 AI 호출 없음' }],
      } }));
      ipcMain.handle('learning:cancel-explanation', (_event, { jobId }) => {
        globalThis.testFakeAiCancelled.push(jobId);
        return { ok: true, value: null };
      });
      ipcMain.handle('learning:explain', async (event, request) => {
        const { randomUUID } = process.getBuiltinModule('node:crypto');
        const jobId = randomUUID();
        const relatedText = 'export const related = () => 42;\n';
        const related = { id: randomUUID(), projectId: request.projectId, fileId: randomUUID(), fileHash: 'b'.repeat(64),
          startUtf16: 0, endUtf16: relatedText.length, startLine: 1, endLine: 1 };
        globalThis.testFakeAiEvidence.set(related.id, { evidence: related, source: {
          projectId: request.projectId, fileId: related.fileId, relativePath: 'related.ts', hash: related.fileHash,
          text: relatedText, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] },
        } });
        const result = { jobId, conversationId: request.conversationId ?? randomUUID(), projectId: request.projectId,
          question: request.question,
          evidence: { id: request.evidenceId, projectId: request.projectId, fileId: randomUUID(),
            fileHash: request.expectedFileHash, startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1 },
          sources: [{ evidence: related, relativePath: 'related.ts' }], limitations: ['시험용 관련 파일 자료입니다.'],
          explanation: { summary: `가짜 설명: ${request.question}`, steps: [],
            claims: [{ kind: 'code', text: '테스트용 설명입니다.', evidenceIds: [request.evidenceId] }], terms: [], unknowns: [] },
          review: 'AI 검토됨', models: [{ stage: 'explaining', provider: 'antigravity',
            requestedModel: 'gemini-3.8-flash-high', reportedModel: null }],
        };
        const completed = { kind: 'completed', jobId, projectId: request.projectId, result };
        globalThis.testFakeAiCalls.push({ jobId, request });
        if (globalThis.testFakeAiBehavior === 'hold') {
          globalThis.testFakeAiLate = () => event.sender.send('learning:ai-event', completed);
        } else {
          event.sender.send('learning:ai-event', completed);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { ok: true, value: { jobId } };
      });
    });
    await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('ai-readiness').innerText()).includes('테스트 전용'));
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('빠른 응답');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText('가짜 설명: 빠른 응답', { exact: true }).waitFor();
    await page.getByText('Antigravity · 호출 모델 gemini-3.8-flash-high · 응답 모델 미보고', { exact: true }).waitFor();
    await page.getByRole('button', { name: '패널 접기', exact: true }).click();
    await page.getByRole('button', { name: '설명 패널 펼치기', exact: true }).click();
    await page.getByRole('tab', { name: '쉬운 설명', exact: true }).click();
    await page.getByRole('tab', { name: '질문', exact: true }).click();
    await page.getByText('가짜 설명: 빠른 응답', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 1);
  });
  await check('FAKE AI IPC: cancelled job completion is ignored and a subsequent question succeeds', async () => {
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; });
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('취소할 질문');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await until(() => app.evaluate(() => globalThis.testFakeAiCalls.length === 2));
    // Allow the immediate start response to register its job before cancellation.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('button', { name: 'AI 작업 취소', exact: true }).click();
    await page.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    await until(() => app.evaluate(() => globalThis.testFakeAiCancelled.includes(globalThis.testFakeAiCalls[1].jobId)));
    await app.evaluate(() => globalThis.testFakeAiLate());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('가짜 설명: 취소할 질문', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 1);
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'early'; });
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('취소 후 새 질문');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText('가짜 설명: 취소 후 새 질문', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 2);
    const requests = await app.evaluate(() => globalThis.testFakeAiCalls.map(call => call.request));
    assert.equal(requests[2].conversationId, requests[1].conversationId);
    assert.equal(await page.getByText('가짜 설명: 취소할 질문', { exact: true }).count(), 0);
  });
  await check('FAKE AI IPC: related evidence navigation preserves answer and original follow-up scope', async () => {
    const scope = await page.getByTestId('question-scope').innerText();
    const requestsBefore = await app.evaluate(() => globalThis.testFakeAiCalls.map(call => call.request));
    await page.getByRole('button', { name: 'related.ts · 1–1행', exact: true }).last().click();
    await until(async () => (await page.locator('.cm-line').allTextContents()).join('\n').includes('export const related'));
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 2);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    assert.match(scope, /order.ts/);
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('관련 파일 확인 후 질문');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText('가짜 설명: 관련 파일 확인 후 질문', { exact: true }).waitFor();
    const lastRequest = await app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request);
    assert.equal(lastRequest.evidenceId, requestsBefore.at(-1).evidenceId);
    assert.equal(lastRequest.conversationId, requestsBefore.at(-1).conversationId);
    await page.screenshot({ path: path.join(artifacts, 'fake-ai-related-evidence.png') });
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 0);
  });
  assert.deepEqual(failures, []);
  await app.close(); app = undefined;
  await writeFile(path.join(artifacts, 'electron-smoke.json'), JSON.stringify({ passed: checks, errors: failures }, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(artifacts, 'electron-failure.png') }).catch(() => {});
  await writeFile(path.join(artifacts, 'electron-smoke.json'), JSON.stringify({ passed: checks, error: String(error), pageErrors: failures }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
