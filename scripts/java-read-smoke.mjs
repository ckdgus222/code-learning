import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Opens a one-file Java project and checks methods, colours, a step and the scope notices. `openFile` shows a file of the tree. */
export async function checkJavaRead(app, page, folder, openFile) {
  await mkdir(folder, { recursive: true });
  const source = 'class Order { int total(int value) { if (value > 0) return value; return 0; } }';
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
    await page.getByRole('button', { name: 'Order.total', exact: true }).click();
    await page.getByText('부르는 곳·값 찾기는 아직 Java를 지원하지 않아요. 단계는 ‘이 함수 흐름으로 보기’에서 하나씩 볼 수 있어요.', { exact: true }).waitFor();
    await page.getByRole('region', { name: '구문과 코드', exact: true }).getByText('Java는 메서드·생성자 목록, 구문 단계, 코드 색상만 보여 줘요. 부르는 곳·값 찾기, 파일 안내, AI 파일 설명, 프로젝트 지도, 서버 주소는 아직 지원하지 않아요.', { exact: true }).waitFor();
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
