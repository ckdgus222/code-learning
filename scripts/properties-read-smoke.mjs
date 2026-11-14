import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkPropertiesRead(app, page, folder) {
  await mkdir(folder, { recursive: true });
  const source = '\uFEFF# 설정 😀\r\nserver.servlet.context-path=/api\r\nmessage=Hello World\r\n';
  await writeFile(path.join(folder, 'application.properties'), source);
  await writeFile(path.join(folder, 'application-secrets.properties'), 'password=fake-secret-only\n');
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    globalThis.restorePropertiesDialog = () => { dialog.showOpenDialog = original; delete globalThis.restorePropertiesDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'application.properties', exact: true }).click();
    await page.getByRole('heading', { name: 'application.properties', exact: true }).waitFor();
    await page.locator('.cm-content').getByText('server.servlet.context-path=/api', { exact: true }).waitFor();
    await page.getByText('이 파일은 원문만 표시합니다. 현재 구문 분석은 TypeScript, JavaScript, Python만 지원합니다.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'application-secrets.properties', exact: true }).count(), 0);
    assert.equal(await page.getByText('fake-secret-only', { exact: false }).count(), 0);
    assert.equal(await readFile(path.join(folder, 'application.properties'), 'utf8'), source);
  } finally {
    await app.evaluate(() => globalThis.restorePropertiesDialog?.());
  }
}
