import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
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
// Test harness lives outside the shipped app. Production IPC has no path injection/test API.
const bootstrap = path.join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(root, '.vite/build/main.cjs'))});\n`);
let app;
let page;
const checks = [];
const failures = [];
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
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
function ending() {
  const child = app.process();
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}
// Holds back every message from worker threads started after this, until the test releases them.
async function holdWorkerMessages() {
  await app.evaluate(() => {
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    globalThis.testOriginalOn = Worker.prototype.on;
    globalThis.testHeld = [];
    Worker.prototype.on = function (event, listener) {
      if (event !== 'message') return globalThis.testOriginalOn.call(this, event, listener);
      return globalThis.testOriginalOn.call(this, event, (...values) => { globalThis.testHeld.push(() => listener(...values)); });
    };
  });
}
async function releaseWorkerMessages() {
  await app.evaluate(() => {
    process.getBuiltinModule('node:worker_threads').Worker.prototype.on = globalThis.testOriginalOn;
    globalThis.testReleased = true;
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
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
      await until(async () => await page.evaluate(expected => window.outerWidth === expected, width));
      await page.getByRole('button', { name: '찾기 ⌘F', exact: true }).click();
      await field.waitFor();
      assert.deepEqual(await layoutProblems(), [], `${width}x${height}`);
      await page.screenshot({ path: path.join(artifacts, `reader-tools-${width}.png`) });
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
    await page.getByText('프로젝트를 연 뒤 코드가 바뀌었을 수 있어요. 파일을 다시 읽어 최신 코드를 확인해 주세요.', { exact: true }).waitFor();
    await page.getByText('변경 이력과 수정 전후 비교는 아직 준비 중이에요.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '주문', exact: true }).isEnabled());
    await page.getByRole('button', { name: '달라진 내용', exact: true }).click();
    await page.getByText('변경 이력과 수정 전후 비교는 아직 준비 중이에요.', { exact: true }).waitFor();
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
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await until(async () => await page.getByText('지도를 만든 뒤 파일이 바뀌었거나', { exact: false }).count() === 0
      && await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).isVisible());
    // A change after the map was drawn: the map asks for a re-check and the old position is not highlighted.
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await writeFile(path.join(mapFixture, 'store/load.ts'), "\n" + mapFiles['store/load.ts']);
    await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByText('지도를 만든 뒤 이 파일이 바뀌어 import 위치를 강조하지 않았어요.', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await until(async () => await page.getByText('지도를 만든 뒤 파일이 바뀌었거나', { exact: false }).count() === 0
      && await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).isVisible());
    // Two more changes with a fresh map between them and no file read: the screen's other change states are
    // already set by then, and the map must still be marked each time.
    for (const blankLines of ['\n\n', '\n\n\n']) {
      await writeFile(path.join(mapFixture, 'store/load.ts'), blankLines + mapFiles['store/load.ts']);
      await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
      await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
      await until(async () => await page.getByText('지도를 만든 뒤 파일이 바뀌었거나', { exact: false }).count() === 0
        && await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).isVisible());
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
        const result = { jobId, conversationId: request.conversationId ?? randomUUID(), projectId: request.projectId,
          question: request.question,
          evidence: { id: request.evidenceId, projectId: request.projectId, fileId: randomUUID(),
            fileHash: request.expectedFileHash, startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1 },
          sources: [{ evidence: related, relativePath: 'related.ts' }], limitations: ['시험용 관련 파일 자료입니다.'],
          explanation: { summary: `가짜 설명: ${request.question}`, steps: [],
            claims: [{ kind: 'code', text: '테스트용 설명입니다.', evidenceIds: [request.evidenceId] }], terms: [], unknowns: [] },
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
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 0);
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
    assert.equal(await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue(), question);
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
  await check('Quitting while files are parsed waits for the workers and ends cleanly', async () => {
    // (a) Closing the window while a large folder opens.
    await dialogTo(bigMapFixture);
    let ended = ending();
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.deepEqual(await ended, { code: 0, signal: null });
    // (b) Cancel, then ask to quit twice at once.
    await launch();
    await dialogTo(bigMapFixture);
    ended = ending();
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '작업 취소·프로젝트 닫기' }).click();
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); electronApp.quit(); });
    assert.deepEqual(await ended, { code: 0, signal: null });
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
    assert.deepEqual(await ended, { code: 0, signal: null });
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
  if (app) await app.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
