import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp('/private/tmp/code-learning-package-');
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
let app;
try {
  app = await electron.launch({
    executablePath: path.join(root, 'out/Code Learning-darwin-arm64/Code Learning.app/Contents/MacOS/Code Learning'),
    args: [`--user-data-dir=${profile}`], chromiumSandbox: true, timeout: 30_000,
  });
  const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), versions: process.versions }));
  assert.equal(state.packaged, true);
  assert.equal(state.userData, profile, 'Packaged test must use isolated userData');
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).waitFor();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('button', { name: 'sample.ts', exact: true }).click();
  await page.getByRole('button', { name: 'packaged', exact: true }).click();
  await page.getByRole('button', { name: '조건 확인', exact: true }).click();
  await page.getByTestId('evidence-range').waitFor();
  // The packaged reader colours syntax and takes keyboard focus, as in development.
  const reader = await page.evaluate(() => {
    const keyword = [...document.querySelectorAll('.cm-content span')].find(span => span.textContent === 'return');
    return { tabindex: document.querySelector('.cm-content')?.getAttribute('tabindex'),
      coloured: !!keyword && getComputedStyle(keyword).color !== getComputedStyle(document.querySelector('.cm-line')).color };
  });
  assert.deepEqual(reader, { tabindex: '0', coloured: true });
  // The search package is in the bundle too: Cmd+F from the code opens the Korean search panel.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Meta+f');
  assert.equal(await page.locator('.cm-search input[name="search"]').getAttribute('aria-label'), '찾기');
  await page.keyboard.press('Escape');
  await page.locator('.cm-search').waitFor({ state: 'detached' });
  assert.equal(await readFile(path.join(project, 'sample.ts'), 'utf8'), text);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.ok(csp.includes("connect-src 'none'"));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(profile, 'learning.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n, 1);
  db.close();
  await page.screenshot({ path: path.join(root, 'test-results/packaged-code-flow.png') });
  // The TypeScript checker runs from outside the archive and reads the package's type file.
  await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
  await page.getByRole('button', { name: 'price.ts', exact: true }).click();
  await page.getByRole('button', { name: 'label', exact: true }).click();
  const summary = page.getByRole('article', { name: '함수 요약' });
  await summary.getByRole('region', { name: '돌려주는 값의 모양' }).getByText('string', { exact: true }).waitFor({ timeout: 30_000 });
  await summary.getByRole('group', { name: '바깥 이름' }).getByRole('button', { name: 'format', exact: true }).click();
  await summary.getByRole('region', { name: 'format 값' }).getByText('(amount: number) => string', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'test-results/packaged-value-shapes.png') });
  // The project map's library and its stylesheet are in the bundle and work under the packaged CSP.
  await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
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
  await page.getByRole('tab', { name: '질문', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'AI 사용 방식' }).inputValue(), 'local-worker');
  await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
  await page.getByRole('list', { name: '로컬 AI 설치 상태' }).waitFor({ timeout: 35_000 });
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
  await page.screenshot({ path: path.join(root, 'test-results/packaged-local-ai.png') });
  await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
  const cancellation = page.getByRole('status').filter({ hasText: '작업을 취소했습니다.' });
  await cancellation.waitFor();
  assert.equal(await cancellation.innerText(), '작업을 취소했습니다.');
  assert.match(await cancellation.getAttribute('class'), /(?:^|\s)notice--info(?:\s|$)/);
  assert.equal(await page.getByRole('alert').count(), 0);
  await app.close(); app = undefined;
  const report = { passed: true, checks: ['packaged app startup', 'isolated SQLite write/read', 'native parser in packaged worker', 'code evidence navigation', 'reader colours and keyboard focus', 'reader search panel', 'source unchanged', 'packaged CSP', 'project map under the packaged CSP', 'value shapes from the unpacked TypeScript checker with a package type file', 'local AI installation inspection inside the fence and execution gate (no AI request)', 'cancel'], state };
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
