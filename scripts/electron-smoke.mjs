import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
// A plain JavaScript file for the reader's colours; not a start-candidate name.
// Its comment line is long so wrapping can be seen; the line count and first line stay as the key checks expect.
await writeFile(path.join(fixture, 'helper.js'), 'export function greet(name) {\n  // 인사' + ' 줄바꿈 시험용 긴 주석'.repeat(20) + '\n  return "안녕 " + name;\n}\n');
await writeFile(path.join(fixture, '.env'), 'TEST_NOT_A_REAL_SECRET=canary');
await writeFile(path.join(fixture, 'auth.json'), '{"test":"not-real-auth"}');
await writeFile(path.join(fixture, 'README.md'), '# 주문 예제\n\n주문 수량을 확인하는 작은 시험 자료입니다.\n\n<script>globalThis.attacked=true</script> ![x](https://example.com/test)');
await writeFile(path.join(second, 'other.ts'), 'export function other() { return 2; }');
// The project map: ui uses store twice and shared once, store uses ui once and shared once, and ui uses itself.
// A folder 21 levels deep stops the folder scan at its depth limit without reaching the map's own limits.
const mapFixture = path.join(temporary, '지도 프로젝트');
const mapFiles = {
  'ui/app.ts': "import { save } from '../store/save';\nimport { format } from '../shared/format';\nimport React from 'react';\nconst lazy = import('./lazy');\nexport const app = 1;\n",
  'ui/view.ts': "import { load } from '../store/load';\nimport { app } from './app';\nexport const view = 1;\n",
  'store/save.ts': "import { format } from '../shared/format';\nexport const save = 1;\n",
  'store/load.ts': "import { view } from '../ui/view';\nexport const load = 2;\n",
  'shared/format.ts': 'export const format = 3;\n',
  [`${Array.from({ length: 21 }, (_, index) => `d${index + 1}`).join('/')}/deep.ts`]: 'export const deep = 1;\n',
};
for (const [name, text] of Object.entries(mapFiles)) {
  await mkdir(path.dirname(path.join(mapFixture, name)), { recursive: true });
  await writeFile(path.join(mapFixture, name), text);
}
// 65 code files of about 100 KB in five folders: more than 60, so the map starts folded, and slow enough
// to parse that a cancel lands while Tree-sitter is working.
const bigMapFixture = path.join(temporary, '큰 지도 프로젝트');
const bigBody = 'export function step(x: number) { if (x > 1) { return x + 1; } return 0; }\n'.repeat(1300);
for (let index = 0; index < 65; index++) {
  const folder = `part${index % 5}`;
  await mkdir(path.join(bigMapFixture, folder), { recursive: true });
  await writeFile(path.join(bigMapFixture, folder, `file${index}.ts`), `import { step } from '../part${(index + 1) % 5}/file${(index + 1) % 65}';\n${bigBody}`);
}
// Plan G1: a feature to follow, two methods of one name, and a source file that is no start candidate.
const featureFixture = path.join(temporary, '기능 프로젝트');
const featureFiles = {
  'README.md': '# 배너 관리\n\n배너를 등록하고 목록을 보여 줍니다.\n',
  'banner.ts': 'export function registerBanner(title: string) {\n  return save(title);\n}\nexport function listBanners() {\n  return [];\n}\nfunction save(title: string) {\n  return { title };\n}\n',
  'dup.ts': 'class First {\n  run() { return 1; }\n}\nclass Second {\n  run() { return 2; }\n}\nexport function helper() {\n  return new First().run() + new Second().run();\n}\nfunction notify() {\n  helper()\n}\n',
  'settings.ts': 'const limit = 3;\n',
};
await mkdir(featureFixture);
for (const [name, text] of Object.entries(featureFiles)) await writeFile(path.join(featureFixture, name), text);
// Plan v2.3 C-1: one function of 61 code lines (over the limit of 60) next to a short one.
const hardFixture = path.join(temporary, '어려운 코드 프로젝트');
const hardSource = `export function short() { return 1; }\n\nexport function long() {\n  if (ready()) {\n    step(0);\n  }\n${
  Array.from({ length: 59 }, (_, index) => `  step(${index + 1});`).join('\n')}\n}\n`;
