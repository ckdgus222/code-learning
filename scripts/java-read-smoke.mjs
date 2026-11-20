import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Opens a one-file Java project and checks outlines, colours, a step and the scope notices. `openFile` shows a file of the tree. */
export async function checkJavaRead(app, page, folder, openFile) {
  await mkdir(folder, { recursive: true });
  const source = 'import java.util.List;\nclass Order { int total(int value) { if (value > 0) return value; return 0; } }';
  await writeFile(path.join(folder, 'Order.java'), source);
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    globalThis.restoreJavaDialog = () => { dialog.showOpenDialog = original; delete globalThis.restoreJavaDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await openFile('Order.java');
    await page.getByRole('heading', { name: '클래스 1개', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Order', exact: true }).click();
    await page.getByRole('button', { name: 'Order', exact: true, pressed: true }).waitFor();
    await page.getByText('import 1개', { exact: true }).click();
    await page.getByRole('button', { name: 'import java.util.List;', exact: true }).click();
    await page.getByRole('button', { name: 'import java.util.List;', exact: true, pressed: true }).waitFor();
    await page.getByRole('button', { name: 'Order.total', exact: true }).click();
    await page.getByText('부르는 곳·값 찾기는 아직 Java를 지원하지 않아요. 단계는 ‘이 함수 흐름으로 보기’에서 하나씩 볼 수 있어요.', { exact: true }).waitFor();
    await page.getByRole('region', { name: '구문과 코드', exact: true }).getByText('Java는 메서드·생성자 목록, 클래스·import 목록, 구문 단계, 코드 색상, Spring 주소를 보여 줘요. 부르는 곳·값 찾기, 파일 안내, AI 파일 설명, 프로젝트 지도는 아직 지원하지 않아요.', { exact: true }).waitFor();
    assert.equal(await page.getByText('AI로 이 파일 설명 만들기', { exact: true }).count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content .cm-line span')].some(span =>
      getComputedStyle(span).color !== getComputedStyle(span.closest('.cm-content')).color));
    await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
    await page.getByText('부르는 것·부르는 곳·값 찾기는 아직 Java를 지원하지 않아요. 위 단계 목록에서 하나씩 볼 수 있어요.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    await page.getByRole('region', { name: '현재 위치', exact: true }).getByText('value > 0', { exact: true }).waitFor();
    assert.equal(await readFile(path.join(folder, 'Order.java'), 'utf8'), source);
  } finally {
    await app.evaluate(() => globalThis.restoreJavaDialog?.());
  }
}

/** Verifies the YAML dependency and Boot prefix through real project scanning and the flow UI. */
export async function checkSpringBootFlow(app, page, folder) {
  const sources = {
    'src/main/java/example/Application.java': 'import org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\nclass Application {}',
    'src/main/java/example/OrderController.java': 'import org.springframework.web.bind.annotation.*;\n@RestController\nclass OrderController {\n@GetMapping("/orders")\nString orders() { return helper(); }\nString helper() { return "ok"; }\n}',
    'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /api\nspring:\n  mvc:\n    servlet:\n      path: /v1\n',
    'web/api.ts': "export function loadOrders() { return fetch('/api/v1/orders'); }",
  };
  for (const [name, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), source);
  }
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    globalThis.restoreBootDialog = () => { dialog.showOpenDialog = original; delete globalThis.restoreBootDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    const list = page.getByRole('region', { name: '기능 목록', exact: true });
    await list.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
    await list.getByRole('status').filter({ hasText: '화면별로 묶는 중' }).waitFor({ state: 'detached', timeout: 30_000 });
    const server = list.locator('details').filter({ has: page.locator('summary', { hasText: /^서버 주소 기준 목록 \(AI 정리 포함\)$/ }) });
    if (await server.count() && !await server.evaluate(element => element.open)) await server.locator(':scope > summary').click();
    await list.getByRole('listitem').filter({ has: page.getByText('보기 · /api/v1/orders', { exact: true }) })
      .getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^전체 그림과 단계 보기$/ }) });
    await details.waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    const diagram = page.getByTestId('feature-flow-canvas');
    await diagram.getByRole('group', { name: 'web/api.ts · loadOrders', exact: true }).waitFor();
    await diagram.getByRole('group', { name: 'web/api.ts · GET /api/v1/orders', exact: true }).waitFor();
    await diagram.getByRole('group', { name: 'src/main/java/example/OrderController.java · OrderController.orders', exact: true }).waitFor();
    assert.equal(await diagram.getByRole('group', { name: 'src/main/java/example/OrderController.java · OrderController.helper', exact: true }).count(), 0);
    const steps = page.getByRole('region', { name: '기능 흐름 단계', exact: true }).getByTestId('feature-step');
    const request = steps.filter({ has: page.locator('b', { hasText: /^GET \/api\/v1\/orders$/ }) });
    await request.waitFor();
    assert.equal(await request.getByText('추정', { exact: true }).count(), 0);
    assert.doesNotMatch(await request.innerText(), /앞부분 모름/);
    await steps.filter({ has: page.locator('b', { hasText: /^OrderController\.orders$/ }) })
      .getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: src/main/java/example/OrderController.java · 4–5줄', { exact: true }).waitFor();
    for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(path.join(folder, name), 'utf8'), source);
  } finally {
    await app.evaluate(() => globalThis.restoreBootDialog?.());
  }
}
