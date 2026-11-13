import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Real route and call analysis; Python fixture text is never executed. */
export async function checkPythonFeatureFlow(app, page, folder) {
  const sources = {
    'manage.py': '',
    'site/__init__.py': '',
    'site/settings.py': 'ROOT_URLCONF = "site.urls"\n',
    'site/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/", views.handle)]\n',
    'site/views.py': '# 한국어 😀\ndef handle(request):\n    return helper(1)\ndef helper(value):\n    return value\n',
    'client.ts': 'export function load() { return fetch("/users/"); }\n',
  };
  for (const [name, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), source);
  }
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    globalThis.restorePythonFlowDialog = () => { dialog.showOpenDialog = original; delete globalThis.restorePythonFlowDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    const list = page.getByRole('region', { name: '기능 목록', exact: true });
    await list.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
    const server = list.locator('details').filter({ has: page.locator('summary', { hasText: /^서버 주소 기준 목록 \(AI 정리 포함\)$/ }) });
    await list.getByRole('status').filter({ hasText: '화면별로 묶는 중' }).waitFor({ state: 'detached', timeout: 30_000 });
    if (await server.count() && !await server.evaluate(element => element.open)) await server.locator(':scope > summary').click();
    await list.getByRole('listitem')
      .filter({ hasText: '받기 · /users/' }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^전체 그림과 단계 보기$/ }) });
    await details.waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    const diagram = page.getByTestId('feature-flow-canvas');
    await diagram.getByRole('group', { name: 'site/views.py · handle', exact: true }).waitFor();
    await diagram.getByRole('group', { name: 'site/views.py · helper', exact: true }).waitFor();
    const steps = page.getByRole('region', { name: '기능 흐름 단계', exact: true }).getByTestId('feature-step');
    const handler = steps.filter({ has: page.locator('b', { hasText: /^handle$/ }) });
    await handler.getByText('추정', { exact: true }).waitFor();
    await handler.getByText('같은 파일의 함수 선언 후보예요. 함수나 모듈이 다른 코드로 전달되어 실제 호출 대상은 확정하지 못했어요.', { exact: false }).waitFor();
    const step = steps
      .filter({ has: page.locator('b', { hasText: /^helper$/ }) });
    await step.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: site/views.py · 4–5줄', { exact: true }).waitFor();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await step.getByRole('button', { name: '이 함수 흐름', exact: true }).click();
    await page.getByRole('heading', { name: '함수 안 순서', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '함수와 단계', exact: true }).getByRole('button', { name: 'helper', exact: true })
      .and(page.locator('[aria-pressed="true"]')).waitFor();
    assert.equal(await page.getByRole('list', { name: '이 함수를 부르는 곳', exact: true }).count(), 0);
    for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(path.join(folder, name), 'utf8'), source);
  } finally {
    await app.evaluate(() => globalThis.restorePythonFlowDialog?.());
  }
}
