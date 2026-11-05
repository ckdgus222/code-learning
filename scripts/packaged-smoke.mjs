import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkPlanCompare } from './plan-compare-smoke.mjs';

const root = path.resolve(import.meta.dirname, '..');
const packagedApp = {
  darwin: 'out/Code Learning-darwin-arm64/Code Learning.app/Contents/MacOS/Code Learning',
  win32: 'out/Code Learning-win32-x64/Code Learning.exe',
}[process.platform];
if (!packagedApp) throw new Error(`Packaged smoke tests support only macOS and Windows; got ${process.platform}`);
// Windows has no changes view in v1.0 (no git there) and Ctrl for the reader keys.
const onMac = process.platform === 'darwin';
const readerKeys = { find: onMac ? 'Meta+f' : 'Control+f' };
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'code-learning-package-')));
const profile = path.join(temp, 'profile');
const project = path.join(temp, '패키지 시험');
await Promise.all([mkdir(profile), mkdir(project), mkdir(path.join(root, 'test-results'), { recursive: true })]);
const text = 'export function packaged(value: number) { if (value < 0) return "실패"; return "성공"; }';
await writeFile(path.join(project, 'sample.ts'), text);
// Uses sample.ts, so the project map has one arrow to draw.
await writeFile(path.join(project, 'helper.ts'), "import { packaged } from './sample';\nexport const twice = (value: number) => packaged(value);\n");
// Plan v2.3 V-2: a package with only a type file, which the TypeScript checker may read.
await mkdir(path.join(project, 'node_modules/money'), { recursive: true });
await writeFile(path.join(project, 'node_modules/money/package.json'), JSON.stringify({ name: 'money', types: 'index.d.ts' }));
await writeFile(path.join(project, 'node_modules/money/index.d.ts'), 'export declare function format(amount: number): string;\n');
await writeFile(path.join(project, 'price.ts'), "import { format } from 'money';\nexport function label(amount: number) { return format(amount); }\n");
// Plan v2.3 C-2: the folder is a Git repository with one commit, and price.ts changed after it.
const gitHere = (...args) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
if (onMac) {
  gitHere('init', '-q');
  gitHere('add', 'sample.ts', 'helper.ts', 'price.ts');
  gitHere('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'packaged');
}
await writeFile(path.join(project, 'price.ts'), "import { format } from 'money';\nexport function label(amount: number) { return format(amount); }\n// changed\n");
// A separate project keeps the existing screen checks and their file counts unchanged.
const treeFixture = path.join(temp, '폴더 트리 프로젝트');
await mkdir(path.join(treeFixture, 'api/src'), { recursive: true });
await mkdir(path.join(treeFixture, 'api/test'), { recursive: true });
await writeFile(path.join(treeFixture, 'api/src/main.ts'), 'export function nested(value: number) { if (value < 0) return 0; return value; }\n');
await writeFile(path.join(treeFixture, 'api/test/helper.ts'), 'export const helper = 1;\n');
await writeFile(path.join(treeFixture, 'root.ts'), 'export const root = 1;\n');
let app;
async function openFunctionFlow(page) {
  await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  if (await page.locator('.symbols__item[aria-pressed="true"]').count() === 0) await page.locator('.symbols__item').first().click();
  await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
}
try {
  app = await electron.launch({
    executablePath: path.join(root, packagedApp),
    // Playwright pretends the system is light unless told not to; null lets nativeTheme reach the page as on a real Mac.
    args: [`--user-data-dir=${profile}`], chromiumSandbox: true, timeout: 30_000, colorScheme: null,
  });
  const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), versions: process.versions }));
  assert.equal(state.packaged, true);
  assert.equal(state.userData, profile, 'Packaged test must use isolated userData');
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).waitFor();
  try {
    for (const mode of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, mode) => { nativeTheme.themeSource = mode; }, mode);
      const background = mode === 'light' ? 'rgb(247, 250, 253)' : 'rgb(10, 20, 34)';
      await page.waitForFunction(({ mode, background }) =>
        matchMedia(`(prefers-color-scheme: ${mode})`).matches
          && getComputedStyle(document.documentElement).backgroundColor === background, { mode, background });
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light dark');
    }
  } finally {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  }
  assert.equal(await page.locator('.files h3').count(), 0);
  await checkPlanCompare(app, page, temp, project);
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  await page.getByRole('button', { name: 'sample.ts', exact: true }).click();
  await page.getByRole('button', { name: 'packaged', exact: true }).click();
  await page.getByRole('button', { name: '조건 확인', exact: true }).click();
  await page.getByTestId('evidence-range').waitFor();
  // All three steps start on line 1: the marker selects the first even when another is current.
  const markers = page.locator('.code-step-marker');
  assert.deepEqual(await markers.allTextContents(), ['1+']);
  assert.equal(await markers.first().getAttribute('title'), '1단계 · 조건 확인');
  assert.equal(await markers.first().getAttribute('tabindex'), '-1');
  assert.equal(await markers.first().getAttribute('aria-pressed'), 'true');
  // Both steps sit on line 1, so the exact range is read from the element's UTF-16 attribute.
  const firstEvidence = await page.getByTestId('evidence-range').getAttribute('data-utf16');
  await page.locator('.steps__item').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.steps__item')[1]?.getAttribute('aria-pressed') === 'true');
  assert.equal(await markers.first().getAttribute('aria-pressed'), 'true');
  assert.notEqual(await page.getByTestId('evidence-range').getAttribute('data-utf16'), firstEvidence);
  await markers.first().click();
  await page.waitForFunction(expected => document.querySelector('[data-testid="evidence-range"]')?.getAttribute('data-utf16') === expected, firstEvidence);
  assert.equal(await page.locator('.steps__item').first().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.files h3').innerText(), '파일 3개');
  assert.equal(await page.locator('.statusbar').count(), 0);
  assert.equal(await page.locator('.views__item').count(), 5);
  // The packaged reader colours syntax and takes keyboard focus, as in development.
  const reader = await page.evaluate(() => {
    const keyword = [...document.querySelectorAll('.cm-content span')].find(span => span.textContent === 'return');
    return { tabindex: document.querySelector('.cm-content')?.getAttribute('tabindex'),
      coloured: !!keyword && getComputedStyle(keyword).color !== getComputedStyle(document.querySelector('.cm-line')).color };
  });
  assert.deepEqual(reader, { tabindex: '0', coloured: true });
  // The search package is in the bundle too: Cmd+F from the code opens the Korean search panel.
  await page.locator('.cm-content').focus();
  await page.keyboard.press(readerKeys.find);
  assert.equal(await page.locator('.cm-search input[name="search"]').getAttribute('aria-label'), '찾기');
  await page.keyboard.press('Escape');
  await page.locator('.cm-search').waitFor({ state: 'detached' });
  assert.equal(await readFile(path.join(project, 'sample.ts'), 'utf8'), text);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.ok(csp.includes("connect-src 'none'"));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(profile, 'learning.sqlite'), { readOnly: true });
  // The plan-compare checks above open their own project too, so look for this one by its folder.
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects WHERE root = ?').get(project).n, 1);
  db.close();
  await page.screenshot({ path: path.join(root, 'test-results/packaged-code-flow.png') });
  // The TypeScript checker runs from outside the archive and reads the package's type file.
  await openFunctionFlow(page);
  assert.equal(await page.locator('.code-step-marker').count(), 0);
  await page.getByRole('button', { name: 'price.ts', exact: true }).click();
  await page.getByRole('button', { name: 'label', exact: true }).click();
  const summary = page.getByRole('article', { name: '함수 요약' });
  await summary.getByRole('region', { name: '돌려주는 값의 모양' }).getByText('string', { exact: true }).waitFor({ timeout: 30_000 });
  await summary.getByRole('group', { name: '바깥 이름' }).getByRole('button', { name: 'format', exact: true }).click();
  await summary.getByRole('region', { name: 'format 값' }).getByText('(amount: number) => string', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'test-results/packaged-value-shapes.png') });
  // The project map's library and its stylesheet are in the bundle and work under the packaged CSP.
  await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
  await page.getByRole('group', { name: '지도 종류', exact: true }).getByRole('button', { name: '파일 연결', exact: true }).click();
  // The map starts in the design view (folders); the file view draws the file-to-file arrow checked below.
  await page.getByRole('button', { name: '설계 보기', exact: true, pressed: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '파일 보기', exact: true }).click();
  // The one arrow runs straight down inside one folder, a box of zero width that Playwright calls hidden,
  // so the drawn path itself is checked.
  const arrow = page.locator('.react-flow__edge-path');
  await arrow.first().waitFor({ state: 'attached', timeout: 30_000 });
  // sample.ts, helper.ts and price.ts; price.ts imports only a package, which draws no arrow.
  assert.equal(await page.locator('.react-flow__node').count(), 3);
  assert.equal(await arrow.count(), 1);
  assert.match(await arrow.getAttribute('d'), /^M[\d.\s,-]+/);
  assert.equal(await page.locator('.react-flow__node').first().evaluate(node => getComputedStyle(node).position), 'absolute');
  await page.screenshot({ path: path.join(root, 'test-results/packaged-project-map.png') });
  // macOS runs git inside its sandbox; Windows explains that changes are not supported yet.
  await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
  if (onMac) {
    const changed = page.getByRole('region', { name: '바뀐 파일 목록' }).getByRole('list', { name: '바뀐 파일' });
    await changed.waitFor({ timeout: 30_000 });
    assert.deepEqual(await changed.locator('li').allInnerTexts(), ['수정 price.ts 비교 보기']);
  } else {
    await page.getByText('Windows에서는 아직 변경 보기를 쓸 수 없어요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('list', { name: '바뀐 파일', exact: true }).count(), 0);
  }
  const question = page.getByRole('banner').getByRole('button', { name: '질문', exact: true });
  if (await question.getAttribute('aria-pressed') === 'false') await question.click();
  await page.getByRole('textbox', { name: '선택한 코드에 질문', exact: true }).waitFor();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'AI 사용 방식' }).inputValue(), 'local-worker');
  await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
  await page.getByRole('list', { name: '로컬 AI 설치 상태' }).getByText(/^Claude Code ·/).waitFor({ timeout: 35_000 });
  // The version check runs inside the fence: a CLI installed in a fixed location must still show its version.
  const statuses = await page.getByRole('list', { name: '로컬 AI 설치 상태' }).innerText();
  const installed = binary => [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin']
    .some(folder => existsSync(path.join(folder, binary)));
  for (const [binary, name] of [['codex', 'Codex'], ['agy', 'Antigravity']]) {
    if (installed(binary)) assert.match(statuses, new RegExp(`${name} · 설치 확인 \\(\\d+\\.\\d+\\.\\d+`), `${name} version inside the fence`);
  }
  // Both workers found: the local worker is ready and states its known limits. Nothing is sent here:
  // the send button waits for consent, which this test never gives.
  const ready = /Codex · 설치 확인/.test(statuses) && /Antigravity · 설치 확인/.test(statuses);
  assert.match(await page.getByTestId('ai-readiness').innerText(), ready ? /질문을 보낼 수 있어요\. 알려진 한계/ : /Codex와 Antigravity가 둘 다 필요해요/);
  assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
  const consent = page.locator('.ai-panel').getByRole('checkbox', { name: '보낼 자료에 동의', exact: true });
  const disclosure = page.locator('.ai-panel .consent-details');
  const description = disclosure.locator('p');
  assert.equal(await disclosure.evaluate(element => element.open), false);
  assert.equal(await description.isVisible(), false);
  assert.equal(await consent.isChecked(), false);
  assert.equal(await consent.getAttribute('aria-describedby'), await description.getAttribute('id'));
  await disclosure.locator('summary').click();
  assert.equal(await description.isVisible(), true);
  assert.equal(await description.innerText(), '선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·관련 파일(추가 최대 4개)·질문·최근 답변을 Codex와 Gemini에 보내는 데 동의합니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.');
  await disclosure.locator('summary').click();
  assert.equal(await description.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'test-results/packaged-local-ai.png') });
  await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
  const cancellation = page.getByRole('status').filter({ hasText: '프로젝트를 닫았어요.' });
  await cancellation.waitFor();
  assert.equal(await cancellation.innerText(), '프로젝트를 닫았어요.');
  assert.match(await cancellation.getAttribute('class'), /(?:^|\s)notice--info(?:\s|$)/);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.locator('.files h3').count(), 0);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, treeFixture);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('heading', { name: '폴더 트리 프로젝트', exact: true }).waitFor();
  await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  const files = page.getByRole('region', { name: '파일 목록', exact: true });
  const api = files.getByRole('button', { name: '폴더 api', exact: true });
  const src = files.getByRole('button', { name: '폴더 api/src', exact: true });
  const main = files.getByRole('button', { name: 'api/src/main.ts', exact: true });
  const helper = files.getByRole('button', { name: 'api/test/helper.ts', exact: true });
  const search = page.getByRole('searchbox', { name: '파일명 검색', exact: true });
  assert.equal(await files.getByRole('button', { name: 'root.ts', exact: true }).isVisible(), true);
  assert.equal(await api.getAttribute('aria-expanded'), 'false');
  assert.equal(await main.isVisible(), false);
  await api.focus();
  await api.press('Enter');
  assert.equal(await api.getAttribute('aria-expanded'), 'true');
  const controlled = await api.getAttribute('aria-controls');
  assert.equal(await page.locator(`[id="${controlled}"]`).isVisible(), true);
  assert.equal(await src.getAttribute('aria-expanded'), 'false');
  await src.click();
  assert.equal(await main.isVisible(), true);
  assert.equal(await main.innerText(), 'main.ts');
  assert.equal(await main.getAttribute('title'), 'api/src/main.ts');
  await api.click();
  // Searching opens only matching ancestors and does not change the saved disclosure state.
  await search.fill('HELPER');
  assert.equal(await helper.isVisible(), true);
  assert.equal(await main.isVisible(), false);
  assert.equal(await files.getByRole('button', { name: /^폴더 / }).count(), 0);
  assert.deepEqual(await files.locator('.files__folder').allTextContents(), ['▾ api', '▾ test']);
  await search.fill('');
  assert.equal(await api.getAttribute('aria-expanded'), 'false');
  assert.equal(await helper.isVisible(), false);
  await search.fill('no-such-file');
  await files.getByText('검색과 일치하는 파일이 없어요.', { exact: true }).waitFor();
  // Opening from search, including reading the same file again, expands its ancestors permanently.
  for (let attempt = 0; attempt < 2; attempt++) {
    await search.fill('MAIN.TS');
    await main.click();
    await page.getByRole('heading', { name: 'api/src/main.ts', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('.files button[aria-label="api/src/main.ts"]');
      return button?.getAttribute('aria-current') === 'true' && !button.disabled;
    });
    await search.fill('');
    await main.waitFor({ state: 'visible' });
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    assert.equal(await src.getAttribute('aria-expanded'), 'true');
    assert.equal(await main.getAttribute('aria-current'), 'true');
    await api.click();
    assert.equal(await main.isVisible(), false);
  }
  // The flow symbol opens evidence through showEvidence, without going through readFile.
  await openFunctionFlow(page);
  await page.getByRole('button', { name: 'nested', exact: true }).click();
  await page.getByRole('article', { name: '함수 요약', exact: true }).waitFor();
  await main.waitFor({ state: 'visible' });
  assert.equal(await main.getAttribute('aria-current'), 'true');
  assert.equal(await api.getAttribute('aria-expanded'), 'true');
  assert.equal(await src.getAttribute('aria-expanded'), 'true');
  // Reopening even the same project clears the disclosure state.
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.views__item[aria-current="page"]')?.textContent === '한눈에 보기');
  await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.files button[aria-label="폴더 api"]')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await main.isVisible(), false);
  // Screen-based feature selection uses the precomputed flow in the packaged renderer too.
  const screenFixture = path.join(temp, '화면 묶기');
  const screenFiles = {
    'web/next.config.ts': 'export default {};',
    'web/app/login/page.tsx': "export default function LoginPage() { const submit = () => fetch('/login', {method:'POST'}); return <form onSubmit={submit}><button>로그인</button></form>; }",
    'api/controller.ts': "@Controller('login') class LoginController { @Post() login() {} }",
  };
  for (const [name, text] of Object.entries(screenFiles)) {
    await mkdir(path.dirname(path.join(screenFixture, name)), { recursive: true });
    await writeFile(path.join(screenFixture, name), text);
  }
  await app.evaluate(({ dialog, ipcMain }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    const original = ipcMain._invokeHandlers.get('learning:feature-flow');
    globalThis.packagedFlowCalls = 0;
    ipcMain._invokeHandlers.set('learning:feature-flow', (...args) => { globalThis.packagedFlowCalls++; return original(...args); });
  }, screenFixture);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByText('화면별로 보기', { exact: true }).click();
  const screen = page.getByRole('region', { name: '화면 /login', exact: true });
  await screen.waitFor();
  await page.screenshot({ path: path.join(root, 'test-results/packaged-screen-groups.png') });
  await screen.getByRole('listitem').filter({ hasText: 'POST /login' }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
  await page.getByRole('region', { name: '기능 따라가기', exact: true }).getByText('화면 /login에서 입력 양식을 보내면 시작해요', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.packagedFlowCalls), 0);
  await app.close(); app = undefined;
  const report = { passed: true, checks: ['screen groups and cached flow selection without flow IPC', 'system light and dark themes, navigation rail and factual project status', 'packaged app startup', 'file tree disclosures, search, same-file reread, flow evidence and reopening', 'isolated SQLite write/read', 'native parser in packaged worker', 'code evidence navigation', 'reader colours and keyboard focus', 'reader search panel', 'source unchanged', 'packaged CSP', 'project map under the packaged CSP', 'value shapes from the unpacked TypeScript checker with a package type file', onMac ? 'changes from git inside its sandbox' : 'Windows changes unavailable notice', 'local AI installation inspection inside the fence and execution gate (no AI request)', 'cancel'], state };
  await writeFile(path.join(root, 'test-results/packaged-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  await writeFile(path.join(root, 'test-results/packaged-smoke.json'), JSON.stringify({ passed: false, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
