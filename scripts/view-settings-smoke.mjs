import assert from 'node:assert/strict';

// Shared by development and packaged smoke tests. These checks never request AI.
export async function checkViewSettings(app, page, restart) {
  // These spies cover only requests after installation. The main unit test covers app startup.
  // The development smoke starts Electron with a script entry, so app.getVersion() reports Electron's version there;
  // the fake release is always one major version above whatever the app reports.
  const { current, latest } = await app.evaluate(({ app, net, shell }) => {
    const calls = { requests: [], opened: [] };
    const current = app.getVersion();
    const latest = `${Number(current.split('.')[0]) + 1}.0.0`;
    globalThis.__updateCheckSmoke = calls;
    net.fetch = async (url, init) => {
      calls.requests.push({ url, method: init.method, credentials: init.credentials });
      return new Response(JSON.stringify({ tag_name: `v${latest}`, html_url: 'https://untrusted.example/' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    shell.openExternal = async url => { calls.opened.push(url); };
    return { current, latest };
  });
  const button = page.getByRole('button', { name: '앱 설정', exact: true });
  await button.focus();
  await button.press('Enter');
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await app.evaluate(() => globalThis.__updateCheckSmoke), { requests: [], opened: [] });
  await page.getByRole('button', { name: '새 버전 확인', exact: true }).click();
  await page.getByRole('status').filter({ hasText: `새 버전 ${latest}이 있어요. 지금은 ${current}예요.` }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.__updateCheckSmoke.requests), [{
    url: 'https://api.github.com/repos/ckdgus222/code-learning/releases/latest', method: 'GET', credentials: 'omit',
  }]);
  assert.deepEqual(await app.evaluate(() => globalThis.__updateCheckSmoke.opened), []);
  await page.getByRole('button', { name: '내려받기 페이지 열기', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.__updateCheckSmoke.opened), [
    'https://github.com/ckdgus222/code-learning/releases/latest',
  ]);
  assert.equal(await page.getByRole('group', { name: '화면', exact: true }).getByRole('radio').count(), 3);
  assert.equal(await page.getByRole('group', { name: '코드 색', exact: true }).getByRole('radio').count(), 2);
  await page.waitForFunction(() => document.querySelector('input[value="system"]')?.checked === true);
  assert.equal(await page.getByRole('radio', { name: '기본', exact: true }).isChecked(), true);
  const invalid = await page.evaluate(() => window.learning.setViewSettings({ screen: 'invalid', codeColors: 'contrast' }));
  assert.equal(invalid.code, 'INVALID_REQUEST');
  await page.getByRole('radio', { name: '어둡게', exact: true }).check();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(10, 20, 34)'
    && document.querySelector('#view-settings')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('radio', { name: '기본', exact: true }).focus();
  await page.getByRole('radio', { name: '기본', exact: true }).press('ArrowDown');
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'contrast');
  assert.equal(await page.getByRole('radio', { name: '고대비', exact: true }).isChecked(), true);
  // Saving must preserve radio focus so the next arrow key still changes the group.
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'default');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'contrast');
  await page.keyboard.press('Escape');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(await button.evaluate(element => element === document.activeElement), true);

  ({ app, page } = await restart());
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'contrast'
    && getComputedStyle(document.documentElement).backgroundColor === 'rgb(10, 20, 34)');
  assert.deepEqual(await page.evaluate(() => window.learning.getViewSettings()), {
    ok: true, value: { screen: 'dark', codeColors: 'contrast' },
  });
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  // Electron does not report additionalArguments back; tests/view-settings-main.test.ts checks that the window gets
  // --code-colors=contrast and tests/view-settings-preload.test.ts that the preload applies it before the page runs.
  await page.getByRole('button', { name: '앱 설정', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: '어둡게', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('radio', { name: '고대비', exact: true }).isChecked(), true);
  await page.getByRole('radio', { name: '시스템 따라가기', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('#view-settings')?.getAttribute('aria-busy') === 'false');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  await page.getByRole('radio', { name: '기본', exact: true }).check();
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'default');
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '앱 설정', exact: true }).getAttribute('aria-expanded'), 'false');
  return { app, page };
}

export async function checkCodeColors(page) {
  await page.getByRole('button', { name: '앱 설정', exact: true }).click();
  for (const [screen, label, codeColors, colorLabel, keyword, ink] of [
    ['light', '밝게', 'default', '기본', 'rgb(194, 24, 91)', 'rgb(36, 41, 47)'],
    ['light', '밝게', 'contrast', '고대비', 'rgb(161, 0, 74)', 'rgb(11, 15, 20)'],
    ['dark', '어둡게', 'default', '기본', 'rgb(255, 122, 178)', 'rgb(212, 220, 232)'],
    ['dark', '어둡게', 'contrast', '고대비', 'rgb(255, 154, 203)', 'rgb(255, 255, 255)'],
  ]) {
    await page.getByRole('radio', { name: label, exact: true }).check();
    await page.waitForFunction(() => document.querySelector('#view-settings')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('radio', { name: colorLabel, exact: true }).check();
    await page.waitForFunction(({ screen, codeColors, keyword, ink }) => {
      const token = [...document.querySelectorAll('.cm-content span')].find(span => span.textContent === 'return');
      const line = document.querySelector('.cm-line');
      return matchMedia(`(prefers-color-scheme: ${screen})`).matches
        && document.documentElement.dataset.codeColors === codeColors
        && token && getComputedStyle(token).color === keyword && line && getComputedStyle(line).color === ink;
    }, { screen, codeColors, keyword, ink });
  }
  await page.getByRole('radio', { name: '시스템 따라가기', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('#view-settings')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('radio', { name: '기본', exact: true }).check();
  await page.waitForFunction(() => document.documentElement.dataset.codeColors === 'default');
  await page.keyboard.press('Escape');
}
