import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
    const channels = ['learning:explain', 'learning:overview', 'learning:feature-guide', 'learning:file-explanation'];
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
    assert.equal(await card.getByRole('checkbox').count(), 0);
    assert.equal(await card.getByRole('button', { name: '대조하기', exact: true }).count(), 0);

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
    // The checks that follow start from the welcome screen, so leave the app as it was found.
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
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
