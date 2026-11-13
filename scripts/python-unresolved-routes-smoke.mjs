import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Unknown handlers have declaration evidence, never fabricated function or request targets. */
export async function checkPythonUnresolvedRoutes(app, page, folder) {
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'urls.py');
  const original = 'from django.urls import path\nfrom django.conf.urls.static import static\nfrom external.views import ExternalView\nurlpatterns = [path("unknown/", ExternalView.as_view())]\nurlpatterns += static("/assets/")\n';
  await writeFile(file, original);
  await app.evaluate(({ dialog }, folder) => {
    const open = dialog.showOpenDialog;
    globalThis.restoreUnresolvedRoutesDialog = () => { dialog.showOpenDialog = open; delete globalThis.restoreUnresolvedRoutesDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    const list = page.getByRole('region', { name: '처리 함수를 확인하지 못한 주소', exact: true });
    await list.waitFor();
    await page.getByText('주소 선언은 찾았지만 처리 함수를 확인하지 못해 기능 흐름을 만들지 않았어요.', { exact: false }).waitFor();
    assert.equal(await list.getByRole('listitem').count(), 2);
    assert.equal(await page.getByRole('button', { name: '이 기능부터 따라가기', exact: true }).count(), 0);
    assert.equal(await list.getByRole('button', { name: '이 기능 따라가기', exact: true }).count(), 0);
    await list.getByRole('listitem').filter({ hasText: '/unknown/' }).getByRole('button', { name: '주소 선언 코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: urls.py · 4–4줄', { exact: true }).waitFor();
    assert.equal(await readFile(file, 'utf8'), original);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await list.getByRole('listitem').filter({ hasText: '/assets/' }).getByRole('button', { name: '주소 선언 코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: urls.py · 5–5줄', { exact: true }).waitFor();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    const changed = '# changed\n' + original;
    await writeFile(file, changed);
    await list.getByRole('button', { name: '주소 선언 코드 보기', exact: true }).first().and(page.locator(':disabled')).waitFor();
    await page.getByRole('button', { name: '다시 찾기', exact: true }).click();
    const updated = list.getByRole('listitem').filter({ hasText: '/unknown/' }).getByRole('button', { name: '주소 선언 코드 보기', exact: true });
    await updated.and(page.locator(':enabled')).waitFor();
    await updated.click();
    await page.getByTestId('evidence-range').getByText('근거: urls.py · 5–5줄', { exact: true }).waitFor();
    assert.equal(await readFile(file, 'utf8'), changed);
  } finally {
    await app.evaluate(() => globalThis.restoreUnresolvedRoutesDialog?.());
  }
}