await mkdir(path.join(hardFixture, 'src'), { recursive: true });
await writeFile(path.join(hardFixture, 'src/work.ts'), hardSource);
// Plan v2.3 F: placeOrder calls check (same file), save (imported) and a member call; quick's arrow body is a call.
const callsFixture = path.join(temporary, '호출 프로젝트');
await mkdir(path.join(callsFixture, 'src'), { recursive: true });
await writeFile(path.join(callsFixture, 'src/app.ts'), "import { save } from './store';\nexport function placeOrder(order: string) {\n  check(order);\n  save(order);\n  log.info(order);\n}\nfunction check(order: string) { return order.length > 0; }\nexport const quick = () => save('q');\nexport function withDefault(x = check('d')) { return x; }\n");
await writeFile(path.join(callsFixture, 'src/store.ts'), 'export function save(order: string) {\n  return order;\n}\n');
// Plan v2.3 V-1: price takes two values, keeps one name inside and uses two from outside; shop and a test call it.
const valuesFixture = path.join(temporary, '값 프로젝트');
await mkdir(path.join(valuesFixture, 'src'), { recursive: true });
await writeFile(path.join(valuesFixture, 'src/price.ts'), 'const RATE = 0.1;\nlet total = 0;\nexport function price(amount: number, qty = 1) {\n  let sum = amount * qty;\n  sum = sum + sum * RATE;\n  total = total + sum;\n  return sum;\n}\n');
await writeFile(path.join(valuesFixture, 'src/shop.ts'), "import { price } from './price';\nexport function buy() { return price(100, 2); }\n");
await writeFile(path.join(valuesFixture, 'src/price.test.ts'), "import { price } from './price';\nprice(5);\n");
// Plan v2.3 V-2: a package with only a type file, which the TypeScript checker may read.
await mkdir(path.join(valuesFixture, 'node_modules/money'), { recursive: true });
await writeFile(path.join(valuesFixture, 'node_modules/money/package.json'), JSON.stringify({ name: 'money', types: 'index.d.ts' }));
await writeFile(path.join(valuesFixture, 'node_modules/money/index.d.ts'), 'export declare function format(amount: number): string;\n');
await writeFile(path.join(valuesFixture, 'src/label.ts'), "import { format } from 'money';\nexport function label(amount: number) { return format(amount); }\n");
// Plan v2.3 C-2: a Git repository whose files changed after its one commit in all five ways. The test's own git uses no user config.
const gitFixture = path.join(temporary, '변경 프로젝트');
await mkdir(path.join(gitFixture, 'src'), { recursive: true });
const gitHere = (...args) => execFileSync('git', args, { cwd: gitFixture, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
gitHere('init', '-q');
for (const [name, text] of [['edit.ts', 'export const edit = 1;\n'], ['deleted.ts', 'export const gone = 1;\n'], ['old-name.ts', 'export const moved = 1;\n'],
  ['func.ts', 'export function run(x: number) {\n  if (x > 1) return x;\n  return 0;\n}\n']]) {
  await writeFile(path.join(gitFixture, 'src', name), text);
}
gitHere('add', '-A');
gitHere('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'first version');
await writeFile(path.join(gitFixture, 'src/edit.ts'), 'export const edit = 2;\n');
await rm(path.join(gitFixture, 'src/deleted.ts'));
gitHere('mv', 'src/old-name.ts', 'src/new-name.ts');
await writeFile(path.join(gitFixture, 'src/added.ts'), 'export const added = 1;\n');
gitHere('add', 'src/added.ts');
await writeFile(path.join(gitFixture, 'src/untracked.ts'), 'export const fresh = 1;\n');
// Many changes, and a file whose old version is over the read limit while the new one is not.
const manyFixture = path.join(temporary, '많은 변경 프로젝트');
await mkdir(manyFixture, { recursive: true });
const gitMany = (...args) => execFileSync('git', args, { cwd: manyFixture, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
gitMany('init', '-q');
await writeFile(path.join(manyFixture, 'big.txt'), 'x'.repeat(300 * 1024));
gitMany('add', '-A');
gitMany('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'big');
await writeFile(path.join(manyFixture, 'big.txt'), 'small now\n');
for (let index = 0; index < 301; index++) await writeFile(path.join(manyFixture, `new${String(index).padStart(3, '0')}.txt`), `${index}\n`);
// Test harness lives outside the shipped app. Production IPC has no path injection/test API.
const bootstrap = path.join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(root, '.vite/build/main.cjs'))});\n`);
let app;
let page;
const checks = [];
const failures = [];
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
// One write can send a second change notice after the map was drawn again; the map then rightly asks again, so it is
// drawn again (at most three times) until it is fresh.
async function rebuildFreshMap() {
  for (let attempt = 1; ; attempt++) {
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    try {
      await until(async () => await page.getByText('지도를 만든 뒤 파일이 바뀌었거나', { exact: false }).count() === 0
        && await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).isVisible());
      return;
    } catch (error) { if (attempt === 3) throw error; }
  }
}
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
// Where the code's caret and selection are, as line and column. It is read from the browser selection,
// which CodeMirror keeps in step while the code has focus.
const caret = () => page.evaluate(() => {
  const place = (node, offset) => {
    const line = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('.cm-line');
    if (!line) return null; // the selection left the code
    const before = document.createRange();
    before.setStart(line, 0);
    before.setEnd(node, offset);
    return { line: [...document.querySelectorAll('.cm-line')].indexOf(line), column: before.toString().length };
  };
  const selection = getSelection();
  return { anchor: place(selection.anchorNode, selection.anchorOffset), head: place(selection.focusNode, selection.focusOffset) };
});
const at = (line, column) => ({ line, column });
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root,
    chromiumSandbox: true, timeout: 30_000 });
  page = await app.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).waitFor();
}
// How the app process ended: a worker ended while Tree-sitter parses aborts it (SIGABRT, Napi::Error).
// The TypeScript checker processes (plan v2.3 V-2) running from this checkout.
function checkerProcesses() {
  try { return execFileSync('pgrep', ['-f', path.join(root, 'node_modules/@typescript/')]).toString().trim().split('\n').length; }
  catch { return 0; }
}
function ending() {
  const child = app.process();
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}
// Quitting waits for every worker; if one never stops, the app never ends, so the wait fails instead of hanging.
async function endsWithin(ended, step) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The app did not end within 60 s after: ${step}`)), 60_000); });
  try { return await Promise.race([ended, late]); } finally { clearTimeout(timer); }
}
// Holds back every message from worker threads started after this, until the test releases them.
async function holdWorkerMessages() {
  await app.evaluate(() => {
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    const hold = { released: false, held: [] };
    globalThis.testHold = hold;
    globalThis.testOriginalOn = Worker.prototype.on;
    globalThis.testHeld = hold.held;
    Worker.prototype.on = function (event, listener) {
      if (event !== 'message') return globalThis.testOriginalOn.call(this, event, listener);
      // A worker started while held keeps this listener: a message it sends after the release must pass, or the
      // job never ends and quitting waits for that worker forever.
      return globalThis.testOriginalOn.call(this, event, (...values) => {
        if (hold.released) listener(...values);
        else hold.held.push(() => listener(...values));
      });
    };
  });
}
async function releaseWorkerMessages() {
  await app.evaluate(() => {
    process.getBuiltinModule('node:worker_threads').Worker.prototype.on = globalThis.testOriginalOn;
    globalThis.testHold.released = true;
    for (const deliver of globalThis.testHeld.splice(0)) deliver();
  });
}
try {
  await launch();
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
  await check('Code reader colours syntax, takes keyboard focus, reads with keys and stays read-only', async () => {
    const evidence = await page.getByTestId('evidence-range').innerText();
    const lines = () => page.locator('.cm-line').allTextContents().then(all => all.join('\n'));
    const before = await lines();
    // A keyword and a string literal get colours of their own, unlike plain text.
    const colours = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.cm-content span')];
      const colourOf = element => element ? getComputedStyle(element).color : null;
      return { keyword: colourOf(spans.find(span => span.textContent === 'return')),
        string: colourOf(spans.find(span => span.textContent?.startsWith('"실패'))), plain: colourOf(document.querySelector('.cm-line')) };
    });
    assert.ok(colours.keyword && colours.string);
    assert.notEqual(colours.keyword, colours.plain);
    assert.notEqual(colours.keyword, colours.string);
    // Tab leaves the code and Shift+Tab comes back, with a visible focus mark.
    const content = page.locator('.cm-content');
    assert.equal(await content.getAttribute('tabindex'), '0');
    await content.focus();
    await page.keyboard.press('Tab');
    assert.equal(await content.evaluate(element => element === document.activeElement), false);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await content.evaluate(element => element === document.activeElement), true);
    assert.notEqual(await page.locator('.cm-editor').evaluate(element => getComputedStyle(element).boxShadow), 'none');
    // Reading keys: ArrowRight collapses the evidence selection and Shift extends a new one.
    // The selection layer redraws on the next frame, so wait for it.
    await page.keyboard.press('ArrowRight');
    await until(async () => await page.locator('.cm-selectionBackground').count() === 0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.locator('.cm-selectionBackground').first().waitFor();
    // Typing, deleting and pasting change nothing.
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    // The paste carries real text, so an empty clipboard cannot make this pass.
    await content.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'pasted();');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await lines(), before);
    // JavaScript gets the same colours.
    await page.getByRole('button', { name: 'helper.js', exact: true }).click();
    await page.getByRole('button', { name: 'greet', exact: true }).waitFor();
    const jsColours = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.cm-content span')];
      const colourOf = element => element ? getComputedStyle(element).color : null;
      return { keyword: colourOf(spans.find(span => span.textContent === 'return')), string: colourOf(spans.find(span => span.textContent?.startsWith('"안녕'))),
        comment: colourOf(spans.find(span => span.textContent?.startsWith('//'))), plain: colourOf(document.querySelector('.cm-line')) };
    });
    assert.ok(jsColours.keyword && jsColours.string && jsColours.comment);
    assert.equal(new Set([jsColours.keyword, jsColours.string, jsColours.comment]).size, 3);
    assert.notEqual(jsColours.keyword, jsColours.plain);
    // The rest of the reading keys, in this LF file whose first line has no indentation.
    await content.focus();
    await page.keyboard.press('Meta+ArrowDown');
    assert.deepEqual(await caret(), { anchor: at(4, 0), head: at(4, 0) });
    await page.keyboard.press('Meta+ArrowUp');
    assert.deepEqual(await caret(), { anchor: at(0, 0), head: at(0, 0) });
    await page.keyboard.press('Meta+ArrowRight');
    const firstLine = 'export function greet(name) {'.length;
    assert.deepEqual(await caret(), { anchor: at(0, firstLine), head: at(0, firstLine) });
    await page.keyboard.press('Meta+ArrowLeft');
    assert.deepEqual(await caret(), { anchor: at(0, 0), head: at(0, 0) });
    await page.keyboard.press('PageDown');
    assert.ok((await caret()).head.line > 0);
    await page.keyboard.press('PageUp');
    assert.equal((await caret()).head.line, 0);
    await page.keyboard.press('Meta+a');
    assert.deepEqual(await caret(), { anchor: at(0, 0), head: at(4, 0) });
    // Back to the TypeScript step: the same original range is marked again.
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    // The step's range is shown once main has checked it against the file, a moment after the click.
    await until(async () => await page.getByTestId('evidence-range').innerText() === evidence);
  });
  await check('Code reader finds text, resizes and wraps code, fits the window, and dragging or dropping changes nothing', async () => {
    const evidence = await page.getByTestId('evidence-range').innerText();
    const lines = () => page.locator('.cm-line').allTextContents().then(all => all.join('\n'));
    const before = await lines();
    const content = page.locator('.cm-content');
    const field = page.locator('.cm-search input[name="search"]');
    // At the plan's window sizes, with a function chosen: every header control sits inside the header
    // without overlapping, and the open search field is visible.
    const layoutProblems = () => page.evaluate(() => {
      const box = element => element.getBoundingClientRect();
      const head = box(document.querySelector('.reader__head'));
      const controls = [...document.querySelectorAll('.reader__head .path, .reader__head .badge, .reader__head .btn, .reader__size')];
      const problems = [];
      for (const control of controls) {
        const r = box(control);
        if (r.width === 0 || r.left < head.left - 0.5 || r.right > head.right + 0.5 || r.top < head.top - 0.5 || r.bottom > head.bottom + 0.5) problems.push(`outside: ${control.textContent}`);
      }
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = box(controls[i]), b = box(controls[j]);
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(`overlap: ${controls[i].textContent} / ${controls[j].textContent}`);
      }
      const search = document.querySelector('.cm-search input[name="search"]');
      if (search) {
        const r = box(search), editor = box(document.querySelector('.cm-editor'));
        if (r.width < 100 || r.left < editor.left || r.right > editor.right || r.top < editor.top || r.bottom > editor.bottom) problems.push('search field hidden');
      }
      return problems;
    });
    assert.ok(await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).isVisible());
    for (const [width, height] of [[1280, 800], [1440, 900]]) {
      // The resize is asked for again while waiting: a single request was sometimes not applied (cause not found).
      await until(async () => {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
        return await page.evaluate(expected => window.outerWidth === expected, width);
      });
      await page.getByRole('button', { name: '찾기 ⌘F', exact: true }).click();
      await field.waitFor();
      assert.deepEqual(await layoutProblems(), [], `${width}x${height}`);
      await page.screenshot({ path: path.join(artifacts, `reader-tools-${width}.png`) });
      // Escape closes the panel from its field; focus is put back there first in case it moved away meanwhile.
      await field.focus();
      await page.keyboard.press('Escape');
      await until(async () => await page.locator('.cm-search').count() === 0);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    // Search: the button opens the panel with its field focused, in Korean and without replacing.
    await page.getByRole('button', { name: '찾기 ⌘F', exact: true }).click();
    await field.waitFor();
    assert.equal(await field.evaluate(element => element === document.activeElement), true);
    assert.equal(await field.getAttribute('aria-label'), '찾기');
    assert.equal(await page.locator('.cm-search button[name="next"]').innerText(), '다음');
    assert.equal(await page.locator('.cm-search [name="replace"], .cm-search [name="replaceAll"]').count(), 0);
    // Matches are marked and Enter moves to one; the panel commits on key presses, so the text is typed.
    await page.keyboard.type('return');
    await until(async () => await page.locator('.cm-searchMatch').count() >= 2);
    await page.keyboard.press('Enter');
    await until(async () => await page.locator('.cm-searchMatch-selected').count() === 1);
    await page.keyboard.press('Escape');
    await until(async () => await page.locator('.cm-search').count() === 0);
    // Cmd+F from the code opens it too.
    await content.focus();
    await page.keyboard.press('Meta+f');
    await field.waitFor();
    await page.keyboard.press('Escape');
    await until(async () => await page.locator('.cm-search').count() === 0);
    assert.equal(await lines(), before);
    // Moving to a match moved the selection, as the arrow keys do. The evidence label stays, and choosing
    // the step again marks exactly the original range (lines 2–4, from after the tab to after the brace).
    assert.equal(await page.getByTestId('evidence-range').innerText(), evidence);
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    await content.focus();
    // CodeMirror puts its selection into the page shortly after it takes focus.
    await until(async () => (await caret()).head !== null);
    assert.deepEqual(await caret(), { anchor: at(1, 1), head: at(3, 2) });
    // Code text size: one step up, kept in another file, bounded at 12 and 20px, then back to 15px.
    const size = () => content.evaluate(element => getComputedStyle(element).fontSize);
    const bigger = page.getByRole('button', { name: '코드 글자 크게', exact: true });
    const smaller = page.getByRole('button', { name: '코드 글자 작게', exact: true });
    assert.equal(await size(), '15px');
    await bigger.click();
    assert.equal(await size(), '16px');
    assert.equal(await page.locator('.reader__size').innerText(), '코드 16px');
    // CodeMirror measured the lines again: line number 1 is as tall as the first line.
    await until(() => page.evaluate(() => {
      const number = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(element => element.textContent === '1');
      return Math.abs(number.getBoundingClientRect().height - document.querySelector('.cm-line').getBoundingClientRect().height) < 0.5;
    }));
    await page.getByRole('button', { name: 'helper.js', exact: true }).click();
    await page.getByRole('button', { name: 'greet', exact: true }).waitFor();
    assert.equal(await size(), '16px');
    while (await bigger.isEnabled()) await bigger.click();
    assert.equal(await size(), '20px');
    while (await smaller.isEnabled()) await smaller.click();
    assert.equal(await size(), '12px');
    for (let step = 0; step < 3; step++) await bigger.click();
    assert.equal(await size(), '15px');
    // Wrapping: the long comment scrolls sideways until wrapping is on, which stays on in another file.
    const helperLines = await lines();
    const overflows = () => page.locator('.cm-scroller').evaluate(element => element.scrollWidth > element.clientWidth);
    const wrap = page.getByRole('button', { name: '줄바꿈', exact: true });
    assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
    assert.equal(await overflows(), true);
    await wrap.click();
    assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
    await until(async () => !await overflows());
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).waitFor();
    assert.equal(await content.evaluate(element => element.classList.contains('cm-lineWrapping')), true);
    await page.getByRole('button', { name: 'helper.js', exact: true }).click();
    await page.getByRole('button', { name: 'greet', exact: true }).waitFor();
    await until(async () => !await overflows());
    assert.equal(await page.locator('.cm-line').count(), 5);
    await wrap.click();
    assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
    await until(overflows);
    // Dragging the mouse over lines selects them, and a drop that carries text changes nothing.
    await content.focus();
    await page.keyboard.press('Meta+ArrowUp');
    await until(async () => await page.locator('.cm-selectionBackground').count() === 0);
    // Line boxes are measured once the editor has finished scrolling back to the top.
    await until(() => page.evaluate(() => document.querySelector('.cm-scroller').scrollTop === 0));
    const first = await page.locator('.cm-line').nth(0).boundingBox();
    const third = await page.locator('.cm-line').nth(2).boundingBox();
    await page.mouse.move(first.x + 4, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(third.x + 60, third.y + third.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.locator('.cm-selectionBackground').first().waitFor();
    assert.equal((await caret()).head.line, 2);
    await content.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'dropped();');
      element.dispatchEvent(new DragEvent('drop', { dataTransfer, clientX: rect.left + 20, clientY: rect.top + 10, bubbles: true, cancelable: true }));
    });
    assert.equal(await lines(), helperLines);
    // Leave the following checks where they expect: order.ts with the same step chosen.
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    // The step's range is shown once main has checked it against the file, a moment after the click.
    await until(async () => await page.getByTestId('evidence-range').innerText() === evidence);
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
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('flow-snippet').count(), 0);
    for (const name of ['이전 단계', '다음 단계']) assert.equal(await card.getByRole('button', { name, exact: true }).isDisabled(), true);
    assert.equal(await card.locator('.flow-link').isDisabled(), true);
    await page.getByRole('button', { name: 'loop.ts', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '모두', exact: true }).isEnabled());
    assert.equal(await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count(), 0);

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
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    // This folder is no Git repository, so the changes view says so (plan v2.3 C-2). One write can send a second change
    // notice while the history is read; the view then rightly asks to read again.
    const notRepository = page.getByText('이 폴더는 Git 저장소가 아니에요.', { exact: true });
    const readAgain = page.getByText('Git 기록을 읽는 동안 파일이 바뀌었어요. 다시 읽어 주세요.', { exact: true });
    await notRepository.or(readAgain).waitFor();
    if (await readAgain.isVisible()) await page.getByRole('button', { name: '다시 읽기', exact: true }).click();
    await notRepository.waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '주문', exact: true }).isEnabled());
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    await page.getByText('이 폴더는 Git 저장소가 아니에요.', { exact: true }).waitFor();
    assert.equal(await page.getByText('프로젝트를 연 뒤 감지된 변경이 없어요.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count(), 0);
  });
  await check('Returning to the window keeps the view; waking from sleep or during a scan asks for a re-check', async () => {
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByTestId('evidence-range').waitFor();
    // Any window focus used to mark the project stale, clear the conversation and cancel AI work. A notice
    // sent during the focus arrives before the reply to a later request, so one round trip is enough.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus'); });
    await page.evaluate(() => window.learning.cancelExplanation({ jobId: crypto.randomUUID() }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count(), 0);
    assert.equal(await page.getByTestId('evidence-range').count(), 1);
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).isEnabled(), true);
    // Changes made while the Mac slept may have been missed by the watcher.
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '주문', exact: true }).isEnabled());
    // Waking up while another folder is scanned: the screen does not know that project yet and would miss
    // the notice, so the open is refused. The wake-up is sent as the scan request leaves for the worker.
    await dialogTo(second);
    await app.evaluate(({ powerMonitor }) => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const original = Worker.prototype.postMessage;
      globalThis.testOriginalPostMessage = original;
      Worker.prototype.postMessage = function (message, ...rest) {
        const result = original.call(this, message, ...rest);
        if (message?.kind === 'scan') { Worker.prototype.postMessage = original; powerMonitor.emit('resume'); }
        return result;
      };
    });
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByText('폴더를 여는 동안 파일이 바뀌었거나 잠자기에서 돌아왔습니다. 다시 열어 주세요.', { exact: true }).waitFor();
    await app.evaluate(() => { process.getBuiltinModule('node:worker_threads').Worker.prototype.postMessage = globalThis.testOriginalPostMessage; });
    // Without a wake-up the same folder opens normally; then go back to the fixture for the next checks.
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '다른 프로젝트', exact: true }).waitFor();
    await dialogTo(fixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
  });
  await check('Project map: file and design views, evidence, freshness, reopening and cancelled or stale maps', async () => {
    await dialogTo(mapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '지도 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    const boxes = page.locator('.react-flow__node');
    // Five code files are fewer than 60, so the map starts in the file view; the deep file was never listed.
    await until(async () => await boxes.count() === 5);
    await page.getByText('초기 탐색 제한(파일 1,000개·항목 5,000개·깊이 20)에 도달했습니다.', { exact: false }).waitFor();
    await page.getByText('확인 못 함 · 1개', { exact: true }).waitFor();
    await page.getByText('외부 패키지 또는 경로 별칭 · 1개', { exact: true }).waitFor();
    const design = page.getByRole('region', { name: '폴더 사이 연결' });
    await design.getByText('폴더 사이 연결(설계) · 4개', { exact: true }).waitFor();
    const designLines = await design.locator('li').allInnerTexts();
    // Each direction counted on its own; the import inside ui is left out.
    assert.deepEqual(designLines.sort(), ['store → shared · import 1개', 'store → ui · import 1개', 'ui → shared · import 1개', 'ui → store · import 2개']);
    await page.screenshot({ path: path.join(artifacts, 'project-map-files.png') });
    // The design view folds every folder; a folder box opens its files.
    await page.getByRole('button', { name: '설계 보기', exact: true }).click();
    await until(async () => await boxes.count() === 3);
    await page.screenshot({ path: path.join(artifacts, 'project-map-design.png') });
    await boxes.filter({ hasText: 'ui · 파일 2개' }).click();
    await until(async () => await boxes.count() === 4);
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
    await until(async () => await boxes.count() === 5);
    await boxes.filter({ hasText: 'save.ts' }).click();
    await page.getByRole('heading', { name: 'store/save.ts', exact: true }).waitFor();
    // An import's evidence opens the importing file with that import highlighted.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    const loadLine = page.locator('.map-list li').filter({ hasText: 'store/load.ts 1행 → ui/view.ts' });
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByRole('heading', { name: 'store/load.ts', exact: true }).waitFor();
    assert.match(await page.getByTestId('evidence-range').innerText(), /store\/load\.ts · 1–1줄/);
    // A wake from sleep while that file is read (sent as the read request leaves for the worker): no highlight.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await app.evaluate(({ powerMonitor }) => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        const result = original.call(this, message, ...rest);
        if (message?.kind === 'read') { Worker.prototype.postMessage = original; powerMonitor.emit('resume'); }
        return result;
      };
    });
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByRole('heading', { name: 'store/load.ts', exact: true }).waitFor();
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    // A fresh map, so the next change is the only thing marking it.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await rebuildFreshMap();
    // A change after the map was drawn: the map asks for a re-check and the old position is not highlighted.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await writeFile(path.join(mapFixture, 'store/load.ts'), "\n" + mapFiles['store/load.ts']);
    await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByText('지도를 만든 뒤 이 파일이 바뀌어 import 위치를 강조하지 않았어요.', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await rebuildFreshMap();
    // Two more changes with a fresh map between them and no file read: the screen's other change states are
    // already set by then, and the map must still be marked each time.
    for (const blankLines of ['\n\n', '\n\n\n']) {
      await writeFile(path.join(mapFixture, 'store/load.ts'), blankLines + mapFiles['store/load.ts']);
      await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
      await rebuildFreshMap();
    }
    // Waking from sleep while the map is drawn: the map is dropped (sent as the map worker starts).
    await app.evaluate(({ powerMonitor }) => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const original = Worker.prototype.once;
      globalThis.testOriginalOnce = original;
      Worker.prototype.once = function (event, listener) {
        if (event === 'message') { Worker.prototype.once = original; powerMonitor.emit('resume'); }
        return original.call(this, event, listener);
      };
    });
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await page.getByText('지도를 만드는 동안 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await app.evaluate(() => { process.getBuiltinModule('node:worker_threads').Worker.prototype.once = globalThis.testOriginalOnce; });
    // Cancelling a map stops only the map; files still open meanwhile.
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const original = Worker.prototype.once;
      globalThis.testOriginalOnce = original;
      Worker.prototype.once = function (event, listener) {
        // Hold the map's answer back so it can be cancelled while it is still being drawn.
        if (event === 'message') return original.call(this, event, (...values) => setTimeout(() => listener(...values), 5000));
        return original.call(this, event, listener);
      };
    });
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await page.getByText('지도를 만드는 중…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'shared/format.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'shared/format.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByRole('button', { name: '지도 만들기 취소', exact: true }).click();
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).waitFor();
    // A map still being drawn when the folder is opened again is dropped; reopening shows new files.
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await page.getByText('지도를 만드는 중…', { exact: true }).waitFor();
    await writeFile(path.join(mapFixture, 'ui/extra.ts'), "import { view } from './view';\nexport const extra = 1;\n");
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await app.evaluate(() => { process.getBuiltinModule('node:worker_threads').Worker.prototype.once = globalThis.testOriginalOnce; });
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await until(async () => await boxes.count() === 6);
    assert.equal(await page.getByText('지도를 만드는 동안', { exact: false }).count(), 0);
    // A larger project: cancelling while its files are parsed stops the map, not the app.
    await dialogTo(bigMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '큰 지도 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByText('지도를 만드는 중…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '지도 만들기 취소', exact: true }).click();
    await page.getByRole('button', { name: '지도 만들기', exact: true }).waitFor();
    assert.equal(await app.evaluate(() => 'alive'), 'alive');
    // More than 60 code files: the map starts in the design view, one box per folder.
    await page.getByRole('button', { name: '지도 만들기', exact: true }).click();
    // About 6.5 MB of code takes longer than the usual wait to draw.
    await page.getByText('폴더 사이 연결(설계)', { exact: false }).waitFor({ timeout: 30_000 });
    assert.equal(await boxes.count(), 5);
    assert.equal(await page.getByRole('button', { name: '설계 보기', exact: true }).getAttribute('aria-pressed'), 'true');
    await boxes.filter({ hasText: 'part0 · 파일 13개' }).click();
    await until(async () => await boxes.count() === 17);
    // While another folder opens, the old map does not open code: that read would drop the new project.
    // Then leave the following checks with the original fixture open.
    await page.getByText('연결 목록 · 65개', { exact: true }).click();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => {
        globalThis.testMapDialogWaiting = true;
        await new Promise(resolve => { globalThis.testMapReleaseDialog = resolve; });
        return { canceled: false, filePaths: [folder] };
      };
    }, fixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await until(() => app.evaluate(() => globalThis.testMapDialogWaiting === true));
    await boxes.filter({ hasText: 'file0.ts' }).click();
    // The list's button is disabled meanwhile; a forced click must still change nothing.
    assert.equal(await page.locator('.map-list button').first().isDisabled(), true);
    await page.locator('.map-list button').first().click({ force: true });
    await app.evaluate(() => globalThis.testMapReleaseDialog());
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'order.ts', exact: true }).isVisible(), true);
  });
  await check('Cancelling while files are parsed leaves the app running, and the next open works', async () => {
    for (let round = 0; round < 3; round++) {
      // Opening runs the overview, which parses up to 20 files of about 100 KB.
      await dialogTo(bigMapFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
      assert.equal(await app.evaluate(() => 'alive'), 'alive');
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).waitFor();
    }
    for (let round = 0; round < 3; round++) {
      await dialogTo(bigMapFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('heading', { name: '큰 지도 프로젝트', exact: true }).waitFor();
      await page.getByRole('button', { name: `part${round}/file${round}.ts`, exact: true }).click();
      await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
      assert.equal(await app.evaluate(() => 'alive'), 'alive');
    }
    await dialogTo(second);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '다른 프로젝트', exact: true }).waitFor();
    await dialogTo(fixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
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
    // Closing no longer waits for the worker to end, so the cancel reply itself is held back: the real
    // handler runs at once, and only its answer to the screen is late.
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      if (!(handlers instanceof Map) || !handlers.has('learning:cancel')) throw new Error('Electron internals changed: no invoke handler map');
      const original = handlers.get('learning:cancel');
      globalThis.testOriginalCancel = original;
      handlers.set('learning:cancel', async (...values) => {
        // Only this first reply is held back; the second cancel below is answered as usual.
        handlers.set('learning:cancel', original);
        const result = await original(...values);
        globalThis.testUiTerminateWaiting = true;
        await new Promise(resolve => { globalThis.testUiReleaseTerminate = resolve; });
        return result;
      });
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
    await app.evaluate(() => globalThis.testUiReleaseTerminate());
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
  await check('Cancel while the next project scans does not reopen a project', async () => {
    await dialogTo(fixture);
    const first = await page.evaluate(() => window.learning.openProject());
    assert.equal(first.ok, true);
    await holdWorkerMessages();
    await dialogTo(second);
    const pending = page.evaluate(() => window.learning.openProject());
    await until(() => app.evaluate(() => globalThis.testHeld.length > 0));
    await page.evaluate(() => window.learning.cancel());
    await releaseWorkerMessages();
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
    // Real IPC gates, before any installation check in this app run. The local worker opens only once a
    // check has found both Codex and Antigravity, so a valid request here must be refused. Never send a
    // valid one after the check: it would start the real AI CLIs (this test profile's app homes have no
    // login, so they would fail at sign-in, but they would run).
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
      const ready = await window.learning.startExplanation(request);
      // Should the gate ever open here, stop that job at once; the assertion below then fails.
      if (ready.ok) await window.learning.cancelExplanation({ jobId: ready.value.jobId });
      return {
        ready,
        single: await window.learning.startExplanation({ ...request, mode: 'codex' }),
        consent: await window.learning.startExplanation({ ...request, consent: false }),
        path: await window.learning.startExplanation({ ...request, path: '/etc/passwd' }),
      };
    });
    assert.equal(gate.ready.ok, false); assert.equal(gate.ready.code, 'AI_UNAVAILABLE');
    assert.equal(gate.single.ok, false); assert.equal(gate.single.code, 'AI_UNAVAILABLE');
    assert.equal(gate.consent.ok, false); assert.equal(gate.consent.code, 'INVALID_REQUEST');
    assert.equal(gate.path.ok, false); assert.equal(gate.path.code, 'INVALID_REQUEST');
    // Restore renderer/main agreement after direct IPC fixture setup.
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('tab', { name: '질문', exact: true }).click();
    const selector = page.getByRole('combobox', { name: 'AI 사용 방식' });
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)),
      ['local-worker', 'codex', 'claude-code', 'antigravity']);
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('설정 보존 확인');
    // Original production handler: fixed installation candidates and --version only.
    // No authentication or AI request is performed by this button.
    await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    const installs = page.getByRole('list', { name: '로컬 AI 설치 상태' });
    await installs.waitFor({ timeout: 35_000 });
    // With both workers installed (as on the development Mac) the local worker is ready and states its
    // known limits; otherwise it says both are needed. Sending still waits for consent.
    const listed = await installs.innerText();
    const ready = /Codex · 설치 확인/.test(listed) && /Antigravity · 설치 확인/.test(listed);
    assert.match(await page.getByTestId('ai-readiness').innerText(), ready ? /질문을 보낼 수 있어요\. 알려진 한계/ : /Codex와 Antigravity가 둘 다 필요해요/);
    assert.equal(await page.getByRole('checkbox').isEnabled(), ready);
    assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
    // The consent names what capture sends: the selection's whole file too, and related files only here.
    const consentText = () => page.locator('.ai-consent').innerText();
    assert.match(await consentText(), /선택한 코드와 그 파일 전체\(크기 제한 안\)·프로젝트 파일 목록·관련 파일\(추가 최대 4개\)·질문·최근 답변을 Codex와 Gemini에 보내는/);
    // Each single mode opens with its own CLI, names it, and reads no other file.
    for (const [mode, binary, recipient] of [['codex', 'Codex', 'Codex'], ['antigravity', 'Antigravity', 'Gemini\\(Antigravity\\)']]) {
      await selector.selectOption(mode);
      const found = new RegExp(`${binary} · 설치 확인`).test(listed);
      assert.match(await page.getByTestId('ai-readiness').innerText(), found ? /한 AI가 바로 설명하고 다른 AI의 대조는 없어요/ : /단독에는 .+ 필요해요/);
      assert.equal(await page.getByRole('checkbox').isEnabled(), found);
      const consent = await consentText();
      assert.match(consent, new RegExp(`선택한 코드와 그 파일 전체\\(크기 제한 안\\)·프로젝트 파일 목록·질문·최근 답변을 ${recipient}에 보내는 데 동의합니다\\. 다른 파일은 더 읽지 않습니다\\.`));
      assert.doesNotMatch(consent, /관련 파일/);
      assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
    }
    await selector.selectOption('claude-code');
    assert.equal(await page.getByTestId('ai-readiness').innerText(), 'Claude Code 단독은 아직 준비 중이에요.');
    assert.equal(await page.getByRole('checkbox').isEnabled(), false);
    await selector.selectOption('local-worker');
    await page.getByRole('button', { name: '패널 접기', exact: true }).click();
    await page.getByRole('button', { name: '설명 패널 펼치기', exact: true }).click();
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.equal(await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue(), '설정 보존 확인');
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
        // Like the real workflow, the selection is the first source and steps and claims name sources by ID.
        const selection = { id: request.evidenceId, projectId: request.projectId, fileId: randomUUID(),
          fileHash: request.expectedFileHash, startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1 };
        const result = { jobId, conversationId: request.conversationId ?? randomUUID(), projectId: request.projectId,
          question: request.question, evidence: selection,
          sources: [{ evidence: selection, relativePath: 'order.ts' }, { evidence: related, relativePath: 'related.ts' }],
          limitations: ['시험용 관련 파일 자료입니다.'],
          explanation: { summary: `가짜 설명: ${request.question}`,
            steps: [{ title: '가짜 단계', input: '수량', action: '비교', output: '결과', alternatives: [],
              evidenceIds: [request.evidenceId, related.id, request.evidenceId] }],
            claims: [{ kind: 'code', text: '테스트용 설명입니다.', evidenceIds: [request.evidenceId] },
              { kind: 'concept', text: '일반 개념 설명입니다.' }], terms: [], unknowns: [] },
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
    // Plan G1·E1: each step and code claim names its own sources, a repeated one once; a whole file says so.
    const answer = page.getByRole('region', { name: 'AI 설명' }).last();
    const stepSources = answer.getByRole('list', { name: '‘가짜 단계’의 근거' }).getByRole('button');
    assert.deepEqual(await stepSources.allInnerTexts(), ['order.ts · 1–1행', 'related.ts · 파일 전체 근거 · 세부 위치 미확인']);
    assert.deepEqual(await answer.getByRole('list', { name: '이 설명의 근거' }).getByRole('button').allInnerTexts(), ['order.ts · 1–1행']);
    assert.equal(await answer.getByRole('list', { name: '이 설명의 근거' }).count(), 1);
    await answer.screenshot({ path: path.join(artifacts, 'ai-step-sources.png') });
    await stepSources.nth(0).click();
    await until(async () => (await page.getByTestId('evidence-range').innerText()).startsWith('근거: order.ts'));
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 3);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await stepSources.nth(1).click();
    await until(async () => (await page.locator('.cm-line').allTextContents()).join('\n').includes('export const related'));
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 3);
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 0);
  });
  // Plan G1·E1·F1·U1. A test-only overview handler, after all real IPC checks: it never starts an AI CLI. It answers from
  // the opened folder's real files (read through the app), so following a feature reads real code.
  await check('Overview (fake AI): prepared with consent, its cards and sources, and back to the overview by keyboard', async () => {
    await app.evaluate(({ ipcMain }) => {
      const open = ipcMain._invokeHandlers.get('learning:open');
      ipcMain.removeHandler('learning:open');
      ipcMain.handle('learning:open', async (event, request) => {
        const result = await open(event, request);
        if (result.ok && result.value) globalThis.testOpenedProject = result.value;
        return result;
      });
      ipcMain.removeHandler('learning:overview');
      globalThis.testOverviewCalls = [];
      ipcMain.handle('learning:overview', async (event, request) => {
        const { randomUUID } = process.getBuiltinModule('node:crypto');
        const read = ipcMain._invokeHandlers.get('learning:read');
        const jobId = randomUUID();
        const evidence = {};
        for (const file of globalThis.testOpenedProject.files.filter(item => ['README.md', 'banner.ts', 'dup.ts'].includes(item.relativePath))) {
          const { value } = await read(event, { projectId: request.projectId, fileId: file.id });
          const lines = value.text.split('\n').length - (value.text.endsWith('\n') ? 1 : 0);
          evidence[file.relativePath] = { id: randomUUID(), projectId: request.projectId, fileId: file.id, fileHash: value.hash,
            startUtf16: 0, endUtf16: value.text.length, startLine: 1, endLine: lines };
          globalThis.testFakeAiEvidence.set(evidence[file.relativePath].id, { evidence: evidence[file.relativePath], source: value });
        }
        const at = name => evidence[name].id;
        const feature = (name, file, functionName) => ({ name, summary: `${name} 설명`, evidenceIds: [at(file)], start: { evidenceId: at(file), functionName } });
        const result = { jobId, projectId: request.projectId, review: 'AI 검토됨', models: [],
          sources: ['README.md', 'banner.ts', 'dup.ts'].map(name => ({ evidence: evidence[name], relativePath: name })),
          limitations: ['관련 파일 탐색은 한 번, 최대 4개입니다. 제공되지 않은 파일의 동작은 확인하지 않았습니다.'],
          overview: {
            intro: { text: '배너를 등록하고 보여 주는 앱이에요.', evidenceIds: [at('README.md')] },
            features: [feature('배너 등록', 'banner.ts', 'registerBanner'), feature('같은 이름 실행', 'dup.ts', 'run'),
              feature('목록 보기', 'banner.ts', 'listBanners'), feature('함수 모름', 'banner.ts', null),
              ...[5, 6, 7].map(index => feature(`기능 ${index}`, 'banner.ts', null))],
            roles: [{ name: '배너 저장', summary: '배너를 담아 둬요.', evidenceIds: [at('banner.ts'), at('dup.ts')],
              functions: [{ name: 'save', evidenceId: at('banner.ts') }, { name: 'run', evidenceId: at('dup.ts') }] }],
            unknowns: ['배너를 화면에 그리는 코드는 확인하지 못했어요.'],
          } };
        globalThis.testOverviewCalls.push(request);
        const send = () => {
          event.sender.send('learning:ai-event', { kind: 'progress', jobId, projectId: request.projectId, phase: 'organizing' });
          event.sender.send('learning:ai-event', { kind: 'overview-completed', jobId, projectId: request.projectId, result });
        };
        if (globalThis.testOverviewHold) globalThis.testOverviewLate = send;
        else setTimeout(send, 50);
        return { ok: true, value: { jobId } };
      });
    });
    await dialogTo(featureFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 프로젝트', exact: true }).waitFor();
    const card = page.getByRole('region', { name: '기능과 구성 (AI 개요)' });
    await card.getByText('개요 미생성', { exact: true }).waitFor();
    // The installation check is shared with the question panel, where the fake one already ran.
    assert.match(await page.getByTestId('overview-readiness').innerText(), /테스트 전용/);
    const startFile = card.getByRole('combobox', { name: '개요 시작 파일' });
    assert.equal(await startFile.evaluate(element => element.selectedOptions[0].textContent), 'README.md · 문서에 적힌 소개');
    // A source file that is no start candidate can be the start too.
    await startFile.selectOption({ label: 'settings.ts' });
    const create = card.getByRole('button', { name: '개요 만들기', exact: true });
    assert.equal(await create.isDisabled(), true);
    await card.getByRole('checkbox').check();
    // While the overview runs, the shared installation check is closed in the question panel too.
    await app.evaluate(() => { globalThis.testOverviewHold = true; });
    await create.click();
    await card.getByText('개요 작업 시작 중', { exact: true }).waitFor();
    assert.equal(await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).isDisabled(), true);
    await app.evaluate(() => { globalThis.testOverviewHold = false; globalThis.testOverviewLate(); });
    await card.getByText('배너를 등록하고 보여 주는 앱이에요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).isDisabled(), false);
    const opened = await app.evaluate(() => ({ id: globalThis.testOpenedProject.id,
      files: Object.fromEntries(globalThis.testOpenedProject.files.map(file => [file.relativePath, file.id])) }));
    assert.deepEqual(await app.evaluate(() => globalThis.testOverviewCalls), [
      { projectId: opened.id, startFileId: opened.files['settings.ts'], mode: 'local-worker', consent: true }]);
    assert.equal(await card.getByRole('checkbox').isChecked(), false);
    await card.getByText('문서에서 읽은 소개(AI 요약)', { exact: true }).waitFor();
    await card.getByText('AI 검토됨 · 개요의 정확성을 보장하지 않습니다.', { exact: true }).waitFor();
    const features = card.getByRole('region', { name: '주요 기능 후보' });
    assert.equal(await features.locator('.overview-items > li').count(), 6);
    await features.getByRole('button', { name: '1개 더 보기', exact: true }).click();
    assert.equal(await features.locator('.overview-items > li').count(), 7);
    assert.deepEqual(await features.getByRole('list', { name: '‘배너 등록’의 근거' }).getByRole('button').allInnerTexts(),
      ['banner.ts · 파일 전체 근거 · 세부 위치 미확인']);
    const roles = card.getByRole('region', { name: '큰 구성과 역할' });
    assert.deepEqual(await roles.getByRole('list', { name: '‘배너 저장’의 관련 함수' }).getByRole('button').allInnerTexts(), ['save · banner.ts', 'run · dup.ts']);
    await card.getByRole('region', { name: '개요에서 확인하지 못한 것' }).getByText('배너를 화면에 그리는 코드는 확인하지 못했어요.').waitFor();
    await card.getByText('조사 범위 · AI가 실제로 읽은 파일 3개', { exact: true }).waitFor();
    await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(artifacts, 'overview-ai.png') });
    // Keyboard only: a source opens the code, the side menu comes back, a feature is followed and the bar returns the focus.
    await card.getByRole('list', { name: '소개의 근거' }).getByRole('button', { name: 'README.md · 문서 전체', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until(async () => await page.getByTestId('evidence-range').count() === 1
      && (await page.getByTestId('evidence-range').innerText()).startsWith('근거: README.md · 1–3줄'));
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).focus();
    await page.keyboard.press('Enter');
    await card.getByText('배너를 등록하고 보여 주는 앱이에요.', { exact: true }).waitFor();
    await features.getByRole('button', { name: '이 기능 따라가기', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    const topicBar = page.getByRole('region', { name: '학습 주제' });
    await topicBar.getByText('학습 주제 · AI가 제안한 기능 후보', { exact: true }).waitFor();
    await topicBar.getByText('출발점: banner.ts › registerBanner', { exact: true }).waitFor();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.screenshot({ path: path.join(artifacts, 'topic-flow.png') });
    await topicBar.getByRole('button', { name: '한눈에 보기로', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-anchor') === 'feature:0'));
  });
  await check('Topic (fake AI): the feature question keeps its topic, asks consent again, starts a new conversation and keeps answers while moving', async () => {
    const card = page.getByRole('region', { name: '기능과 구성 (AI 개요)' });
    const features = card.getByRole('region', { name: '주요 기능 후보' });
    const topicBar = page.getByRole('region', { name: '학습 주제' });
    const box = page.getByRole('textbox', { name: '선택한 코드에 질문' });
    const consent = page.locator('.ai-panel').getByRole('checkbox');
    const send = page.getByRole('button', { name: '질문 보내기', exact: true });
    const prepare = topicBar.getByRole('button', { name: '시작·처리·결과 질문 준비', exact: true });
    const lastRequest = () => app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request);
    await features.getByRole('button', { name: '이 기능 따라가기', exact: true }).first().click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await prepare.click();
    await until(async () => (await box.inputValue()) !== '');
    const askA = await box.inputValue();
    assert.match(askA, /^‘배너 등록’ 기능이 이 함수에서 어떻게 시작하는지/);
    assert.equal(await consent.isChecked(), false);
    await consent.check();
    await send.click();
    await page.getByText(`가짜 설명: ${askA}`, { exact: true }).waitFor();
    assert.equal((await lastRequest()).conversationId, undefined);
    const answers = page.getByRole('region', { name: 'AI 설명' });
    await answers.last().getByText('학습 주제: 배너 등록', { exact: true }).waitFor();
    // A follow-up continues the conversation; preparing the feature question again asks consent again and starts anew.
    await box.fill('이어서 묻기');
    await send.click();
    await page.getByText('가짜 설명: 이어서 묻기', { exact: true }).waitFor();
    assert.notEqual((await lastRequest()).conversationId, undefined);
    assert.equal(await answers.last().getByText('학습 주제: 배너 등록', { exact: true }).count(), 0);
    assert.equal(await consent.isChecked(), true);
    await prepare.click();
    await until(async () => (await box.inputValue()) === askA);
    assert.equal(await consent.isChecked(), false);
    await consent.check();
    // Cancelled first: sent again, it still starts a new conversation under its topic.
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; });
    const callsBefore = await app.evaluate(() => globalThis.testFakeAiCalls.length);
    await send.click();
    await until(() => app.evaluate((_electron, count) => globalThis.testFakeAiCalls.length === count + 1, callsBefore));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('button', { name: 'AI 작업 취소', exact: true }).click();
    await page.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'early'; });
    assert.equal(await box.inputValue(), askA);
    await send.click();
    await until(async () => await answers.count() === 3);
    assert.equal((await lastRequest()).conversationId, undefined);
    await answers.last().getByText('학습 주제: 배너 등록', { exact: true }).waitFor();
    // Preparing again while a feature question is on its way cancels it; its late answer does not clear the new draft.
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; });
    const held = await app.evaluate(() => globalThis.testFakeAiCalls.length);
    await prepare.click();
    await until(async () => (await box.inputValue()) === askA);
    await consent.check();
    await send.click();
    await until(() => app.evaluate((_electron, count) => globalThis.testFakeAiCalls.length === count + 1, held));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await topicBar.getByRole('textbox', { name: '학습 이름' }).fill('배너 올리기');
    await prepare.click();
    await page.getByText('기능 질문을 새로 준비해 진행 중이던 질문을 취소했어요.', { exact: true }).waitFor();
    await until(() => app.evaluate(() => globalThis.testFakeAiCancelled.includes(globalThis.testFakeAiCalls.at(-1).jobId)));
    await app.evaluate(() => globalThis.testFakeAiLate());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await box.inputValue(), /^‘배너 올리기’ 기능이/);
    assert.equal(await answers.count(), 3);
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'early'; });
    await topicBar.getByRole('textbox', { name: '학습 이름' }).fill('배너 등록');
    // A step's source, then back to the start: the answers and the question's code stay.
    const scope = await page.getByTestId('question-scope').innerText();
    await answers.last().getByRole('list', { name: '‘가짜 단계’의 근거' }).getByRole('button').nth(1).click();
    await until(async () => (await page.locator('.cm-line').allTextContents()).join('\n').includes('export const related'));
    await topicBar.getByRole('button', { name: '출발점으로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    assert.equal(await answers.count(), 3);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    // Following a call is looking around too (integrated plan 6.2): the answers and the question's code stay.
    await page.getByRole('list', { name: '이 함수가 부르는 것' }).getByRole('button', { name: '그 함수로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed') === 'true');
    assert.equal(await answers.count(), 3);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    // So is opening a file from the map.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
    await page.locator('.react-flow__node').filter({ hasText: 'dup.ts' }).click();
    await page.getByRole('heading', { name: 'dup.ts', exact: true }).waitFor();
    assert.equal(await answers.count(), 3);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await topicBar.getByRole('button', { name: '출발점으로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    // A question prepared for feature A stays while feature B is only looked at, and goes once B's code is chosen.
    await box.fill('');
    await prepare.click();
    await until(async () => (await box.inputValue()) === askA);
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await features.getByRole('button', { name: '이 기능 따라가기', exact: true }).nth(1).click();
    await page.getByText('이 파일에 ‘run’ 함수가 2개라 하나로 정하지 못했어요. 왼쪽에서 직접 골라 주세요.', { exact: true }).waitFor();
    assert.equal(await box.inputValue(), askA);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    // Sending A reads A again in the analysis worker (as the real capture does through readEvidence); B, still on screen,
    // keeps its evidence, so choosing B's function below works.
    const questionCode = await app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request);
    assert.equal((await page.evaluate(input => window.learning.readEvidence(input), { projectId: questionCode.projectId, evidenceId: questionCode.evidenceId })).ok, true);
    await page.getByRole('button', { name: 'helper', exact: true }).click();
    await page.getByText('질문 대상이 바뀌어 준비한 기능 질문을 지웠어요. 다시 준비해 주세요.', { exact: true }).waitFor();
    assert.equal(await box.inputValue(), '');
    await prepare.click();
    await until(async () => /^‘같은 이름 실행’ 기능이/.test(await box.inputValue()));
    await consent.check();
    await send.click();
    await answers.last().getByText('학습 주제: 같은 이름 실행', { exact: true }).waitFor();
    // A start with no function, and a role's functions: one found by its only name, one name with two functions.
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await features.getByRole('button', { name: '이 기능 따라가기', exact: true }).nth(3).click();
    await page.getByText('AI가 출발 함수를 정하지 못했어요. 이 파일에서 함수를 골라 주세요.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    const roleFunctions = card.getByRole('region', { name: '큰 구성과 역할' }).getByRole('list', { name: '‘배너 저장’의 관련 함수' });
    await roleFunctions.getByRole('button', { name: 'save · banner.ts', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await roleFunctions.getByRole('button', { name: 'run · dup.ts', exact: true }).click();
    await page.getByText('이 파일에 ‘run’ 함수가 2개라 하나로 정하지 못했어요. 왼쪽에서 직접 골라 주세요.', { exact: true }).waitFor();
  });
  await check('Topic: code chosen to ask about stays usable after another file is read; a change stales the overview; reopening clears it', async () => {
    const opened = await app.evaluate(() => ({ projectId: globalThis.testOpenedProject.id,
      banner: globalThis.testOpenedProject.files.find(file => file.relativePath === 'banner.ts').id,
      settings: globalThis.testOpenedProject.files.find(file => file.relativePath === 'settings.ts').id }));
    const readAgain = () => page.evaluate(async ({ projectId, banner, settings }) => {
      const source = await window.learning.readSource({ projectId, fileId: banner });
      const evidenceId = source.value.analysis.symbols.find(item => item.name === 'registerBanner').evidence.id;
      const checked = await window.learning.readEvidence({ projectId, evidenceId });
      // The analysis worker now holds only settings.ts; main kept the evidence it checked.
      await window.learning.readSource({ projectId, fileId: settings });
      const later = await window.learning.readEvidence({ projectId, evidenceId });
      return { checked: checked.ok, later: later.ok, evidenceId };
    }, opened);
    const kept = await readAgain();
    assert.deepEqual([kept.checked, kept.later], [true, true]);
    await writeFile(path.join(featureFixture, 'banner.ts'), featureFiles['banner.ts'].replace('return [];', 'return [1];'));
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    // On a change notice main forgets all AI evidence, the kept one too; the worker still knows the old analysis of the
    // file, reads it again and refuses the evidence as changed.
    const changed = await page.evaluate(input => window.learning.readEvidence(input), { projectId: opened.projectId, evidenceId: kept.evidenceId });
    assert.deepEqual([changed.ok, changed.code], [false, 'CHANGED']);
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    const card = page.getByRole('region', { name: '기능과 구성 (AI 개요)' });
    await card.getByText('다시 확인 필요:', { exact: false }).waitFor();
    assert.equal(await card.getByRole('button', { name: '이 기능 따라가기', exact: true }).first().isDisabled(), true);
    // An overview made after the change opens its sources although the reader still waits for a re-read.
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: '개요 다시 만들기', exact: true }).click();
    await until(async () => await card.getByText('다시 확인 필요:', { exact: false }).count() === 0
      && await card.getByRole('button', { name: '이 기능 따라가기', exact: true }).first().isEnabled());
    await card.getByRole('list', { name: '‘배너 등록’의 근거' }).getByRole('button').click();
    await until(async () => await page.getByTestId('evidence-range').count() === 1
      && (await page.getByTestId('evidence-range').innerText()).startsWith('근거: banner.ts'));
    assert.equal(await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    // Opening the same folder again gives new file IDs: the overview and the topic go, and so does the consent.
    await card.getByRole('checkbox').check();
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await card.getByText('개요 미생성', { exact: true }).waitFor();
    assert.equal(await card.getByRole('checkbox').isChecked(), false);
    assert.equal(await page.getByRole('region', { name: '학습 주제' }).count(), 0);
  });
  await check('Topic without an overview: from a start candidate and from the chosen function, each found again by its place', async () => {
    const topicBar = page.getByRole('region', { name: '학습 주제' });
    await page.locator('.starts__item').filter({ hasText: 'registerBanner' }).click();
    await topicBar.getByText('학습 주제 · 코드 구조로 고른 시작점 후보', { exact: true }).waitFor();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await topicBar.getByRole('button', { name: '한눈에 보기로', exact: true }).click();
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-anchor')?.startsWith('start:') === true
      && document.activeElement.textContent.includes('registerBanner')));
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await topicBar.getByRole('button', { name: '주제 닫기', exact: true }).click();
    await page.getByRole('button', { name: 'dup.ts', exact: true }).click();
    const runs = page.getByRole('button', { name: 'run', exact: true });
    await runs.nth(1).click();
    await topicBar.getByRole('button', { name: '이 함수에서 학습 시작', exact: true }).click();
    await topicBar.getByText('학습 주제 · 지금 고른 함수', { exact: true }).waitFor();
    await topicBar.getByRole('textbox', { name: '학습 이름' }).fill('두 번째 실행');
    await topicBar.getByText('원래 이름: run', { exact: true }).waitFor();
    await runs.nth(0).click();
    await topicBar.getByRole('button', { name: '출발점으로', exact: true }).click();
    await until(async () => await runs.nth(1).getAttribute('aria-pressed') === 'true');
    assert.equal(await runs.nth(0).getAttribute('aria-pressed'), 'false');
  });
  await check('Topic history and search: the place before comes back (a range without a function too), not a changed one; the last 20; search only within the overview', async () => {
    const topicBar = page.getByRole('region', { name: '학습 주제' });
    const card = page.getByRole('region', { name: '기능과 구성 (AI 개요)' });
    const placesShown = () => page.getByTestId('topic-places').innerText();
    // A move is recorded once its code has been checked and the screen is drawn again.
    const settle = async () => {
      await until(async () => await page.locator('.busy').count() === 0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const back = topicBar.getByRole('button', { name: '이전 위치', exact: true });
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: '개요 만들기', exact: true }).click();
    await card.getByText('배너를 등록하고 보여 주는 앱이에요.', { exact: true }).waitFor();
    // Search: this overview's items and the topic's name only.
    const search = card.getByRole('searchbox', { name: '기능·역할 찾기' });
    await card.getByText('이번 개요의 기능 후보 7개·구성 역할 1개와 지금 학습 주제 이름에서만 찾아요. 프로젝트 전체 검색이 아니에요.', { exact: true }).waitFor();
    await search.fill('등록');
    await card.getByText('주요 기능 후보 · 찾은 1개 / 7개', { exact: true }).waitFor();
    assert.deepEqual(await card.getByRole('region', { name: '주요 기능 후보' }).locator('.overview-items > li b').allInnerTexts(), ['배너 등록']);
    await card.getByText('큰 구성과 역할 · 찾은 0개 / 1개', { exact: true }).waitFor();
    await search.fill('두 번째');
    await card.getByText('지금 학습 주제 ‘두 번째 실행’의 이름과 맞아요. 화면 위 주제 바에 있어요.', { exact: true }).waitFor();
    await search.fill('없는 이름');
    await card.getByText('이 범위에는 없어요.', { exact: true }).waitFor();
    await search.fill('');
    // History: start, a called function, a document range, back to the start; then back one by one.
    const features = card.getByRole('region', { name: '주요 기능 후보' });
    await features.getByRole('button', { name: '이 기능 따라가기', exact: true }).first().click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await until(async () => await placesShown() === '본 곳 1개(최근 20개까지)');
    assert.equal(await back.isDisabled(), true);
    await page.getByRole('list', { name: '이 함수가 부르는 것' }).getByRole('button', { name: '그 함수로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed') === 'true');
    await until(async () => await placesShown() === '본 곳 2개(최근 20개까지)');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await card.getByRole('list', { name: '소개의 근거' }).getByRole('button', { name: 'README.md · 문서 전체', exact: true }).click();
    await until(async () => await page.getByTestId('evidence-range').count() === 1
      && (await page.getByTestId('evidence-range').innerText()).startsWith('근거: README.md · 1–3줄'));
    await until(async () => await placesShown() === '본 곳 3개(최근 20개까지)');
    await topicBar.getByRole('button', { name: '출발점으로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await until(async () => await placesShown() === '본 곳 4개(최근 20개까지)');
    await back.click();
    await until(async () => await page.getByTestId('evidence-range').count() === 1
      && (await page.getByTestId('evidence-range').innerText()).startsWith('근거: README.md · 1–3줄'));
    assert.equal(await placesShown(), '본 곳 3개(최근 20개까지)');
    await back.click();
    await until(async () => await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed') === 'true');
    await back.click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await until(async () => await placesShown() === '본 곳 1개(최근 20개까지)');
    assert.equal(await back.isDisabled(), true);
    // A place whose file changed afterwards: only the file opens, and that is said.
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await card.getByRole('list', { name: '소개의 근거' }).getByRole('button', { name: 'README.md · 문서 전체', exact: true }).click();
    await until(async () => await placesShown() === '본 곳 2개(최근 20개까지)');
    await page.getByRole('button', { name: 'settings.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'settings.ts', exact: true }).waitFor();
    await until(async () => await placesShown() === '본 곳 3개(최근 20개까지)');
    await writeFile(path.join(featureFixture, 'README.md'), `${featureFiles['README.md']}\n덧붙인 줄\n`);
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count() === 0);
    await back.click();
    await page.getByText('그 뒤 파일이 바뀌어 위치를 되살리지 않았어요. 파일만 열었어요.', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'README.md', exact: true }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    // The changed file now stands for that place, so going back goes on past it.
    assert.equal(await placesShown(), '본 곳 2개(최근 20개까지)');
    await back.click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
    await until(async () => await placesShown() === '본 곳 1개(최근 20개까지)');
    // A step comes back as that step, and the flow goes on from it.
    const steps = page.getByRole('list', { name: 'registerBanner 단계' });
    await steps.getByRole('button', { name: '반환문', exact: true }).click();
    await until(async () => await steps.getByRole('button', { name: '반환문', exact: true }).getAttribute('aria-current') === 'step');
    await steps.getByRole('button', { name: '호출 표현식', exact: true }).click();
    await until(async () => await steps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    await back.click();
    await until(async () => await steps.getByRole('button', { name: '반환문', exact: true }).getAttribute('aria-current') === 'step');
    await page.getByRole('button', { name: '다음 단계', exact: true }).click();
    await until(async () => await steps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    // A change notice and reading the file again are no moves: back goes to the place really seen before.
    await settle();
    await page.getByRole('button', { name: 'listBanners', exact: true }).click();
    await settle();
    const beforeChange = await placesShown();
    await writeFile(path.join(featureFixture, 'settings.ts'), 'const limit = 4;\n');
    await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count() === 0);
    await settle();
    assert.equal(await placesShown(), beforeChange);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await back.click();
    await until(async () => await steps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    // Two steps over the same range (a call written without a semicolon) come back as the one that was chosen.
    await page.getByRole('button', { name: 'dup.ts', exact: true }).click();
    await page.getByRole('button', { name: 'notify', exact: true }).click();
    const notifySteps = page.getByRole('list', { name: 'notify 단계' });
    await notifySteps.getByRole('button', { name: '호출 표현식', exact: true }).click();
    await until(async () => await notifySteps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    await page.getByRole('button', { name: 'helper', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'helper', exact: true }).getAttribute('aria-pressed') === 'true');
    await back.click();
    await until(async () => await notifySteps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    assert.equal(await notifySteps.getByRole('button', { name: '표현식', exact: true }).getAttribute('aria-current'), null);
    // Going back while its file is still read, to the overview meanwhile, then another file: back still finds that place.
    await page.getByRole('button', { name: 'helper', exact: true }).click();
    await settle();
    await app.evaluate(({ ipcMain }) => {
      if (!globalThis.testReadGated) {
        const read = ipcMain._invokeHandlers.get('learning:read');
        ipcMain.removeHandler('learning:read');
        ipcMain.handle('learning:read', async (event, request) => { await globalThis.testReadGate; return read(event, request); });
        globalThis.testReadGated = true;
      }
      globalThis.testReadGate = new Promise(resolve => { globalThis.testReadRelease = resolve; });
    });
    await back.click();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await app.evaluate(() => globalThis.testReadRelease());
    await settle();
    await page.getByRole('button', { name: 'settings.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'settings.ts', exact: true }).waitFor();
    await settle();
    await back.click();
    await until(async () => await notifySteps.getByRole('button', { name: '호출 표현식', exact: true }).getAttribute('aria-current') === 'step');
    // A wake from sleep while going back or to the start is read: nothing is marked or chosen from before.
    for (const action of ['이전 위치', '출발점으로']) {
      await page.getByRole('button', { name: 'helper', exact: true }).click();
      await settle();
      await app.evaluate(() => { globalThis.testReadGate = new Promise(resolve => { globalThis.testReadRelease = resolve; }); });
      await topicBar.getByRole('button', { name: action, exact: true }).click();
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
      await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
      await app.evaluate(() => globalThis.testReadRelease());
      await settle();
      assert.equal(await page.getByTestId('evidence-range').count(), 0, action);
      assert.equal(await page.locator('.symbols__item[aria-pressed="true"]').count(), 0, action);
      await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).or(page.getByRole('button', { name: 'dup.ts', exact: true })).first().click();
      await until(async () => await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).count() === 0);
    }
    await page.getByRole('button', { name: 'notify', exact: true }).click();
    await settle();
    // Only the last 20 places are kept; the start stays reachable through its own button.
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'banner.ts', exact: true }).click();
    for (let index = 0; index < 22; index++) {
      const name = index % 2 ? 'listBanners' : 'registerBanner';
      await page.getByRole('button', { name, exact: true }).click();
      await until(async () => await page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed') === 'true' && !await page.getByRole('status').filter({ hasText: '처리 중' }).count());
    }
    await until(async () => await placesShown() === '본 곳 20개(최근 20개까지)');
    await topicBar.getByRole('button', { name: '출발점으로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'registerBanner', exact: true }).getAttribute('aria-pressed') === 'true');
  });
  await check('Hard code: the map lists a long function, the reader marks it, and the AI button asks about all of it', async () => {
    await dialogTo(hardFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '어려운 코드 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    const list = page.getByRole('region', { name: '어려운 코드 살펴볼 곳' });
    await list.getByText('어려운 코드 살펴볼 곳 · 1개', { exact: true }).waitFor();
    assert.deepEqual(await list.locator('li').allInnerTexts(), ['src/work.ts 3행 long 긴 함수 · 61줄코드 보기']);
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'hard-code-map.png') });
    // From the list to the function in the reader: chosen, marked, and the short one is not.
    await list.getByRole('button', { name: '코드 보기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'long', exact: true }).getAttribute('aria-pressed') === 'true');
    assert.equal(await page.getByTestId('evidence-range').innerText().then(text => text.split(' · ')[1]), '3–66줄');
    assert.deepEqual(await page.locator('.symbols__signals .tag').allInnerTexts(), ['긴 함수 · 61줄']);
    await page.getByText('표시는 살펴볼 곳이에요. 나쁜 코드라는 판정이 아니에요. 기준: 본문 60줄 넘음, 중첩 4단계 넘음.', { exact: true }).first().waitFor();
    // A step inside makes the step the question's code, until the AI button chooses the whole function again.
    await page.getByRole('list', { name: 'long 내부 구문' }).getByRole('button', { name: '조건 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('question-scope').innerText()).endsWith('4–6행'));
    await page.getByRole('button', { name: 'AI에게 단순하게 쓰는 법 묻기', exact: true }).click();
    await until(async () => (await page.getByTestId('question-scope').innerText()) === '질문 기준: src/work.ts · 3–66행');
    assert.equal(await page.getByRole('tab', { name: '질문', exact: true }).getAttribute('aria-selected'), 'true');
    const question = '이 함수를 더 단순하고 읽기 쉽게 쓸 수 있을까요? 바꾼다면 어디를 어떻게 바꾸면 좋을지 알려 주세요.';
    // The question box is filled by an effect right after the tab opens.
    await until(async () => await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue() === question);
    await page.screenshot({ path: path.join(artifacts, 'hard-code-reader.png') });
    // Sent through the test-only AI handlers above: the request names the whole function's evidence.
    await page.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('ai-readiness').innerText()).includes('테스트 전용'));
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText(`가짜 설명: ${question}`, { exact: true }).waitFor();
    const sent = await app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request);
    const named = await page.evaluate(request => window.learning.readEvidence({ projectId: request.projectId, evidenceId: request.evidenceId }), sent);
    assert.deepEqual([named.ok, named.value.evidence.startLine, named.value.evidence.endLine], [true, 3, 66]);
    // After a change the map's entry no longer fits the file, so nothing is chosen.
    await writeFile(path.join(hardFixture, 'src/work.ts'), `// changed\n${hardSource}`);
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await list.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByText('지도를 만든 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 지도를 다시 만들어 주세요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'long', exact: true }).getAttribute('aria-pressed'), 'false');
  });
  await check('Calls: what a function calls and where it is called from, moving to either, and stale after a change', async () => {
    await dialogTo(callsFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '호출 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'src/app.ts', exact: true }).click();
    await page.getByRole('button', { name: 'placeOrder', exact: true }).click();
    const summary = page.getByRole('article', { name: '함수 요약' });
    await summary.getByText('부르는 것 · 3개', { exact: true }).waitFor();
    const calledList = summary.getByRole('list', { name: '이 함수가 부르는 것' });
    assert.deepEqual(await calledList.locator('li').allInnerTexts(), [
      '3행 check(order) → check src/app.ts 그 함수로 호출 위치',
      '4행 save(order) → save src/store.ts 그 함수로 호출 위치',
      '5행 log.info(order) · 확인 못 함멤버 호출(obj.f())이라 대상을 정할 수 없어요 호출 위치',
    ]);
    await summary.getByText('이 함수로 이어진 호출을 찾지 못했어요.', { exact: true }).waitFor();
    await summary.getByText('찾은 이름: placeOrder', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'calls-summary.png') });
    // Follow save: its callers include placeOrder and the arrow quick.
    await calledList.locator('li').nth(1).getByRole('button', { name: '그 함수로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed') === 'true');
    await summary.getByText('부르는 곳 · 2개', { exact: true }).waitFor();
    const callers = summary.getByRole('list', { name: '이 함수를 부르는 곳' }).locator('li');
    assert.deepEqual(await callers.allInnerTexts(), [
      'src/app.ts 4행 save(order) · placeOrder 안 그 함수로 호출 위치',
      "src/app.ts 8행 save('q') · quick 안 그 함수로 호출 위치",
    ]);
    // The call in quick is its whole arrow body, so that step is chosen and highlighted.
    await callers.nth(1).getByRole('button', { name: '호출 위치', exact: true }).click();
    await until(async () => (await page.getByTestId('evidence-range').innerText()).includes('8–8줄'));
    assert.equal(await page.getByRole('button', { name: 'quick', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '표현식 결과 반환', exact: true }).getAttribute('aria-pressed'), 'true');
    // While the search is held back it can be cancelled.
    await holdWorkerMessages();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'quick', exact: true }).click();
    await summary.getByText('호출 관계를 찾는 중…', { exact: true }).waitFor();
    await summary.getByRole('button', { name: '찾기 취소', exact: true }).click();
    await summary.getByText('호출 찾기를 취소했어요.', { exact: true }).waitFor();
    await releaseWorkerMessages();
    await summary.getByRole('button', { name: '다시 찾기', exact: true }).click();
    await summary.getByText('부르는 것 · 1개', { exact: true }).waitFor();
    // A call in a default value is no step of the analyzer: its range is still marked in the reader.
    await page.getByRole('button', { name: 'check', exact: true }).click();
    await summary.getByText('부르는 곳 · 2개', { exact: true }).waitFor();
    await summary.getByRole('list', { name: '이 함수를 부르는 곳' }).locator('li').nth(1).getByRole('button', { name: '호출 위치', exact: true }).click();
    await page.getByText('이 호출(9행)은 함수 단계 목록에 없어 코드 위치만 강조했어요.', { exact: true }).waitFor();
    assert.match(await page.getByTestId('evidence-range').innerText(), /^근거: src\/app\.ts · 9–9줄/);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'quick', exact: true }).click();
    await summary.getByText('부르는 것 · 1개', { exact: true }).waitFor();
    // After a change the lists are marked, and moving to a changed file does not choose anything.
    await writeFile(path.join(callsFixture, 'src/store.ts'), '// changed\nexport function save(order: string) {\n  return order;\n}\n');
    await summary.getByText('호출을 찾은 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 아래 목록은 그 전 코드 기준이에요.', { exact: true }).waitFor();
    await calledList.getByRole('button', { name: '그 함수로', exact: true }).click();
    await page.getByText('호출을 찾은 뒤 이 파일이 바뀌어 그 함수를 고르지 않았어요. 다시 찾아 주세요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed'), 'false');
  });
  await check('Values: names a function uses, arguments from calls and tests, fixed values and writes, never run values', async () => {
    await dialogTo(valuesFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '값 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'src/price.ts', exact: true }).click();
    await page.getByRole('button', { name: 'price', exact: true }).click();
    const summary = page.getByRole('article', { name: '함수 요약' });
    await summary.getByText('실행한 값이 아니에요. 코드에 적힌 값과 식이에요.', { exact: true }).waitFor();
    const names = async (group) => summary.getByRole('group', { name: group }).getByRole('button').allInnerTexts();
    assert.deepEqual([await names('받는 값'), await names('안에서 만든 이름'), await names('바깥 이름')], [['amount', 'qty'], ['sum'], ['RATE', 'total']]);
    // A parameter: what shop passes, and what the test passes as an example.
    await summary.getByRole('group', { name: '받는 값' }).getByRole('button', { name: 'amount', exact: true }).click();
    const amount = summary.getByRole('region', { name: 'amount 값' });
    assert.deepEqual(await amount.getByRole('list', { name: 'amount에 넘기는 값' }).locator('li').allInnerTexts(), ['src/shop.ts 2행 100 코드 보기']);
    assert.deepEqual(await amount.getByRole('list', { name: 'amount 테스트 예시' }).locator('li').allInnerTexts(), ['src/price.test.ts 2행 5 코드 보기']);
    await summary.getByRole('group', { name: '받는 값' }).getByRole('button', { name: 'qty', exact: true }).click();
    const qty = summary.getByRole('region', { name: 'qty 값' });
    assert.deepEqual(await qty.getByRole('list', { name: 'qty 테스트 예시' }).locator('li').allInnerTexts(), ['src/price.test.ts 2행 넘기지 않음 · 기본값을 써요 코드 보기']);
    await page.screenshot({ path: path.join(artifacts, 'values-parameter.png') });
    // A const written as a literal is a fixed value; a let shows its first value and its writes.
    await summary.getByRole('group', { name: '바깥 이름' }).getByRole('button', { name: 'RATE', exact: true }).click();
    // The first is the fixed value; its shape (V-2) shows the same literal below once found.
    await summary.getByRole('region', { name: 'RATE 값' }).getByText('0.1', { exact: true }).first().waitFor();
    await summary.getByRole('group', { name: '안에서 만든 이름' }).getByRole('button', { name: 'sum', exact: true }).click();
    const sum = summary.getByRole('region', { name: 'sum 값' });
    await sum.getByText('amount * qty', { exact: true }).waitFor();
    const writes = sum.getByRole('list', { name: 'sum에 대입하는 곳' }).locator('li');
    assert.deepEqual(await writes.allInnerTexts(), ['src/price.ts 5행 sum = sum + sum * RATE 코드 보기']);
    // Showing a write marks its range in the reader.
    await writes.getByRole('button', { name: '코드 보기', exact: true }).click();
    await until(async () => (await page.getByTestId('evidence-range').innerText()).includes('5–5줄'));
  });
  await check('Value shapes: the TypeScript checker\'s shapes for the return and the names, a package\'s types read, never run values', async () => {
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: 'price', exact: true }).click();
    const summary = page.getByRole('article', { name: '함수 요약' });
    const returns = summary.getByRole('region', { name: '돌려주는 값의 모양' });
    await returns.getByText('number', { exact: true }).waitFor();
    await returns.getByText('모양은 TypeScript가 코드에서 읽은 타입이에요. 실행해서 확인한 값이 아니에요.', { exact: true }).waitFor();
    await summary.getByRole('group', { name: '바깥 이름' }).getByRole('button', { name: 'RATE', exact: true }).click();
    await summary.getByRole('region', { name: 'RATE 값' }).getByText('0.1', { exact: true }).nth(1).waitFor();
    await summary.getByRole('group', { name: '받는 값' }).getByRole('button', { name: 'qty', exact: true }).click();
    await summary.getByRole('region', { name: 'qty 값' }).getByText('number', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'values-shape.png') });
    // A package's type file is read for its types only.
    await page.getByRole('button', { name: 'src/label.ts', exact: true }).click();
    await page.getByRole('button', { name: 'label', exact: true }).click();
    await returns.getByText('string', { exact: true }).waitFor();
    await summary.getByRole('group', { name: '바깥 이름' }).getByRole('button', { name: 'format', exact: true }).click();
    await summary.getByRole('region', { name: 'format 값' }).getByText('(amount: number) => string', { exact: true }).waitFor();
  });
  await check('Changes: the last commit against the files now, five kinds listed and marked on the map, old code side by side, read only', async () => {
    await dialogTo(gitFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '변경 프로젝트', exact: true }).waitFor();
    const gitBefore = execFileSync('find', [path.join(gitFixture, '.git'), '-exec', 'stat', '-f', '%N %z %m', '{}', '+']).toString();
    // A function chosen in the reader first: opening a change of another file must leave it usable.
    await page.getByRole('button', { name: 'src/func.ts', exact: true }).click();
    await page.getByRole('button', { name: 'run', exact: true }).click();
    await page.getByTestId('evidence-range').waitFor();
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    const listed = page.getByRole('region', { name: '바뀐 파일 목록' }).getByRole('list', { name: '바뀐 파일' });
    await listed.waitFor();
    assert.deepEqual(await listed.locator('li').allInnerTexts(), ['추가 src/added.ts 비교 보기', '삭제 src/deleted.ts 비교 보기', '수정 src/edit.ts 비교 보기',
      '이름 변경 src/old-name.ts → src/new-name.ts 비교 보기', '미추적 src/untracked.ts 비교 보기']);
    assert.match(await page.getByRole('combobox', { name: '기준 커밋' }).locator('option:checked').innerText(), /^[0-9a-f]{7} · .+ · HEAD · first version$/);
    // A modification: the commit's code next to the code now.
    await listed.locator('li').nth(2).getByRole('button', { name: '비교 보기', exact: true }).click();
    const diff = page.getByRole('region', { name: '고른 변경 비교' });
    await diff.getByText('왼쪽은 고른 커밋, 오른쪽은 지금 파일이에요. 바뀌지 않은 부분은 접어 두었어요.', { exact: true }).waitFor();
    await diff.getByRole('textbox', { name: '고른 커밋의 코드 (읽기 전용)' }).getByText('export const edit = 1;').waitFor();
    await diff.getByRole('textbox', { name: '지금 코드 (읽기 전용)' }).getByText('export const edit = 2;').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'changes-diff.png') });
    // A deleted file and a rename's old path have no file now; their code from the commit opens.
    await listed.locator('li').nth(1).getByRole('button', { name: '비교 보기', exact: true }).click();
    await diff.getByText('고른 커밋의 코드예요. 지금은 이 경로에 파일이 없어요.', { exact: true }).waitFor();
    await diff.getByText('export const gone = 1;').waitFor();
    await listed.locator('li').nth(3).getByRole('button', { name: '비교 보기', exact: true }).click();
    await diff.getByRole('textbox', { name: '고른 커밋의 코드 (읽기 전용)' }).getByText('export const moved = 1;').waitFor();
    // Back in the reader, the function's steps still lead to their code.
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('evidence-range').innerText()).includes('2–2줄'));
    assert.equal(await page.getByRole('alert').count(), 0);
    // The map marks the boxes of files now and lists every change, the deleted one too.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    const box = name => page.locator('.react-flow__node').filter({ hasText: name });
    await box('edit.ts').getByText('수정', { exact: true }).waitFor({ timeout: 30_000 });
    for (const [name, kind] of [['added.ts', '추가'], ['new-name.ts', '이름 변경'], ['untracked.ts', '미추적']]) await box(name).getByText(kind, { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '변경 목록' }).getByRole('list', { name: '바뀐 파일' }).locator('li').count(), 5);
    await page.screenshot({ path: path.join(artifacts, 'changes-map.png') });
    // Comparing changed nothing in the repository; a file changed afterwards marks the comparison.
    assert.equal(execFileSync('find', [path.join(gitFixture, '.git'), '-exec', 'stat', '-f', '%N %z %m', '{}', '+']).toString(), gitBefore);
    await writeFile(path.join(gitFixture, 'src/edit.ts'), 'export const edit = 3;\n');
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    await page.getByText('비교한 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 비교해 주세요.', { exact: false }).waitFor();
    // After a new commit, comparing again reads the commits again and moves to the new HEAD.
    gitHere('add', 'src/edit.ts');
    gitHere('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'second version', '--', 'src/edit.ts');
    await page.getByRole('button', { name: '다시 비교', exact: true }).click();
    await until(async () => /HEAD · second version$/.test(await page.getByRole('combobox', { name: '기준 커밋' }).locator('option:checked').innerText()));
    await until(async () => !(await listed.locator('li').allInnerTexts()).includes('수정 src/edit.ts 비교 보기'));
    assert.equal(await page.getByRole('combobox', { name: '기준 커밋' }).locator('option').count(), 2);
  });
  await check('Changes: every change reachable past 300, and a side that cannot be opened is said, not taken as added or deleted', async () => {
    await dialogTo(manyFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '많은 변경 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    const listed = page.getByRole('region', { name: '바뀐 파일 목록' }).getByRole('list', { name: '바뀐 파일' });
    await listed.waitFor();
    assert.equal(await listed.locator('li').count(), 300);
    await page.getByRole('region', { name: '바뀐 파일 목록' }).getByRole('button', { name: '2개 더 보기', exact: true }).click();
    assert.equal(await listed.locator('li').count(), 302);
    await listed.locator('li').filter({ hasText: 'big.txt' }).getByRole('button', { name: '비교 보기', exact: true }).click();
    const diff = page.getByRole('region', { name: '고른 변경 비교' });
    await diff.getByText('이전 코드를 열 수 없어요: 이전 코드가 256 KiB를 넘어 열지 않아요.', { exact: true }).waitFor();
    await diff.getByText('지금 코드만 열 수 있어 그것만 보여요.', { exact: true }).waitFor();
    assert.equal(await diff.getByText('고른 커밋에는 없던 파일이에요. 지금 코드예요.', { exact: true }).count(), 0);
  });
  await check('Quitting while files are parsed waits for the workers and ends cleanly', async () => {
    // (a) Closing the window while a large folder opens.
    await dialogTo(bigMapFixture);
    let ended = ending();
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.deepEqual(await endsWithin(ended, '(a) closing the window while a large folder opens'), { code: 0, signal: null });
    // (b) Cancel, then ask to quit twice at once.
    await launch();
    await dialogTo(bigMapFixture);
    ended = ending();
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); electronApp.quit(); });
    assert.deepEqual(await endsWithin(ended, '(b) cancel, then quit twice'), { code: 0, signal: null });
    // (c) While quitting waits for a worker (its answer held back), no new folder or map is started.
    await launch();
    await dialogTo(fixture);
    const opened = await page.evaluate(() => window.learning.openProject());
    assert.equal(opened.ok, true);
    await holdWorkerMessages();
    await dialogTo(second);
    const reopening = page.evaluate(() => window.learning.openProject());
    await until(() => app.evaluate(() => globalThis.testHeld.length > 0));
    ended = ending();
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    const refused = await page.evaluate(id => Promise.all([window.learning.openProject(), window.learning.projectMap({ projectId: id })]), opened.value.id);
    assert.deepEqual(refused.map(result => [result.ok, result.code]), [[false, 'CANCELLED'], [false, 'CANCELLED']]);
    // Only the held scan answer of the folder that was opening: a refused open started no worker.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await app.evaluate(() => globalThis.testHeld.length), 1);
    await releaseWorkerMessages();
    await reopening.catch(() => undefined);
    assert.deepEqual(await endsWithin(ended, '(c) quit while a worker answer is held back'), { code: 0, signal: null });
    // (d) Quitting while the TypeScript checker of a value-shape search runs: the process is ended, the app ends cleanly.
    await launch();
    await dialogTo(bigMapFixture);
    const big = await page.evaluate(() => window.learning.openProject());
    assert.equal(big.ok, true);
    const file = big.value.files.find(item => item.relativePath === 'part0/file0.ts');
    const read = await page.evaluate(input => window.learning.readSource(input), { projectId: big.value.id, fileId: file.id });
    const fn = read.value.analysis.symbols[0].evidence;
    ended = ending();
    void page.evaluate(input => window.learning.valueShapes(input).catch(() => null), { projectId: big.value.id, fileId: file.id,
      fileHash: read.value.hash, startUtf16: fn.startUtf16, endUtf16: fn.endUtf16, names: [] }).catch(() => {});
    await until(() => checkerProcesses() > 0);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    assert.deepEqual(await endsWithin(ended, '(d) quit while the value-shape checker runs'), { code: 0, signal: null });
    assert.equal(checkerProcesses(), 0);
    app = undefined;
  });
  assert.deepEqual(failures, []);
  await writeFile(path.join(artifacts, 'electron-smoke.json'), JSON.stringify({ passed: checks, errors: failures }, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(artifacts, 'electron-failure.png') }).catch(() => {});
  await writeFile(path.join(artifacts, 'electron-smoke.json'), JSON.stringify({ passed: checks, error: String(error), pageErrors: failures }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    // After a failed check the app may still wait for a worker, and close() waits for the app: end it rather than hang.
    const child = app.process();
    let timer;
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 60_000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await rm(temporary, { recursive: true, force: true });
}
