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
// A separate project keeps the existing screen checks and their file counts unchanged.
const treeFixture = path.join(temporary, '폴더 트리 프로젝트');
await mkdir(path.join(treeFixture, 'api/src'), { recursive: true });
await mkdir(path.join(treeFixture, 'api/test'), { recursive: true });
await writeFile(path.join(treeFixture, 'api/src/main.ts'), 'export function nested(value: number) { if (value < 0) return 0; return value; }\n');
await writeFile(path.join(treeFixture, 'api/test/helper.ts'), 'export const helper = 1;\n');
await writeFile(path.join(treeFixture, 'root.ts'), 'export const root = 1;\n');
// One feature, with a nested event and a hook result, exercises the diagram and steps independently of the full map.
const featureFlowFixture = path.join(temporary, '기능 흐름 프로젝트');
const featureFlowFiles = {
  'web/next.config.ts': 'export default {};',
  'web/app/dogs/page.tsx': "import {DogList} from '../../components/DogList'; export default function DogsPage() { return <DogList />; }",
  'web/components/DogList.tsx': "import {useDeleteDog} from '../lib/dogs'; export function DogList() { const remove = useDeleteDog(); const removeDog = dog => { if (!window.confirm(`${dog.name}의 정보를 삭제할까요?`)) return; remove.mutate(dog.id); }; return dogs.map(dog => <button onClick={() => removeDog(dog)}>삭제</button>); }",
  'web/lib/dogs.ts': "import {useMutation} from 'query'; import {request} from './request'; export function useDeleteDog() { return useMutation({mutationFn: id => request(`/api/dogs/${id}`, {method:'DELETE'}), onSuccess: () => queryClient.setQueryData(key, dogs => dogs.filter(dog => dog.id !== id))}); }",
  'web/lib/request.ts': 'export function request(path, init) { return fetch(path, init); }',
  'api/setup.ts': "app.setGlobalPrefix('api');",
  'api/controller.ts': "import {DogsService} from './service'; @Controller('dogs') export class DogsController { constructor(private dogs: DogsService) {} @Delete(':id') remove(id) { return this.dogs.remove(id); } }",
  'api/service.ts': `export class DogsService {
  remove(id) {
    if (!id) throw new NotFoundException('반려견을 찾을 수 없어요.');
    this.prisma.dog.delete({ where: { id } });
    return this.db.$transaction(async tx => tx.dog.delete(id));
  }
}`,
};
for (const [name, text] of Object.entries(featureFlowFiles)) {
  await mkdir(path.dirname(path.join(featureFlowFixture, name)), { recursive: true });
  await writeFile(path.join(featureFlowFixture, name), text);
}
// A returned hook function connects the form to the original request function.
const loginFlowFixture = path.join(temporary, '로그인 흐름 프로젝트');
const loginFlowFiles = {
  'web/next.config.ts': 'export default {};',
  'web/lib/auth.ts': "export async function login() { return fetch('/api/auth/login', {method: 'POST'}); }",
  'web/lib/provider.ts': "import {login} from './auth'; export function useAuth() { return {login}; }",
  'web/app/login/page.tsx': `import {useAuth} from '../../lib/provider';
export default function LoginPage() {
  const {login} = useAuth();
  async function handleSubmit() {
    await login();
    router.push('/');
  }
  return <form onSubmit={handleSubmit}><button>로그인</button></form>;
}`,
  'api/controller.ts': "@Controller('api/auth') export class AuthController { @Post('login') login() {} }",
};
for (const [name, text] of Object.entries(loginFlowFiles)) {
  await mkdir(path.dirname(path.join(loginFlowFixture, name)), { recursive: true });
  await writeFile(path.join(loginFlowFixture, name), text);
}
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
const unusedMapFixture = path.join(temporary, '안 쓰는 파일 후보 프로젝트');
await mkdir(unusedMapFixture);
await writeFile(path.join(unusedMapFixture, 'orphan.ts'), 'const orphanValue = 42;\n');
await writeFile(path.join(unusedMapFixture, 'html-entry.ts'), 'const htmlEntryValue = 1;\n');
await writeFile(path.join(unusedMapFixture, 'index.html'), '<script src="/html-entry.ts"></script>');
// Nested areas have their own fixture so the existing map counts stay unchanged.
const areaMapFixture = path.join(temporary, '영역 지도 프로젝트');
const areaMapFiles = {
  'web/app/page.ts': "import { value } from '../lib/value';\nexport const page = value;\n",
  'web/lib/value.ts': 'export const value = 1;\n',
  'web/e2e/check.ts': "import { value } from '../lib/value';\nexport const check = value;\n",
  'web/index.ts': 'export const index = 1;\n',
  'api/src/main.ts': 'export const main = 1;\n',
  // The map lists only code files (and files code imports), so the root file is code.
  'root.ts': 'export const root = 1;\n',
};
for (const [name, text] of Object.entries(areaMapFiles)) {
  await mkdir(path.dirname(path.join(areaMapFixture, name)), { recursive: true });
  await writeFile(path.join(areaMapFixture, name), text);
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
// File explanation: 80 top-level chunks, with a nested callback that has no direct chunk of its own.
const fileExplanationFixture = path.join(temporary, '파일 설명 프로젝트');
await mkdir(fileExplanationFixture);
const fileExplanationSource = 'export function run() { [1].map(value => value + 1); return 1; }\n'
  + Array.from({ length: 79 }, (_, index) => `const value${index + 1} = ${index + 1};`).join('\n') + '\n';
await writeFile(path.join(fileExplanationFixture, 'chunks.ts'), fileExplanationSource);
for (let index = 0; index < 6; index++) await writeFile(path.join(fileExplanationFixture, `other${index}.ts`), `export const other${index} = ${index};\n`);
await writeFile(path.join(fileExplanationFixture, 'README.md'), '# 파일 설명 시험\n');
const guideFixture = path.join(temporary, '파일 안내 프로젝트');
await mkdir(path.join(guideFixture, 'src'), { recursive: true });
await writeFile(path.join(guideFixture, 'src/auth.controller.ts'), "@Controller('auth')\nexport class Auth {\n@Post('login') login(input: string) { return this.service.login(input); }\n}\nimport { Service } from './auth.service.js';\n");
await writeFile(path.join(guideFixture, 'src/auth.service.ts'), 'export class Service { login(input: string) { return input; } }\n');
await writeFile(path.join(guideFixture, 'src/broken.ts'), 'const before = 1;\nconst broken = ;\nconst after = 2;');
await writeFile(path.join(guideFixture, 'src/many.ts'), Array.from({ length: 83 }, (_, i) => `const value${i} = ${i};`).join('\n'));
await writeFile(path.join(guideFixture, 'src/functions.ts'), Array.from({ length: 12 }, (_, i) => `export function run${i}() { return ${i}; }`).join('\n') + '\nconst a = () => 1, b = () => 2;\n');
await writeFile(path.join(guideFixture, 'README.md'), '# 파일 안내 시험\n');
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
await writeFile(path.join(callsFixture, 'src/auth.service.ts'), 'export class AuthService { signup(input: string) { return input; } }');
await writeFile(path.join(callsFixture, 'src/auth.controller.ts'), "import { AuthService } from './auth.service.js';\nexport class AuthController { constructor(@Inject(AuthService) private readonly auth: AuthService) {} login(input: string) { return this.auth.signup(input); } }");
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
async function openAiSection(name) {
  const button = page.getByRole('group', { name: 'AI 연결', exact: true }).getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}
async function openFileGuide() {
  const guide = page.getByRole('region', { name: '이 파일 안내', exact: true }).locator('.file-guide');
  if (!await guide.evaluate(element => element.open)) await guide.locator(':scope > summary').click();
  return guide;
}
async function checkPanelLayout(width) {
  const problems = await page.locator('.panel').evaluate(panel => {
    const line = panel.querySelector('.ai-line');
    const bounds = line.getBoundingClientRect();
    const controls = [...line.children];
    const problems = [];
    for (const control of controls) {
      const r = control.getBoundingClientRect();
      if (!r.width || !r.height || r.left < bounds.left - 1 || r.right > bounds.right + 1
        || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1 || control.scrollWidth > control.clientWidth + 1) problems.push(`AI clipped: ${control.textContent}`);
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push('AI controls overlap');
    }
    if (line.scrollWidth > line.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1) problems.push('panel overflows horizontally');
    if (panel.scrollHeight > panel.clientHeight && getComputedStyle(panel).overflowY !== 'auto') problems.push('panel cannot scroll');
    return problems;
  });
  assert.deepEqual(problems, [], `AI panel ${width}px`);
}
async function openFunctionFlow() {
  await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
  if (await page.locator('.symbols__item[aria-pressed="true"]').count() === 0) await page.locator('.symbols__item').first().click();
  await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
}
async function openFileMap() {
  await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
  await page.getByRole('group', { name: '지도 종류', exact: true }).getByRole('button', { name: '파일 연결', exact: true }).click();
}
// Wait for grouping before locating a legacy code-name or AI feature button.
async function openServerFeatures() {
  const list = page.getByRole('region', { name: '기능 목록', exact: true });
  await list.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
  await until(async () => !await list.getByRole('status').filter({ hasText: '화면별로 묶는 중' }).count());
  const details = list.locator('details').filter({ has: page.locator('summary', { hasText: /^서버 주소 기준 목록 \(AI 정리 포함\)$/ }) });
  if (await details.count() && !await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}
async function openScreenFeatures() {
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^화면별로 보기$/ }) });
  await details.waitFor();
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}
// Keep a question about another function ready while the flow displays the server handler.
async function openLoginFlowQuestion() {
  await dialogTo(loginFlowFixture);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('heading', { name: '로그인 흐름 프로젝트', exact: true }).waitFor();
  await openTreeFile('web/lib/auth.ts');
  await page.getByRole('button', { name: 'login', exact: true }).click();
  await openAiSection('질문하기');
  await page.getByTestId('question-scope').waitFor();
  const question = page.getByRole('textbox', { name: '선택한 코드에 질문' });
  await question.fill('기존 질문 유지');
  await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
  await openScreenFeatures();
  await page.getByRole('region', { name: '화면 /login', exact: true }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
  const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
  await story.getByRole('button', { name: '4단계 서버 받는 곳', exact: true }).click();
  await until(async () => /api\/controller.ts/.test(await story.getByTestId('evidence-range').innerText()));
  await until(() => story.getByRole('button', { name: 'AI에게 쉽게 물어보기', exact: true }).isEnabled());
  return { story, question, ask: story.getByRole('button', { name: 'AI에게 쉽게 물어보기', exact: true }) };
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
// All three consent forms keep the full disclosure available through the checkbox even while it is folded.
async function checkConsentDisclosure(container, expectedText) {
  const checkbox = container.getByRole('checkbox', { name: '보낼 자료에 동의', exact: true });
  const details = container.locator('.consent-details');
  const description = details.locator('p');
  assert.equal(await details.evaluate(element => element.open), false);
  assert.equal(await description.isVisible(), false);
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await checkbox.getAttribute('aria-describedby'), await description.getAttribute('id'));
  assert.equal(await description.textContent(), expectedText);
  const summary = details.locator('summary');
  assert.equal(await summary.innerText(), '무엇을 보내나요?');
  await summary.focus();
  await summary.press('Enter');
  assert.equal(await description.isVisible(), true);
  assert.equal(await description.innerText(), expectedText);
  assert.equal(await checkbox.isChecked(), false);
  await summary.press('Enter');
  assert.equal(await description.isVisible(), false);
}
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
// Wait for the media query and CSS together; React Flow updates are checked at the canvas.
async function setTheme(mode) {
  await app.evaluate(({ nativeTheme }, mode) => { nativeTheme.themeSource = mode; }, mode);
  const background = mode === 'light' ? 'rgb(247, 250, 253)' : 'rgb(20, 22, 26)';
  await page.waitForFunction(({ mode, background }) =>
    matchMedia(`(prefers-color-scheme: ${mode})`).matches
      && getComputedStyle(document.documentElement).backgroundColor === background, { mode, background });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light dark');
}
// Checks run in dark then light; the app goes back to following macOS afterwards, even when a check fails.
async function eachTheme(check) {
  try {
    for (const mode of ['dark', 'light']) {
      await setTheme(mode);
      await check(mode);
    }
  } finally {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  }
}
async function dialogTo(folder) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
}
// Reopening the same folder resets the tree only when the scan finishes, so a folder opened before then closes again.
// File buttons stay disabled while the scan runs, so a visible, enabled file is one from the new tree.
async function openTreeFile(relativePath) {
  // The file tree shows only in code reading, and a finishing scan returns to the overview, so the tab is checked on every pass.
  const codeTab = page.getByRole('button', { name: '코드 읽기', exact: true });
  const file = page.getByRole('button', { name: relativePath, exact: true });
  const folders = relativePath.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  const deadline = Date.now() + 8000;
  while (!(await file.isVisible() && await file.isEnabled())) {
    if (Date.now() > deadline) throw new Error(`Timed out showing ${relativePath} in the file tree`);
    if (await codeTab.getAttribute('aria-current') !== 'page') await codeTab.click({ timeout: 1000 }).catch(() => {});
    for (const folder of folders) {
      const button = page.getByRole('button', { name: `폴더 ${folder}`, exact: true });
      // The tree can be redrawn between these calls, so a vanished button is tried again on the next pass.
      const expanded = await button.getAttribute('aria-expanded', { timeout: 200 }).catch(() => null);
      if (expanded === 'false') await button.click({ timeout: 1000 }).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  await file.click();
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
  // Playwright pretends the system is light unless told not to; null lets nativeTheme reach the page as on a real Mac.
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root,
    chromiumSandbox: true, timeout: 30_000, colorScheme: null });
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
  await check('System themes keep the read-only promise without a status bar', async () => {
    await eachTheme(async mode => {
      await page.screenshot({ path: path.join(artifacts, `${mode}-welcome.png`) });
    });
    assert.equal(await page.getByRole('contentinfo', { name: '작업 상태' }).count(), 0);
    await page.getByText('원본 파일을 수정하지 않아요.', { exact: true }).waitFor();
    await page.getByText('‘코드 읽기’에서 읽을 파일을 골라요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '보기', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '파일 목록', exact: true }).count(), 0);
    assert.equal(await page.locator('.topbar').getByText('AI는 동의한 질문만').count(), 0);
  });
  await dialogTo(fixture);
  await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
  await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
  await check('Open a real folder; secret filenames excluded', async () => {
    assert.equal(await page.locator('.views__item').count(), 5);
    assert.equal(await page.getByRole('contentinfo', { name: '작업 상태' }).count(), 0);
    const menu = page.getByRole('navigation', { name: '보기', exact: true });
    assert.deepEqual(await menu.locator(':scope > *').allTextContents(),
      ['한눈에 보기', '흐름 따라가기', '코드 읽기', '더 보기', '프로젝트 지도', '달라진 내용']);
    assert.equal(await menu.locator('p.views__more').getAttribute('aria-hidden'), null);
    assert.deepEqual(await menu.locator('.views__item--more').allTextContents(), ['프로젝트 지도', '달라진 내용']);
    for (const button of await menu.locator('.views__item--more').all()) assert.equal(await button.isVisible(), true);
    const tabTops = await menu.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
    assert.ok(tabTops.every(top => Math.abs(top - tabTops[0]) < 0.5));
    assert.ok(tabTops[0] >= await page.locator('.topbar').evaluate(element => element.getBoundingClientRect().bottom));
    assert.equal(await page.locator('.topbar .badge').innerText(), '읽기 전용');
    assert.equal(await page.getByRole('button', { name: '한눈에 보기', exact: true }).getAttribute('aria-current'), 'page');
    const files = page.getByRole('region', { name: '파일 목록', exact: true });
    assert.equal(await files.count(), 0);
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await files.waitFor();
    await files.getByRole('button', { name: 'order.ts', exact: true }).waitFor();
    assert.equal(await files.getByRole('button', { name: '.env', exact: true }).count(), 0);
    assert.equal(await files.getByRole('button', { name: 'auth.json', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).waitFor();
    assert.equal(await page.locator('.code-step-marker').count(), 0);
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('navigation', { name: '현재 학습 위치', exact: true }).innerText(), 'order.ts');
  });
  await check('File guidance starts collapsed above the reader and keeps its state independently of the AI panel', async () => {
    const panel = page.locator('aside[aria-label="AI 질문"]');
    assert.deepEqual(await panel.locator(':scope > *').evaluateAll(elements => elements.map(element => element.className)),
      ['panel__head', 'panel__body ai-panel', 'card']);
    assert.equal(await panel.locator('.file-guide, .scope, [aria-label="설명"]').count(), 0);
    assert.equal(await panel.getByText('이 파일은', { exact: true }).count(), 0);
    assert.equal(await panel.getByText('현재 범위', { exact: true }).count(), 0);
    await panel.getByRole('group', { name: 'AI 연결', exact: true }).waitFor();
    await panel.getByRole('button', { name: '질문하기', exact: true }).waitFor();
    await panel.getByText('AI로 이 파일 설명 만들기', { exact: true }).waitFor();
    const region = page.getByRole('region', { name: '이 파일 안내', exact: true });
    const guide = region.locator('.file-guide');
    assert.equal(await guide.evaluate(element => element.open), false);
    assert.equal(await region.getByText('코드에서 확인됨', { exact: true }).count(), 0);
    assert.equal(await region.getByText('함수나 구문을 고르면', { exact: false }).count(), 0);
    await openFileGuide();
    await guide.getByText('이 파일의 함수 1개', { exact: true }).waitFor();
    await guide.getByText('주문', { exact: true }).waitFor();
    assert.equal(await region.evaluate(element => element.getBoundingClientRect().height <= innerHeight * 0.4 + 1), true);
    assert.ok(await page.locator('.reader__body').evaluate(element => element.getBoundingClientRect().height) > 0);
    await page.getByRole('button', { name: 'loop.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'loop.ts', exact: true }).waitFor();
    assert.equal(await guide.evaluate(element => element.open), true);
    await guide.getByText('모두', { exact: true }).waitFor();
    await guide.locator(':scope > summary').click();
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'order.ts', exact: true }).waitFor();
    assert.equal(await guide.evaluate(element => element.open), false);
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await region.getByText('코드에서 확인됨', { exact: true }).waitFor();
    assert.match(await region.locator('.fact').innerText(), /주문 함수는 원본 1–6줄/);
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await region.isVisible(), true);
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
  });
  await check('Top navigation fits narrow windows with and without files and the AI panel', async () => {
    for (const width of [760, 1000]) {
      await until(async () => {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        return await page.evaluate(expected => window.outerWidth === expected, width);
      });
      for (const [name, panelOpen] of [['한눈에 보기', false], ['한눈에 보기', true], ['코드 읽기', false], ['코드 읽기', true]]) {
        await page.getByRole('button', { name, exact: true }).click();
        await page.getByRole('button', { name: panelOpen ? 'AI 칸 펼치기' : 'AI 칸 접기', exact: true }).click();
        assert.equal(await page.locator('.panel').isVisible(), panelOpen);
        assert.equal(await page.getByRole('region', { name: '파일 목록', exact: true }).count(), name === '코드 읽기' ? 1 : 0);
        const heading = page.locator('.topbar').getByRole('heading', { name: '한글 프로젝트', exact: true });
        assert.equal(await heading.isVisible(), true);
        assert.equal(await page.locator('.topbar .badge').isVisible(), true);
        const problems = await page.evaluate(() => {
          const problems = [];
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) problems.push('page overflows horizontally');
          for (const element of document.querySelectorAll('.topbar h2, .topbar .badge')) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) problems.push(`hidden: ${element.textContent}`);
          }
          const tabs = document.querySelector('.views');
          const buttons = [...tabs.querySelectorAll('button')];
          const top = buttons[0].getBoundingClientRect().top;
          if (buttons.some(button => Math.abs(button.getBoundingClientRect().top - top) > 0.5)) problems.push('tabs wrap');
          if (tabs.getBoundingClientRect().top < document.querySelector('.topbar').getBoundingClientRect().bottom) problems.push('tabs overlap top bar');
          if (getComputedStyle(tabs).overflowX !== 'auto') problems.push('tabs cannot scroll');
          return problems;
        });
        assert.deepEqual(problems, [], `${width}px, ${name}, panel ${panelOpen}`);
      }
    }
    await until(async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
      return await page.evaluate(() => window.outerWidth === 1280);
    });
  });
  await check('Function → branch → exact original code range (CRLF/emoji/BOM)', async () => {
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await page.getByRole('button', { name: '조건 확인', exact: true }).click();
    await page.getByRole('region', { name: '이 파일 안내', exact: true }).getByText('코드에서 확인됨', { exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: '이 파일 안내', exact: true }).locator('.fact').innerText(),
      /주문 함수 안의 조건 확인 부분이에요. 원본 2–4줄에 있어요./);
    const label = await page.getByTestId('evidence-range').innerText();
    assert.doesNotMatch(label, /UTF-16/);
    const offsets = (await page.getByTestId('evidence-range').getAttribute('data-utf16')).match(/^(\d+),(\d+)$/);
    assert.ok(offsets);
    const selected = source.slice(Number(offsets[1]), Number(offsets[2]));
    assert.equal(selected, 'if (수량 < 1) {\r\n\t\treturn "실패 📦";\r\n\t}');
    assert.equal(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n')), source.slice(0, -2) + '\r\n');
    await page.locator('.cm-selectionBackground').first().waitFor();
    await eachTheme(async mode => {
      assert.equal(await page.locator('.cm-selectionBackground').first().evaluate(element => getComputedStyle(element).backgroundColor),
        mode === 'dark' ? 'rgb(51, 44, 28)' : 'rgb(220, 235, 255)');
      assert.equal(await page.locator('.cm-editor').evaluate(element => getComputedStyle(element).backgroundColor),
        mode === 'dark' ? 'rgb(31, 34, 40)' : 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(artifacts, `${mode}-code-reader.png`) });
      if (mode === 'light') {
        const guide = await openFileGuide();
        await page.screenshot({ path: path.join(artifacts, 'light-file-guide.png') });
        await guide.locator(':scope > summary').click();
      }
    });
    await page.screenshot({ path: path.join(artifacts, 'local-code-flow.png') });
  });
  await check('Step gutter matches the outline, selects evidence and locks while busy', async () => {
    const markers = page.locator('.code-step-marker');
    assert.deepEqual(await markers.allTextContents(), ['1', '2', '3']);
    assert.equal(await markers.count(), await page.locator('.steps__item').count());
    assert.equal(await markers.nth(0).getAttribute('title'), '1단계 · 조건 확인');
    assert.equal(await markers.nth(0).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await markers.evaluateAll(elements => elements.map(element => element.tabIndex)), [-1, -1, -1]);
    assert.ok(await page.locator('.cm-step-gutter').evaluate(element =>
      element.getBoundingClientRect().right <= document.querySelector('.cm-lineNumbers').getBoundingClientRect().left));
    await eachTheme(async mode => {
      assert.deepEqual(await markers.nth(0).evaluate(element => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]),
        mode === 'dark' ? ['rgb(240, 180, 76)', 'rgb(26, 19, 0)'] : ['rgb(40, 94, 172)', 'rgb(255, 255, 255)']);
      assert.equal(await markers.nth(1).evaluate(element => getComputedStyle(element).backgroundColor),
        mode === 'dark' ? 'rgb(35, 39, 46)' : 'rgb(239, 245, 252)');
    });
    await markers.nth(1).click();
    await until(async () => /order.ts · 3–3줄/.test(await page.getByTestId('evidence-range').innerText()));
    assert.equal(await page.locator('.steps__item').nth(1).getAttribute('aria-pressed'), 'true');
    assert.equal(await markers.nth(1).getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(artifacts, 'reader-step-markers.png') });
    // Delay the existing evidence handler so another marker click happens while the reader is busy.
    await app.evaluate(({ ipcMain }) => {
      globalThis.testStepEvidence = ipcMain._invokeHandlers.get('learning:evidence');
      globalThis.testStepCalls = 0;
      const gate = new Promise(resolve => { globalThis.releaseStepEvidence = resolve; });
      ipcMain.removeHandler('learning:evidence');
      ipcMain.handle('learning:evidence', async (event, request) => {
        globalThis.testStepCalls++;
        await gate;
        return globalThis.testStepEvidence(event, request);
      });
    });
    try {
      await markers.nth(0).click();
      await until(async () => await markers.nth(2).isDisabled());
      await markers.nth(2).evaluate(element => element.click());
      assert.equal(await app.evaluate(() => globalThis.testStepCalls), 1);
      assert.equal(await page.locator('.steps__item').nth(1).getAttribute('aria-pressed'), 'true');
    } finally {
      await app.evaluate(({ ipcMain }) => {
        globalThis.releaseStepEvidence();
        ipcMain.removeHandler('learning:evidence');
        ipcMain.handle('learning:evidence', globalThis.testStepEvidence);
      });
    }
    await until(async () => await markers.nth(0).isEnabled() && await markers.nth(0).getAttribute('aria-pressed') === 'true');
    assert.match(await page.getByTestId('evidence-range').innerText(), /order.ts · 2–4줄/);
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
    assert.equal(await page.locator('.code-step-marker').count(), 0);
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
    for (const [width, height] of [[1280, 800], [1440, 900], [1000, 900]]) {
      // The resize is asked for again while waiting: a single request was sometimes not applied (cause not found).
      await until(async () => {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
        return await page.evaluate(expected => window.outerWidth === expected, width);
      });
      await page.getByRole('button', { name: '찾기 ⌘F', exact: true }).click();
      await field.waitFor();
      assert.deepEqual(await layoutProblems(), [], `${width}x${height}`);
      const workspaceProblems = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('.views__item, .topbar .btn, .reader__head .btn')];
        const problems = [];
        for (const element of elements) {
          const r = element.getBoundingClientRect();
          if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight || element.scrollWidth > element.clientWidth + 1) problems.push(`clipped: ${element.textContent || element.ariaLabel}`);
        }
        for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
          const a = elements[i].getBoundingClientRect(), b = elements[j].getBoundingClientRect();
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(`overlap: ${elements[i].textContent} / ${elements[j].textContent}`);
        }
        const center = document.querySelector('.center').getBoundingClientRect();
        const panel = document.querySelector('.panel').getBoundingClientRect();
        if (panel.bottom > innerHeight + 0.5 || center.bottom > innerHeight + 0.5) problems.push('workspace goes past the window');
        if (innerWidth <= 1100 && panel.top < center.bottom - 0.5) problems.push('panel did not stack');
        return problems;
      });
      assert.deepEqual(workspaceProblems, [], `workspace ${width}x${height}`);
      await checkPanelLayout(width);
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
    for (const name of ['한눈에 보기', '흐름 따라가기', '프로젝트 지도', '달라진 내용']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
      assert.equal(await page.getByRole('region', { name: '파일 목록', exact: true }).count(), 0);
    }
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '조건 확인', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('evidence-range').innerText(), evidence);
  });
  await check('Flow view walks one function step by step, marks unknown links and returns to the same code', async () => {
    await openFunctionFlow();
    assert.equal(await page.getByRole('region', { name: '파일 목록', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
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
    const offsets = (await page.getByTestId('evidence-range').getAttribute('data-utf16')).match(/^(\d+),(\d+)$/);
    assert.ok(offsets);
    assert.equal(source.slice(Number(offsets[1]), Number(offsets[2])), 'return "실패 📦";');
    await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
    await card.getByText('"실패 📦"', { exact: true }).waitFor();

    // Choosing another file keeps the flow view; returns and throws are listed without claiming the function ends there.
    await page.getByRole('button', { name: 'loop.ts', exact: true }).click();
    await page.getByRole('button', { name: '모두', exact: true }).click();
    const summary = page.getByRole('article', { name: '함수 요약' });
    await summary.getByRole('button', { name: '6. 오류 던지기', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
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
    await page.locator('.overview-stale').getByText('다시 확인 필요:', { exact: false }).waitFor();
    await eachTheme(async mode => {
      await page.screenshot({ path: path.join(artifacts, `${mode}-overview.png`) });
    });
    await page.screenshot({ path: path.join(artifacts, 'local-overview.png') });
    const starts = page.getByRole('region', { name: '어디부터 읽을까요?' });
    const noServer = page.getByText('서버 코드(요청을 받는 곳)를 찾지 못해서 기능별로 따라갈 수 없어요.', { exact: false });
    await noServer.waitFor();
    assert.equal(await page.locator('details[aria-label="더 알아보기"]').evaluate(element => element.open), true);
    // The notice points down to the start candidates, so they must come after it on the page.
    assert.equal(await noServer.evaluate(element =>
      !!(element.compareDocumentPosition(document.getElementById('overview-start')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await starts.getByRole('button', { name: '주문 order.ts', exact: true }).click();
    await page.getByRole('article', { name: '함수 요약' }).getByRole('heading', { name: '주문', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
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
    assert.equal(await page.locator('.code-step-marker').count(), 3);
    assert.equal(await page.locator('.code-step-marker:not(:disabled)').count(), 0);
    await page.locator('.code-step-marker').first().evaluate(element => element.click());
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    assert.equal(await page.locator('.steps__item[aria-pressed="true"]').count(), 0);
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
  await check('File tree: disclosures, filtered ancestors, same-file reread, flow evidence and reopening', async () => {
    await dialogTo(treeFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '폴더 트리 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    const files = page.getByRole('region', { name: '파일 목록', exact: true });
    const api = files.getByRole('button', { name: '폴더 api', exact: true });
    const src = files.getByRole('button', { name: '폴더 api/src', exact: true });
    const main = files.getByRole('button', { name: 'api/src/main.ts', exact: true });
    const helper = files.getByRole('button', { name: 'api/test/helper.ts', exact: true });
    const search = page.getByRole('searchbox', { name: '파일명 검색', exact: true });
    assert.equal(await files.getByRole('button', { name: 'root.ts', exact: true }).isVisible(), true);
    assert.equal(await api.getAttribute('aria-expanded'), 'false');
    assert.equal(await main.isVisible(), false);
    await api.focus();
    await api.press('Enter');
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    const controlled = await api.getAttribute('aria-controls');
    assert.equal(await page.locator(`[id="${controlled}"]`).isVisible(), true);
    assert.equal(await src.getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    assert.equal(await src.getAttribute('aria-expanded'), 'false');
    await src.click();
    assert.equal(await main.isVisible(), true);
    assert.equal(await main.innerText(), 'main.ts');
    assert.equal(await main.getAttribute('title'), 'api/src/main.ts');
    await api.click();
    // Searching opens only matching ancestors and does not change the saved disclosure state.
    await search.fill('HELPER');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    assert.equal(await files.count(), 0);
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    assert.equal(await search.inputValue(), 'HELPER');
    assert.equal(await helper.isVisible(), true);
    assert.equal(await main.isVisible(), false);
    assert.equal(await files.getByRole('button', { name: /^폴더 / }).count(), 0);
    assert.deepEqual(await files.locator('.files__folder').allTextContents(), ['▾ api', '▾ test']);
    await search.fill('');
    assert.equal(await api.getAttribute('aria-expanded'), 'false');
    assert.equal(await helper.isVisible(), false);
    await search.fill('no-such-file');
    await files.getByText('검색과 일치하는 파일이 없어요.', { exact: true }).waitFor();
    // Opening from search, including reading the same file again, expands its ancestors permanently.
    for (let attempt = 0; attempt < 2; attempt++) {
      await search.fill('MAIN.TS');
      await main.click();
      await page.getByRole('heading', { name: 'api/src/main.ts', exact: true }).waitFor();
      await page.waitForFunction(() => {
        const button = document.querySelector('.files button[aria-label="api/src/main.ts"]');
        return button?.getAttribute('aria-current') === 'true' && !button.disabled;
      });
      await search.fill('');
      await main.waitFor({ state: 'visible' });
      assert.equal(await api.getAttribute('aria-expanded'), 'true');
      assert.equal(await src.getAttribute('aria-expanded'), 'true');
      assert.equal(await main.getAttribute('aria-current'), 'true');
      await api.click();
      assert.equal(await main.isVisible(), false);
    }
    // The flow symbol opens evidence through showEvidence, without going through readFile.
    await openFunctionFlow();
    await page.getByRole('button', { name: 'nested', exact: true }).click();
    await page.getByRole('article', { name: '함수 요약', exact: true }).waitFor();
    await main.waitFor({ state: 'visible' });
    assert.equal(await main.getAttribute('aria-current'), 'true');
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    assert.equal(await src.getAttribute('aria-expanded'), 'true');
    // Reopening even the same project clears the disclosure state.
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '한눈에 보기', exact: true }).getAttribute('aria-current') === 'page');
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.files button[aria-label="폴더 api"]')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await main.isVisible(), false);
  });
  await check('Feature guide: overview, seven story steps, route search, diagram, code and question preservation', async () => {
    await dialogTo(featureFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
    await openTreeFile('api/controller.ts');
    await page.getByRole('button', { name: 'DogsController.remove', exact: true }).click();
    // The question scope is visible once its input area is open.
    await openAiSection('질문하기');
    await page.getByTestId('question-scope').waitFor();
    const scope = await page.getByTestId('question-scope').innerText();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
    const overview = page.getByRole('region', { name: '큰 그림', exact: true });
    await overview.getByText('기능 1개', { exact: true }).waitFor();
    const picture = await overview.innerText();
    for (const text of [/화면 1개/, /요청 1개/, /확실히 이어짐 1개 · 추정 0개/, /api 폴더/, /web 폴더/]) assert.match(picture, text);
    const recommendation = page.getByRole('region', { name: '처음 따라갈 기능', exact: true });
    await recommendation.getByText('지우기 · /api/dogs/:id', { exact: true }).waitFor();
    await recommendation.getByText('‘삭제’ 버튼 · 지우기', { exact: true }).waitFor();
    await recommendation.getByText('버튼 문구', { exact: true }).waitFor();
    await recommendation.getByText('화면 /dogs · web/components/DogList.tsx onClick 함수 (1행)', { exact: true }).waitFor();
    await recommendation.getByRole('button', { name: '이 기능부터 따라가기', exact: true }).click();
    await page.getByRole('region', { name: '기능 따라가기', exact: true }).getByText('1 / 7 · 화면', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    const index = page.getByRole('region', { name: '기능 목차', exact: true });
    await index.waitFor();
    const indexGroup = index.locator('details').first();
    assert.equal(await indexGroup.evaluate(element => element.open), false);
    await indexGroup.locator(':scope > summary').click();
    const indexedName = await indexGroup.locator('li > b').innerText();
    await indexGroup.getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    await page.getByRole('region', { name: '기능 따라가기', exact: true }).getByText('1 / 7 · 화면', { exact: true }).waitFor();
    const indexedStory = page.getByRole('region', { name: '기능 따라가기', exact: true });
    assert.equal(await indexedStory.locator(':scope > .map-actions > h3').innerText(), indexedName);
    assert.equal(await indexedStory.locator(':scope > .map-actions + p').innerText(), '지우기 · /api/dogs/:id');
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await openServerFeatures();
    const route = page.getByRole('region', { name: '기능 목록', exact: true }).getByRole('listitem').filter({ hasText: '지우기 · /api/dogs/:id' }).getByRole('button', { name: '이 기능 따라가기', exact: true });
    await route.waitFor();
    const connection = page.getByRole('region', { name: '기능 목록', exact: true }).getByText('요청 코드와 이어짐', { exact: true });
    await connection.waitFor();
    assert.equal(await connection.getAttribute('title'), '프론트 요청 확실 1곳 · 추정 0곳');
    assert.equal(await page.getByRole('button', { name: '다시 찾기', exact: true }).count(), 0);
    const more = page.locator('details[aria-label="더 알아보기"]');
    assert.equal(await more.evaluate(element => element.open), false);
    assert.equal(await page.getByRole('contentinfo', { name: '작업 상태' }).count(), 0);
    await more.locator(':scope > summary').click();
    const candidate = more.locator('.starts__item').first();
    const anchor = await candidate.getAttribute('data-anchor');
    await candidate.click();
    const topic = page.getByRole('region', { name: '학습 주제' });
    await topic.waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    assert.equal(await more.evaluate(element => element.open), false);
    await topic.getByRole('button', { name: '한눈에 보기로', exact: true }).click();
    await until(() => page.evaluate(anchor => document.activeElement?.getAttribute('data-anchor') === anchor, anchor));
    assert.equal(await more.evaluate(element => element.open), true);
    assert.equal(await candidate.isVisible(), true);
    await topic.getByRole('button', { name: '주제 닫기', exact: true }).click();
    await openTreeFile('api/controller.ts');
    await page.getByRole('button', { name: 'DogsController.remove', exact: true }).click();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await page.getByRole('textbox', { name: '기능 검색' }).fill('missing');
    assert.equal(await route.count(), 0);
    await page.getByRole('textbox', { name: '기능 검색' }).fill('dogs');
    await route.waitFor();
    await page.getByRole('textbox', { name: '기능 검색' }).fill('지우기');
    await openServerFeatures();
    await route.click();
    const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
    await story.getByText('화면 /dogs에서 ‘삭제’ 버튼을 누르면 시작해요', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    await story.getByText('1 / 7 · 화면', { exact: true }).waitFor();
    await page.getByTestId('story-step').getByRole('heading', { name: '화면 동작에서 시작해요', exact: true }).waitFor();
    assert.match(await page.getByTestId('story-step').innerText(), /1 \/ 7 · 화면/);
    assert.match(await page.getByTestId('story-step').innerText(), / · web\/components\/DogList.tsx \d+–\d+행/);
    await story.getByRole('heading', { name: '화면 동작에서 시작해요', exact: true }).waitFor();
    const location = story.getByRole('list', { name: '지금 여기', exact: true });
    assert.match(await location.locator('[aria-current="location"]').innerText(), /화면 쪽/);
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    assert.equal(await story.getByRole('button', { name: '◀ 이전', exact: true }).isDisabled(), true);
    assert.equal(await story.getByRole('navigation', { name: '이야기 단계' }).getByRole('button').count(), 9);
    const windowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    for (const width of [1000, 1280, 1440]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const nav = story.getByRole('navigation', { name: '이야기 단계' });
      const bounds = await nav.boundingBox();
      const buttons = await Promise.all((await nav.getByRole('button').all()).map(button => button.boundingBox()));
      assert.equal(buttons.length, 9);
      assert.ok(buttons.every(Boolean));
      const previous = buttons[0], next = buttons.at(-1);
      assert.ok(Math.abs(previous.y - next.y) <= 1, `next stayed beside previous at ${width}px`);
      assert.ok(buttons.slice(1, -1).some(button => Math.abs(button.y - next.y) <= 1), `next shares a row with steps at ${width}px`);
      for (const [index, button] of buttons.entries()) {
        assert.ok(button.width > 0 && button.height > 0);
        assert.ok(button.x >= bounds.x - 1 && button.x + button.width <= bounds.x + bounds.width + 1, `button fits at ${width}px`);
        assert.ok(button.y >= bounds.y - 1 && button.y + button.height <= bounds.y + bounds.height + 1);
        for (const other of buttons.slice(index + 1)) {
          assert.ok(button.x + button.width <= other.x + 1 || other.x + other.width <= button.x + 1
            || button.y + button.height <= other.y + 1 || other.y + other.height <= button.y + 1, `buttons do not overlap at ${width}px`);
        }
      }
      assert.equal(await nav.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await checkPanelLayout(width);
    }
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), windowSize);
    await story.getByRole('button', { name: '다음 ▶', exact: true }).click();
    await story.getByText('2 / 7 · 프론트 처리', { exact: true }).waitFor();
    await story.getByRole('heading', { name: '화면 쪽 코드가 요청을 준비해요', exact: true }).waitFor();
    assert.match(await story.locator('[data-kind="front"]').innerText(), /removeDog → useDeleteDog → mutationFn/);
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    assert.match(await story.getByTestId('evidence-range').innerText(), /web\/lib\/dogs.ts/);
    const confirmation = story.getByRole('region', { name: '다른 경우', exact: true });
    await confirmation.getByText('‘…의 정보를 삭제할까요?’ 확인 창에서 취소하면 여기서 멈춰요', { exact: false }).waitFor();
    await confirmation.getByRole('button', { name: '이 줄 보기', exact: true }).click();
    await until(async () => /web\/components\/DogList.tsx · 1–1줄/.test(await story.getByTestId('evidence-range').innerText()));
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    await story.getByTestId('flow-code').locator('.cm-content').focus();
    await until(async () => await page.evaluate(() => getSelection()?.toString()) === 'if (!window.confirm(`${dog.name}의 정보를 삭제할까요?`)) return;');
    const functions = story.getByRole('group', { name: '이 단계의 함수' }).getByRole('button');
    await functions.nth(1).click();
    const selectedName = await functions.nth(1).innerText();
    const explanation = page.getByTestId('story-step');
    assert.match(await explanation.innerText(), /2 \/ 7 · 프론트 처리/);
    assert.equal(await page.locator('.panel [data-testid="flow-step-explanation"]').count(), 0);
    assert.ok((await explanation.innerText()).includes(`${selectedName} · `));
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    const selectedEvidence = await story.getByTestId('evidence-range').innerText();
    await story.getByRole('button', { name: '이 함수 안 순서', exact: true }).click();
    await page.getByRole('heading', { name: '함수 안 순서', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '이 파일 안내', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await story.getByText('2 / 7 · 프론트 처리', { exact: true }).waitFor();
    assert.equal(await story.getByRole('group', { name: '이 단계의 함수' }).getByRole('button', { name: selectedName, exact: true }).getAttribute('aria-pressed'), 'true');
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    assert.equal(await story.getByTestId('evidence-range').innerText(), selectedEvidence);
    await story.getByRole('button', { name: '3단계 요청', exact: true }).click();
    await story.getByText('DELETE /api/dogs/${id} 요청을 보내요', { exact: true }).waitFor();
    assert.equal(await location.locator('.picture__arrow[aria-current="location"]').count(), 1);
    await location.getByText('부탁(요청)이 가는 중', { exact: true }).waitFor();
    assert.equal(await story.getByRole('button', { name: '이 함수 안 순서', exact: true }).count(), 0);
    await story.getByRole('button', { name: '4단계 서버 받는 곳', exact: true }).click();
    await story.getByText('DogsController.remove가 요청을 받아요 → DogsService.remove에 넘겨요', { exact: true }).waitFor();
    assert.match(await story.innerText(), /타입으로 찾음/);
    await page.getByTestId('story-step').getByText('타입으로 찾음', { exact: true }).waitFor();
    await story.getByRole('button', { name: '5단계 서버 처리', exact: true }).click();
    await story.getByText('5 / 7 · 서버 처리', { exact: true }).waitFor();
    assert.match(await location.locator('[aria-current="location"]').innerText(), /서버 쪽/);
    const stops = story.getByRole('region', { name: '다른 경우', exact: true });
    await stops.getByRole('heading', { name: '다른 경우 1개', exact: true }).waitFor();
    await stops.getByRole('button', { name: '이 줄 보기', exact: true }).click();
    await until(async () => /api\/service.ts · 3–3줄/.test(await story.getByTestId('evidence-range').innerText()));
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    const outside = story.locator('details').filter({ has: page.locator('summary', { hasText: /^코드에서 부르는 다른 것/ }) });
    assert.equal(await outside.getAttribute('open'), null);
    await outside.locator('summary').click();
    assert.match(await outside.innerText(), /안쪽 함수에서 tx.dog.delete/);
    const sixth = story.getByRole('button', { name: '6단계 저장소', exact: true });
    assert.equal(await sixth.innerText(), '⑥ 저장소');
    await sixth.click();
    await story.getByText('6 / 7 · 저장소', { exact: true }).waitFor();
    await story.getByRole('heading', { name: '저장소(DB)를 써요', exact: true }).waitFor();
    const storage = story.getByRole('region', { name: '저장소 호출', exact: true });
    const storeNote = await storage.getByText('Prisma 호출 모양으로 찾았어요.', { exact: false }).innerText();
    await page.getByTestId('story-step').getByText(storeNote, { exact: true }).waitFor();
    await storage.getByRole('button', { name: '이 줄 보기', exact: true }).first().click();
    await until(async () => /api\/service.ts · 4–4줄/.test(await story.getByTestId('evidence-range').innerText()));
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await story.getByRole('button', { name: '다음 ▶', exact: true }).isDisabled(), false);
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    assert.match(await story.getByTestId('evidence-range').innerText(), /api\/service.ts/);
    await story.getByRole('button', { name: '7단계 화면 결과', exact: true }).click();
    await story.getByText('7 / 7 · 화면 결과', { exact: true }).waitFor();
    const after = story.getByRole('region', { name: '응답 뒤 화면', exact: true });
    const afterNote = await after.getByText('코드 모양(onSuccess, await 다음 줄, catch)으로 찾았어요.', { exact: false }).innerText();
    await page.getByTestId('story-step').getByText(afterNote, { exact: true }).waitFor();
    await after.getByText('저장해 둔 데이터 바로 바꾸기', { exact: false }).waitFor();
    await after.getByRole('button', { name: '이 줄 보기', exact: true }).click();
    await until(async () => /web\/lib\/dogs.ts · 1–1줄/.test(await story.getByTestId('evidence-range').innerText()));
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    await story.getByTestId('flow-code').locator('.cm-content').focus();
    await until(async () => await page.evaluate(() => getSelection()?.toString()) === 'queryClient.setQueryData(key, dogs => dogs.filter(dog => dog.id !== id))');
    assert.equal(await story.getByRole('button', { name: '다음 ▶', exact: true }).isDisabled(), true);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    const summary = story.getByRole('region', { name: '한 문장으로 정리', exact: true });
    await summary.getByRole('textbox', { name: '받는 것', exact: true }).fill('삭제 요청');
    await summary.getByRole('textbox', { name: '확인하는 것', exact: true }).fill('반려견 정보');
    await summary.getByRole('textbox', { name: '돌려주는 것', exact: true }).fill('삭제 결과');
    assert.equal(await summary.getByTestId('summary-sentence').innerText(), '이 기능은 삭제 요청을(를) 받아서, 반려견 정보을(를) 확인하고, 삭제 결과을(를) 돌려줘요.');
    const takesHint = summary.getByRole('button', { name: '힌트 단계 보기', exact: true }).nth(0);
    await takesHint.focus();
    await page.keyboard.press('Enter');
    await story.getByText('3 / 7 · 요청', { exact: true }).waitFor();
    await until(() => story.getByRole('heading', { name: '서버에 요청을 보내요', exact: true }).evaluate(heading => heading === document.activeElement));
    assert.equal(await summary.count(), 0);
    await story.getByRole('button', { name: '7단계 화면 결과', exact: true }).click();
    assert.equal(await summary.getByRole('textbox', { name: '받는 것', exact: true }).inputValue(), '삭제 요청');
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    assert.equal(await summary.getByRole('textbox', { name: '확인하는 것', exact: true }).inputValue(), '반려견 정보');
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await page.getByRole('button', { name: '다시 찾기', exact: true }).waitFor();
    await holdWorkerMessages();
    await page.getByRole('button', { name: '다시 찾기', exact: true }).click();
    await page.getByRole('button', { name: '주소 찾기 취소', exact: true }).click();
    await page.getByRole('button', { name: '주소 찾기', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '다시 찾기', exact: true }).count(), 0);
    await releaseWorkerMessages();
    await page.getByRole('button', { name: '주소 찾기', exact: true }).click();
    await openServerFeatures();
    await route.waitFor();
    // Waking deliberately clears the question scope; select it again before checking navigation preserves it.
    await openTreeFile('api/controller.ts');
    await page.getByRole('button', { name: 'DogsController.remove', exact: true }).click();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await openServerFeatures();
    await route.click();
    await story.getByRole('button', { name: '7단계 화면 결과', exact: true }).click();
    assert.equal(await summary.getByRole('textbox', { name: '받는 것', exact: true }).inputValue(), '삭제 요청');
    assert.equal(await summary.getByRole('textbox', { name: '확인하는 것', exact: true }).inputValue(), '반려견 정보');
    assert.equal(await summary.getByRole('textbox', { name: '돌려주는 것', exact: true }).inputValue(), '삭제 결과');
    await story.getByRole('button', { name: '1단계 화면', exact: true }).click();
    await story.getByText('1 / 7 · 화면', { exact: true }).waitFor();
    await story.getByRole('button', { name: '2단계 프론트 처리', exact: true }).click();
    await story.getByText('2 / 7 · 프론트 처리', { exact: true }).waitFor();
    await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
    await openServerFeatures();
    await route.click();
    await story.getByText('1 / 7 · 화면', { exact: true }).waitFor();
    const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: /^전체 그림과 단계 보기$/ }) });
    assert.notEqual(await disclosure.getAttribute('open'), null);
    const steps = page.getByRole('region', { name: '기능 흐름 단계' });
    await steps.getByText('화면 주소 /dogs', { exact: true }).waitFor();
    await steps.getByText('화면 이벤트 onClick', { exact: true }).waitFor();
    await steps.getByText('추정', { exact: true }).waitFor();
    assert.match(await steps.innerText(), /타입으로 찾음/);
    assert.match(await steps.innerText(), /안쪽 함수에서 tx.dog.delete/);
    const diagram = page.getByTestId('feature-flow-canvas');
    const screenNode = diagram.getByRole('group', { name: 'web/app/dogs/page.tsx · DogsPage', exact: true });
    const serviceNode = diagram.getByRole('group', { name: 'api/service.ts · DogsService.remove', exact: true });
    await screenNode.waitFor();
    await serviceNode.waitFor();
    // A straight arrow between boxes in one row has no height, which the visibility check counts as hidden.
    await diagram.locator('.feature-arrow--typed .react-flow__edge-path').waitFor({ state: 'attached' });
    await diagram.locator('.feature-arrow--inferred .react-flow__edge-path').waitFor({ state: 'attached' });
    await eachTheme(async mode => {
      await diagram.locator(`.react-flow.${mode}`).waitFor();
      assert.equal(await diagram.locator(`.react-flow.${mode}`).count(), 1);
      await page.screenshot({ path: path.join(artifacts, `${mode}-flow-map.png`) });
    });
    assert.equal(await diagram.locator('.react-flow__node.draggable').count(), 0);
    assert.equal(await screenNode.locator('small').getAttribute('title'), 'web/app/dogs/page.tsx');
    assert.equal(await screenNode.getByText('화면 주소 /dogs', { exact: true }).count(), 1);
    assert.equal(await diagram.getByText('화면 이벤트 onClick', { exact: true }).count(), 1);
    assert.equal(await diagram.locator('.feature-arrow--typed .react-flow__edge-path').evaluate(edge => getComputedStyle(edge).strokeDasharray), '3px, 4px');
    assert.equal(await diagram.locator('.feature-arrow--inferred .react-flow__edge-path').evaluate(edge => getComputedStyle(edge).strokeDasharray), '9px, 5px');
    const edgeLabels = await diagram.locator('.react-flow__edge-text').allTextContents();
    assert.ok(edgeLabels.some(label => /부름 · \d+행$/.test(label)));
    assert.ok(edgeLabels.every(label => /^(?:.+ 부름|부름|화면 이벤트|화면에 놓음|안쪽 함수|훅 값|요청 보냄)(?: · \d+행)?$/.test(label)));
    assert.equal(await diagram.locator('.flow-lane').count(), 3);
    assert.deepEqual(await diagram.locator('.flow-lane h4').allTextContents(), ['화면 쪽', '요청', '서버 쪽']);
    const diagramHeight = await diagram.evaluate(element => ({ height: element.getBoundingClientRect().height, viewport: window.innerHeight }));
    assert.ok(diagramHeight.height > diagramHeight.viewport * 0.6, 'The flow canvas must grow beyond 60vh');
    const mutationNode = diagram.getByRole('group', { name: 'web/lib/dogs.ts · mutationFn', exact: true });
    const requestNode = diagram.locator('.react-flow__node.feature-box--request');
    assert.equal(await requestNode.count(), 1);
    const screenBox = await screenNode.boundingBox();
    const requestBox = await requestNode.boundingBox();
    assert.ok(screenBox && requestBox);
    assert.ok(Math.abs(screenBox.y - requestBox.y) <= 2, 'The request must start at the same top coordinate as DogsPage');
    // The request and handler are untagged; static rendering also checks tagged handles.
    const handlerNode = diagram.getByRole('group', { name: 'api/controller.ts · DogsController.remove', exact: true });
    const sourceHandle = await requestNode.locator('.react-flow__handle[data-handleid="out-right"]').boundingBox();
    const targetHandle = await handlerNode.locator('.react-flow__handle[data-handleid="in-left"]').boundingBox();
    assert.ok(sourceHandle && targetHandle);
    assert.ok(Math.abs(sourceHandle.y + sourceHandle.height / 2 - targetHandle.y - targetHandle.height / 2) <= 1,
      'Side handles on the same row must have the same vertical center');
    const mutationId = await mutationNode.getAttribute('data-id');
    const requestId = await requestNode.getAttribute('data-id');
    const requestPath = await diagram.getByRole('group', { name: `Edge from ${mutationId} to ${requestId}`, exact: true })
      .locator('.react-flow__edge-path').getAttribute('d');
    assert.ok(requestPath);
    assert.ok(requestPath.match(/[A-Za-z]/g).every(command => ['M', 'L', 'Q'].includes(command)));
    const pathCommands = [...requestPath.matchAll(/([MLQ])([^MLQ]*)/g)];
    assert.ok(pathCommands.length > 2, 'The caller-to-request path must bend between rows');
    let previous = [];
    for (const [, command, coordinates] of pathCommands) {
      const values = coordinates.match(/-?\d+(?:\.\d+)?/g).map(Number);
      if (command === 'L') assert.ok(Math.abs(values[0] - previous[0]) < 0.01 || Math.abs(values[1] - previous[1]) < 0.01,
        'Every straight segment of the caller-to-request path must be horizontal or vertical');
      previous = values.slice(-2);
    }
    const dogListNode = diagram.getByRole('group', { name: 'web/components/DogList.tsx · DogList', exact: true });
    const hookNode = diagram.getByRole('group', { name: 'web/lib/dogs.ts · useDeleteDog', exact: true });
    const gapZoom = await diagram.locator('.react-flow__viewport').evaluate(element =>
      new DOMMatrix(getComputedStyle(element).transform).a);
    const gapVerticalXs = [];
    for (const [from, to, offset] of [[dogListNode, hookNode, 34], [mutationNode, requestNode, 60]]) {
      const fromId = await from.getAttribute('data-id');
      const toId = await to.getAttribute('data-id');
      const verticals = await diagram.getByRole('group', { name: `Edge from ${fromId} to ${toId}`, exact: true })
        .locator('.react-flow__edge-path').evaluate(path => {
          const xs = [];
          let previous = [];
          for (const [, command, coordinates] of path.getAttribute('d').matchAll(/([MLQ])([^MLQ]*)/g)) {
            const values = coordinates.match(/-?\d+(?:\.\d+)?/g).map(Number);
            if (command === 'L' && Math.abs(values[0] - previous[0]) < 0.01 && Math.abs(values[1] - previous[1]) > 0.01) {
              xs.push(new DOMPoint(values[0], values[1]).matrixTransform(path.getScreenCTM()).x);
            }
            previous = values.slice(-2);
          }
          return xs;
        });
      assert.equal(verticals.length, 1, 'Each fixture arrow must have one vertical segment');
      const fromBox = await from.boundingBox();
      assert.ok(fromBox);
      const screenOffset = verticals[0] - (fromBox.x + fromBox.width);
      assert.ok(Math.abs(screenOffset - offset * gapZoom) <= 2 * gapZoom,
        `The vertical segment must be ${offset}px beyond its source box after accounting for zoom`);
      gapVerticalXs.push(verticals[0]);
    }
    assert.ok(Math.abs(gapVerticalXs[0] - gapVerticalXs[1]) > 20 * gapZoom,
      'The outside arrow and caller-to-request arrow must use separate regions of gap zero');
    const labelOverlaps = await diagram.evaluate(element => {
      const boxes = [...element.querySelectorAll('.react-flow__node.feature-box')].map(box => ({
        name: box.getAttribute('aria-label'), rect: box.getBoundingClientRect(),
      }));
      return [...element.querySelectorAll('.react-flow__edge-textwrapper')].flatMap(label => {
        const rect = label.getBoundingClientRect();
        return boxes.filter(box => rect.left < box.rect.right && rect.right > box.rect.left
          && rect.top < box.rect.bottom && rect.bottom > box.rect.top)
          .map(box => ({ label: label.textContent, box: box.name }));
      });
    });
    assert.deepEqual(labelOverlaps, [], 'Arrow labels must not overlap any feature box');
    const labelPairOverlaps = await diagram.evaluate(element => {
      const labels = [...element.querySelectorAll('.react-flow__edge-textwrapper')].map(label => ({
        text: label.textContent, rect: label.getBoundingClientRect(),
      }));
      return labels.flatMap((label, index) => labels.slice(index + 1)
        .filter(other => label.rect.left < other.rect.right && label.rect.right > other.rect.left
          && label.rect.top < other.rect.bottom && label.rect.bottom > other.rect.top)
        .map(other => ({ first: label.text, second: other.text })));
    });
    assert.deepEqual(labelPairOverlaps, [], 'Arrow labels must not overlap each other in the feature flow fixture');
    await screenNode.hover();
    const center = page.locator('.center');
    const scrollBeforeWheel = await center.evaluate(element => element.scrollTop);
    const zoomBeforeWheel = await diagram.locator('.react-flow__viewport').evaluate(element =>
      new DOMMatrix(getComputedStyle(element).transform).a);
    await page.mouse.wheel(0, 320);
    await until(async () => await center.evaluate(element => element.scrollTop) > scrollBeforeWheel);
    const zoomAfterWheel = await diagram.locator('.react-flow__viewport').evaluate(element =>
      new DOMMatrix(getComputedStyle(element).transform).a);
    assert.equal(zoomAfterWheel, zoomBeforeWheel, 'Wheel scrolling must leave the diagram zoom unchanged');
    const evidenceStrip = page.getByRole('region', { name: '선택한 연결의 근거', exact: true });
    await evidenceStrip.getByText('지도에서 상자를 누르면 그 코드가 여기 보여요.', { exact: true }).waitFor();
    // Hold the read so a second box click must leave both selection and read count unchanged.
    await app.evaluate(({ ipcMain }) => {
      globalThis.testFlowRead = ipcMain._invokeHandlers.get('learning:read');
      globalThis.testFlowReadCalls = 0;
      const gate = new Promise(resolve => { globalThis.releaseFlowRead = resolve; });
      ipcMain.removeHandler('learning:read');
      ipcMain.handle('learning:read', async (event, request) => {
        globalThis.testFlowReadCalls++;
        await gate;
        return globalThis.testFlowRead(event, request);
      });
    });
    try {
      await serviceNode.click();
      await evidenceStrip.getByText('코드를 읽는 중…', { exact: true }).waitFor();
      await until(async () => await app.evaluate(() => globalThis.testFlowReadCalls) === 1);
      await screenNode.click();
      assert.equal(await app.evaluate(() => globalThis.testFlowReadCalls), 1);
      assert.equal(await steps.locator('[aria-current="step"]').count(), 1);
      assert.equal(await steps.locator('[aria-current="step"] b').innerText(), 'DogsService.remove');
      assert.ok((await evidenceStrip.getByRole('button').all()).length > 0);
      for (const button of await evidenceStrip.getByRole('button').all()) assert.equal(await button.isDisabled(), true);
    } finally {
      await app.evaluate(({ ipcMain }) => {
        globalThis.releaseFlowRead();
        ipcMain.removeHandler('learning:read');
        ipcMain.handle('learning:read', globalThis.testFlowRead);
      });
    }
    for (const [node, name, file, code] of [
      [serviceNode, 'DogsService.remove', 'api/service.ts', 'this.db.$transaction'],
      [screenNode, 'DogsPage', 'web/app/dogs/page.tsx', 'DogList'],
    ]) {
      // The first read is already running; wait for it before clicking the next box.
      if (node === screenNode) await node.click();
      await evidenceStrip.getByRole('heading', { name: `선택한 연결의 근거 · ${file}`, exact: true }).waitFor();
      await until(async () => (await evidenceStrip.getByTestId('flow-snippet').innerText()).includes(code));
      await until(async () => await evidenceStrip.getByRole('button', { name: '코드 보기', exact: true }).isEnabled());
      assert.equal(await steps.locator('[aria-current="step"]').count(), 1);
      assert.equal(await steps.locator('[aria-current="step"] b').innerText(), name);
    }
    await diagram.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'feature-flow-map.png') });
    // Returning from the chooser starts with an empty evidence strip.
    await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
    await openServerFeatures();
    await route.click();
    await evidenceStrip.getByText('지도에서 상자를 누르면 그 코드가 여기 보여요.', { exact: true }).waitFor();
    await until(async () => await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).isEnabled());
    await serviceNode.click();
    await evidenceStrip.getByTestId('flow-snippet').waitFor();
    await until(async () => await evidenceStrip.getByRole('button', { name: '코드 보기', exact: true }).isEnabled());
    await page.screenshot({ path: path.join(artifacts, 'feature-flow-text.png') });
    await steps.getByTestId('feature-step').filter({ has: page.locator('b', { hasText: /^DogsService.remove$/ }) })
      .getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByRole('heading', { name: 'api/service.ts', exact: true }).waitFor();
    await page.getByTestId('evidence-range').waitFor();
    assert.match(await page.getByTestId('evidence-range').innerText(), /api\/service.ts/);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    // The guide stays mounted while another view is shown, so an opened disclosure is still open on return.
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click();
    await steps.getByTestId('feature-step').filter({ has: page.locator('b', { hasText: /^DogsService.remove$/ }) })
      .getByRole('button', { name: '이 함수 흐름', exact: true }).click();
    await page.getByRole('article', { name: '함수 요약', exact: true }).waitFor();
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click();
    await serviceNode.click();
    await evidenceStrip.getByTestId('flow-snippet').waitFor();
    await until(async () => await evidenceStrip.getByRole('button', { name: '코드 보기', exact: true }).isEnabled());
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await evidenceStrip.getByText('다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.', { exact: true }).waitFor();
    assert.equal(await evidenceStrip.getByTestId('flow-snippet').count(), 0);
    await page.locator('.feature-page > .notice').getByText('다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.panel [data-testid="flow-step-explanation"]').count(), 0);
    assert.equal(await page.getByTestId('story-function-location').count(), 0);
    await page.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
    assert.equal(await route.isDisabled(), true);
    await page.getByRole('button', { name: '다시 찾기', exact: true }).click();
    await openServerFeatures();
    await until(async () => await route.isEnabled());
    // Invalid renderer input cannot supply a path, range or a stale saved result.
    const invalid = await page.evaluate(async () => {
      const project = await window.learning.openProject();
      const projectId = project.value.id;
      const routes = await window.learning.routes({ projectId });
      return await Promise.all([
        window.learning.featureFlows({ projectId, routesId: 'not-a-uuid' }),
        window.learning.featureFlows({ projectId, routesId: routes.value.routesId, path: '/etc/passwd' }),
        window.learning.featureFlows({ projectId, routesId: '00000000-0000-4000-8000-000000000000' }),
        window.learning.cancelFeatureFlows({ projectId, path: '/etc/passwd' }),
        window.learning.featureFlow({ projectId, routesId: 'not-a-uuid', routeIndex: 0 }),
        window.learning.featureFlow({ projectId, routesId: routes.value.routesId, routeIndex: -1 }),
        window.learning.featureFlow({ projectId, routesId: routes.value.routesId, routeIndex: 999 }),
        window.learning.featureFlow({ projectId, routesId: routes.value.routesId, routeIndex: 0, path: '/etc/passwd' }),
        window.learning.startFeatureGuide({ projectId, routesId: routes.value.routesId, mode: 'local-worker', consent: false }),
        window.learning.startFeatureGuide({ projectId, routesId: routes.value.routesId, mode: 'local-worker' }),
        window.learning.startFeatureGuide({ projectId, routesId: routes.value.routesId, mode: 'local-worker', consent: true, routes: [] }),
        window.learning.startFeatureGuide({ projectId, routesId: '00000000-0000-4000-8000-000000000000', mode: 'local-worker', consent: true }),
      ]);
    });
    assert.deepEqual(invalid.map(result => result.code), ['INVALID_REQUEST', 'INVALID_REQUEST', 'CHANGED', 'INVALID_REQUEST',
      'INVALID_REQUEST', 'INVALID_REQUEST', 'CHANGED', 'INVALID_REQUEST',
      'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'CHANGED']);
  });
  await check('Returned hook function: form event, confirmed call and navigation result', async () => {
    await dialogTo(loginFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '로그인 흐름 프로젝트', exact: true }).waitFor();
    await openScreenFeatures();
    await page.getByRole('region', { name: '화면 /login', exact: true }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
    await story.getByText('화면 /login에서 입력 양식을 보내면 시작해요', { exact: true }).waitFor();
    await story.getByRole('button', { name: '2단계 프론트 처리', exact: true }).click();
    const explanation = page.getByTestId('story-step');
    assert.equal((await explanation.innerText()).includes('추정'), false);
    await story.getByText('코드에서 확인됨: 훅이 돌려준 login 함수를 불러요', { exact: false }).waitFor();
    await story.getByText('전체 그림과 단계 보기', { exact: true }).click();
    await story.getByRole('button', { name: '5단계 화면 결과', exact: true }).click();
    await story.getByRole('heading', { name: '응답이 온 뒤 화면이 바뀌어요', exact: true }).waitFor();
    const result = story.getByRole('region', { name: '응답 뒤 화면', exact: true });
    await result.getByText('화면 /로 이동하기', { exact: false }).waitFor();
    await result.getByRole('button', { name: '이 줄 보기', exact: true }).click();
    await until(async () => /web\/app\/login\/page.tsx · 6–6줄/.test(await story.getByTestId('evidence-range').innerText()));
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    assert.equal(await story.getByRole('button', { name: '다음 ▶', exact: true }).isDisabled(), true);
    await story.getByTestId('flow-code').locator('.cm-content').focus();
    await until(async () => await page.evaluate(() => getSelection()?.toString()) === "router.push('/')");
    await page.screenshot({ path: path.join(artifacts, 'feature-flow-login-result.png') });
  });
  await check('File guide E: reverse imports and caller navigation reuse existing searches without shape work', async () => {
    await dialogTo(featureFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
    await openTreeFile('web/lib/request.ts');
    const guide = await openFileGuide();
    const importers = guide.getByRole('region', { name: '이 파일을 가져다 쓰는 파일', exact: true });
    await importers.getByRole('button', { name: '지도 만들어 찾기', exact: true }).click();
    await importers.getByText('이 파일을 가져다 쓰는 파일 1개', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
    await importers.getByRole('button', { name: 'dogs.ts 열기', exact: true }).click();
    await page.getByRole('heading', { name: 'web/lib/dogs.ts', exact: true }).waitFor();
    await until(async () => /web\/lib\/dogs.ts · 1–1줄/.test(await page.getByTestId('evidence-range').innerText()));
    await openTreeFile('web/lib/request.ts');
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const calls = handlers.get('learning:calls');
      const shapes = handlers.get('learning:shapes');
      globalThis.guideCallsCount = 0;
      globalThis.guideShapesCount = 0;
      handlers.set('learning:calls', (...args) => { globalThis.guideCallsCount++; return calls(...args); });
      handlers.set('learning:shapes', (...args) => { globalThis.guideShapesCount++; return shapes(...args); });
      globalThis.restoreGuideSearches = () => {
        handlers.set('learning:calls', calls);
        handlers.set('learning:shapes', shapes);
      };
    });
    try {
      const card = guide.locator('[data-symbol-id]').first();
      await card.getByRole('button', { name: '부르는 곳 찾기', exact: true }).click();
      await card.getByRole('button', { name: '호출 위치', exact: true }).waitFor();
      assert.match(await card.innerText(), /web\/lib\/dogs.ts 1행/);
      assert.deepEqual(await app.evaluate(() => [globalThis.guideCallsCount, globalThis.guideShapesCount]), [1, 0]);
      await card.getByRole('button', { name: '이 함수 고르기', exact: true }).click();
      await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
      await until(async () => await app.evaluate(() => globalThis.guideShapesCount) === 1);
      assert.equal(await app.evaluate(() => globalThis.guideCallsCount), 1);
      await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
      await card.getByRole('button', { name: '호출 위치', exact: true }).click();
      await page.getByRole('heading', { name: 'web/lib/dogs.ts', exact: true }).waitFor();
      await page.getByTestId('evidence-range').waitFor();
    } finally {
      await app.evaluate(() => globalThis.restoreGuideSearches());
    }
  });
  await check('File guide E: request, after, stop and store facts; server-only changes hide stale requests', async () => {
    await dialogTo(featureFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
    await openTreeFile('api/service.ts');
    const guide = await openFileGuide();
    await guide.getByText('“반려견을 찾을 수 없어요.” 오류를 내요 (찾을 수 없음) · 조건: !id (3행)', { exact: true }).waitFor();
    await guide.getByText('dog 지우기 · 모양으로 판단 (4행)', { exact: true }).waitFor();
    await dialogTo(loginFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '로그인 흐름 프로젝트', exact: true }).waitFor();
    await openScreenFeatures();
    await page.getByRole('region', { name: '화면 /login', exact: true }).waitFor();
    await openTreeFile('web/app/login/page.tsx');
    await guide.getByText('성공하면 화면 /로 이동하기 · 모양으로 판단 (6행)', { exact: true }).waitFor();
    await openTreeFile('web/lib/auth.ts');
    await guide.getByText('POST /api/auth/login 요청을 보내요 (1행)', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'file-guide-e-requests.png') });
    try {
      await writeFile(path.join(loginFlowFixture, 'api/controller.ts'), loginFlowFiles['api/controller.ts'] + '\n// guide stale check\n');
      await guide.getByText('프로젝트가 바뀌어 서버 주소를 다시 찾아야 해요.', { exact: true }).waitFor();
      assert.equal(await guide.getByText('요청을 보내요', { exact: false }).count(), 0);
      assert.equal(await guide.getByRole('button', { name: '부르는 곳 찾기', exact: true }).isDisabled(), true);
      assert.equal(await guide.getByRole('button', { name: '지도 만들어 찾기', exact: true }).isEnabled(), true);
      await guide.getByRole('button', { name: '지도 만들어 찾기', exact: true }).click();
      await guide.getByText('이 파일을 가져다 쓰는 파일 1개', { exact: true }).waitFor();
      assert.equal(await guide.getByRole('button', { name: 'provider.ts 열기', exact: true }).isDisabled(), true);
    } finally {
      await writeFile(path.join(loginFlowFixture, 'api/controller.ts'), loginFlowFiles['api/controller.ts']);
    }
  });
  await check('Story hides the function location after current or related file changes', async () => {
    for (const relativePath of ['web/app/login/page.tsx', 'api/controller.ts']) {
      await dialogTo(loginFlowFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('heading', { name: '로그인 흐름 프로젝트', exact: true }).waitFor();
      await openScreenFeatures();
      await page.getByRole('region', { name: '화면 /login', exact: true }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
      const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
      await story.getByTestId('flow-code').waitFor();
      const explanation = page.locator('.feature-page');
      await explanation.getByTestId('story-function-location').waitFor();
      assert.match(await explanation.innerText(), / · web\/app\/login\/page.tsx \d+–\d+행/);
      try {
        await writeFile(path.join(loginFlowFixture, relativePath), loginFlowFiles[relativePath] + '\n// panel stale check\n');
        await explanation.locator(':scope > .notice').getByText('다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.', { exact: true }).waitFor();
        assert.equal(await page.locator('.panel [data-testid="flow-step-explanation"]').count(), 0);
        assert.equal(await explanation.getByTestId('story-function-location').count(), 0);
        assert.equal(await explanation.getByTestId('story-step').isVisible(), true);
        assert.equal(await explanation.getByText('함수나 구문을 고르면', { exact: false }).count(), 0);
      } finally {
        await writeFile(path.join(loginFlowFixture, relativePath), loginFlowFiles[relativePath]);
      }
    }
  });
  await check('Screen grouping cancels, retries, discards late replies and opens cached stories without flow IPC', async () => {
    const groupedFixture = path.join(temporary, '화면 묶기 프로젝트');
    const files = { ...loginFlowFiles,
      'web/lib/auth.ts': "export async function login() {\n if (remember) return fetch('/api/auth/login', {method:'POST'});\n return fetch('/api/auth/login', {method:'POST'});\n}",
      'web/app/other/page.tsx': loginFlowFiles['web/app/login/page.tsx'].replace('LoginPage', 'OtherPage'),
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(groupedFixture, name)), { recursive: true });
      await writeFile(path.join(groupedFixture, name), text);
    }
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      globalThis.screenFlowOriginal = handlers.get('learning:feature-flow');
      globalThis.screenFlowsOriginal = handlers.get('learning:feature-flows');
      globalThis.screenFlowCalls = 0;
      globalThis.screenBatchHeld = false;
      handlers.set('learning:feature-flow', (...args) => {
        globalThis.screenFlowCalls++;
        return globalThis.screenFlowOriginal(...args);
      });
      handlers.set('learning:feature-flows', async (...args) => {
        handlers.set('learning:feature-flows', globalThis.screenFlowsOriginal);
        const result = await globalThis.screenFlowsOriginal(...args);
        globalThis.screenBatchHeld = true;
        await new Promise(resolve => { globalThis.releaseScreenBatch = resolve; });
        return result;
      });
    });
    try {
      await dialogTo(groupedFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      const list = page.getByRole('region', { name: '기능 목록', exact: true });
      await list.getByRole('status').getByText('화면별로 묶는 중…', { exact: false }).waitFor();
      await list.getByText('만들기·보내기 · /api/auth/login', { exact: true }).waitFor();
      await until(() => app.evaluate(() => globalThis.screenBatchHeld));
      await list.getByRole('button', { name: '취소', exact: true }).click();
      await list.getByRole('button', { name: '다시 묶기', exact: true }).waitFor();
      await app.evaluate(() => globalThis.releaseScreenBatch());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await list.getByRole('region', { name: '화면 /other', exact: true, includeHidden: true }).count(), 0);
      await list.getByText('만들기·보내기 · /api/auth/login', { exact: true }).waitFor();
      await list.getByRole('button', { name: '다시 묶기', exact: true }).click();
      await openScreenFeatures();
      const other = list.getByRole('region', { name: '화면 /other', exact: true });
      await other.waitFor();
      await list.getByRole('region', { name: '화면 /login', exact: true }).waitFor();
      assert.equal(await other.getByText('다른 화면에서도 써요', { exact: true }).count(), 1);
      const server = list.locator('details').filter({ has: page.locator('summary', { hasText: /^서버 주소 기준 목록 \(AI 정리 포함\)$/ }) });
      assert.equal(await server.evaluate(element => element.open), false);
      await other.getByRole('listitem').filter({ hasText: 'POST /api/auth/login' }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
      const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
      await story.getByText('화면 /other에서 입력 양식을 보내면 시작해요', { exact: true }).waitFor();
      const requests = story.getByRole('group', { name: '요청 고르기', exact: true }).getByRole('button');
      assert.equal(await requests.count(), 2);
      assert.ok((await requests.allTextContents()).every(text => text.includes('web/lib/auth.ts') && text.includes('POST /api/auth/login')));
      await requests.nth(1).click();
      await story.getByText('화면 /other에서 입력 양식을 보내면 시작해요', { exact: true }).waitFor();
      assert.equal(await app.evaluate(() => globalThis.screenFlowCalls), 0);
      await page.screenshot({ path: path.join(artifacts, 'screen-group-story.png') });
      await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
      const fileSearch = page.getByRole('searchbox', { name: '파일명 검색', exact: true });
      await fileSearch.fill('web/lib/auth.ts');
      await page.getByRole('button', { name: 'web/lib/auth.ts', exact: true }).click();
      await openFileGuide();
      const uses = page.getByRole('region', { name: '이 파일이 나오는 기능', exact: true });
      await uses.getByRole('heading', { name: /이 파일이 나오는 기능/ }).waitFor();
      const use = uses.getByRole('listitem').filter({ hasText: '화면 /other · POST /api/auth/login' });
      // The login form's handler sits in the second step of this fixture's story.
      const stepLabel = '2단계 프론트 처리';
      await until(async () => (await use.innerText()).includes(stepLabel));
      await page.screenshot({ path: path.join(artifacts, 'file-uses.png') });
      await use.getByRole('button', { name: '이 단계로', exact: true }).click();
      await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
      assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
      assert.equal(await story.getByRole('button', { name: stepLabel, exact: true }).getAttribute('aria-current'), 'step');
      const range = story.getByTestId('evidence-range');
      assert.match(await range.innerText(), /web\/lib\/auth.ts/);
      const loginSource = files['web/lib/auth.ts'];
      assert.equal(await range.getAttribute('data-utf16'), `${loginSource.indexOf('async function')},${loginSource.length}`);
      assert.equal(await app.evaluate(() => globalThis.screenFlowCalls), 0);
      await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
      await fileSearch.fill('');
    } finally {
      await app.evaluate(({ ipcMain }) => {
        globalThis.releaseScreenBatch?.();
        ipcMain._invokeHandlers.set('learning:feature-flow', globalThis.screenFlowOriginal);
        ipcMain._invokeHandlers.set('learning:feature-flows', globalThis.screenFlowsOriginal);
      });
    }
  });
  await check('Flow walk keeps late responses out of code reading, retries failures and refuses changed code', async () => {
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('learning:feature-flows');
      handlers.set('learning:feature-flows', async () => {
        handlers.set('learning:feature-flows', original);
        return { ok: false, code: 'LIMIT', message: '시험용 화면 묶기 한도' };
      });
    });
    await dialogTo(featureFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
    const follow = page.getByRole('region', { name: '기능 목록', exact: true }).getByRole('button', { name: '이 기능 따라가기', exact: true });
    await page.getByRole('button', { name: '다시 묶기', exact: true }).waitFor();
    await follow.waitFor();
    // Run the real handler and hold only its reply, leaving ordinary file reads available.
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('learning:feature-flow');
      handlers.set('learning:feature-flow', async (...args) => {
        handlers.set('learning:feature-flow', original);
        const result = await original(...args);
        globalThis.testFlowReplyWaiting = true;
        await new Promise(resolve => { globalThis.testReleaseFlowReply = resolve; });
        return result;
      });
    });
    await follow.click();
    await until(() => app.evaluate(() => globalThis.testFlowReplyWaiting === true));
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await openTreeFile('api/service.ts');
    await page.getByRole('button', { name: 'DogsService.remove', exact: true }).click();
    await page.getByTestId('evidence-range').waitFor();
    const before = await page.getByTestId('evidence-range').innerText();
    const beforeCode = await page.getByTestId('source-editor').innerText();
    await app.evaluate(() => globalThis.testReleaseFlowReply());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('heading', { name: 'api/service.ts', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.getByTestId('evidence-range').innerText(), before);
    assert.equal(await page.getByTestId('source-editor').innerText(), beforeCode);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
    await story.getByText('1 / 7 · 화면', { exact: true }).waitFor();
    assert.equal(await story.getByTestId('flow-code').count(), 0);
    await story.getByRole('button', { name: '이 단계 코드 보기', exact: true }).click();
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    // A one-shot failure preserves the failed route for the retry button.
    await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('learning:feature-flow');
      handlers.set('learning:feature-flow', async () => {
        handlers.set('learning:feature-flow', original);
        return { ok: false, code: 'IO', message: '시험용 흐름 찾기 실패' };
      });
    });
    await follow.click();
    const flowPage = page.locator('.feature-page');
    await flowPage.getByRole('alert').getByText('시험용 흐름 찾기 실패', { exact: true }).waitFor();
    await follow.waitFor();
    await flowPage.getByRole('button', { name: '다시 시도', exact: true }).click();
    await story.getByText('1 / 7 · 화면', { exact: true }).waitFor();
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    await story.getByRole('button', { name: '2단계 프론트 처리', exact: true }).click();
    await story.getByTestId('flow-code').locator('.cm-selectionBackground').first().waitFor();
    const changedFile = path.join(featureFlowFixture, 'web/lib/dogs.ts');
    await writeFile(changedFile, featureFlowFiles['web/lib/dogs.ts'] + '\n// changed during walk\n');
    await story.getByRole('button', { name: '이 단계 코드 보기', exact: true }).waitFor();
    assert.equal(await story.getByTestId('flow-code').count(), 0);
    await story.getByRole('button', { name: '이 단계 코드 보기', exact: true }).click();
    await page.getByText('흐름을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 주소를 다시 찾아 주세요.', { exact: true }).waitFor();
    assert.equal(await story.getByTestId('flow-code').count(), 0);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
    await writeFile(changedFile, featureFlowFiles['web/lib/dogs.ts']);
  });
  await check('Project map tabs: retry in place, share the flow and build the file map only on demand', async () => {
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      globalThis.mapTabOriginals = new Map(['learning:map', 'learning:read', 'learning:routes', 'learning:feature-flows', 'learning:feature-flow']
        .map(channel => [channel, handlers.get(channel)]));
      globalThis.mapTabCalls = { map: 0, read: 0, flow: 0 };
      for (const name of ['map', 'read']) {
        handlers.set(`learning:${name}`, (...args) => {
          globalThis.mapTabCalls[name]++;
          return globalThis.mapTabOriginals.get(`learning:${name}`)(...args);
        });
      }
      // Simulate a partial route result to check that its warning survives list and flow views.
      handlers.set('learning:routes', async (...args) => {
        const result = await globalThis.mapTabOriginals.get('learning:routes')(...args);
        if (!result.ok) return result;
        return { ...result, value: { ...result.value, limited: true,
          notes: [...result.value.notes, 'unreadable.ts: 파일을 읽지 못했어요.'] } };
      });
      // Fail grouping before opening the project so following cannot reuse a stored flow.
      handlers.set('learning:feature-flows', async () => {
        handlers.set('learning:feature-flows', globalThis.mapTabOriginals.get('learning:feature-flows'));
        return { ok: false, code: 'LIMIT', message: '시험용 화면 묶기 한도' };
      });
      handlers.set('learning:feature-flow', (...args) => {
        globalThis.mapTabCalls.flow++;
        if (globalThis.mapTabCalls.flow === 1) return { ok: false, code: 'IO', message: '시험용 지도 흐름 찾기 실패' };
        return globalThis.mapTabOriginals.get('learning:feature-flow')(...args);
      });
    });
    try {
      await dialogTo(featureFlowFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
      await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
      const mapPage = page.locator('.map-page');
      const tabs = mapPage.getByRole('group', { name: '지도 종류', exact: true });
      assert.equal(await tabs.getByRole('button', { name: '기능별 연결', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await tabs.getByRole('button', { name: '파일 연결', exact: true }).getAttribute('aria-pressed'), 'false');
      await openServerFeatures();
      await mapPage.getByRole('button', { name: '다시 묶기', exact: true }).waitFor();
      assert.equal(await mapPage.getByText('지도를 만드는 중…', { exact: true }).count(), 0);
      assert.equal(await app.evaluate(() => globalThis.mapTabCalls.map), 0);
      await mapPage.getByText('이 흐름을 찾은 방법과 한계', { exact: true }).click();
      await mapPage.getByText('unreadable.ts: 파일을 읽지 못했어요.', { exact: true }).waitFor();
      const route = mapPage.getByRole('region', { name: '기능 목록', exact: true })
        .getByRole('button', { name: '이 기능 따라가기', exact: true });
      await route.click();
      await mapPage.getByRole('alert').getByText('시험용 지도 흐름 찾기 실패', { exact: true }).waitFor();
      await mapPage.getByRole('button', { name: '다시 시도', exact: true }).click();
      const diagram = mapPage.getByTestId('feature-flow-canvas');
      await diagram.waitFor();
      assert.equal(await page.getByRole('button', { name: '프로젝트 지도', exact: true }).getAttribute('aria-current'), 'page');
      assert.deepEqual(await app.evaluate(() => globalThis.mapTabCalls), { map: 0, read: 0, flow: 2 });
      assert.deepEqual(await diagram.locator('.flow-lane h4').allTextContents(), ['화면 쪽', '요청', '서버 쪽']);
      const title = await mapPage.locator('.map-actions h3').innerText();
      assert.match(title, /\/api\/dogs\/:id/);
      const limits = mapPage.locator('details').filter({ has: page.locator('summary', { hasText: /^이 흐름을 찾은 방법과 한계$/ }) });
      if (!await limits.evaluate(element => element.open)) await limits.locator(':scope > summary').click();
      await limits.getByText('unreadable.ts: 파일을 읽지 못했어요.', { exact: true }).waitFor();
      await limits.locator(':scope > summary').click();
      const evidenceStrip = mapPage.getByRole('region', { name: '선택한 연결의 근거', exact: true });
      await evidenceStrip.getByText('지도에서 상자를 누르면 그 코드가 여기 보여요.', { exact: true }).waitFor();
      await diagram.getByRole('group', { name: 'api/service.ts · DogsService.remove', exact: true }).click();
      await evidenceStrip.getByRole('heading', { name: '선택한 연결의 근거 · api/service.ts', exact: true }).waitFor();
      await until(async () => (await evidenceStrip.getByTestId('flow-snippet').innerText()).includes('this.prisma.dog.delete'));
      await eachTheme(async mode => {
        await diagram.locator(`.react-flow.${mode}`).waitFor();
        await mapPage.getByRole('heading', { name: '프로젝트 지도', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, `${mode}-map-feature.png`), fullPage: true });
      });
      await mapPage.getByRole('button', { name: '흐름 따라가기에서 단계별로 보기', exact: true }).click();
      const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
      await story.getByRole('heading', { name: title, exact: true }).waitFor();
      await story.getByRole('button', { name: '이 단계 코드 보기', exact: true }).waitFor();
      await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
      await mapPage.locator('.map-actions').getByRole('heading', { name: title, exact: true }).waitFor();
      await diagram.waitFor();
      await mapPage.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
      await route.waitFor();
      assert.equal(await diagram.count(), 0);
      await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
      await page.getByRole('region', { name: '기능 목록', exact: true }).waitFor();
      assert.equal(await story.count(), 0);
      await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
      assert.equal(await app.evaluate(() => globalThis.mapTabCalls.map), 0);
      await tabs.getByRole('button', { name: '파일 연결', exact: true }).click();
      await mapPage.getByRole('button', { name: '지도 다시 만들기', exact: true }).waitFor();
      await mapPage.getByTestId('map-canvas').waitFor();
      assert.equal(await app.evaluate(() => globalThis.mapTabCalls.map), 1);
      await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
      await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
      assert.equal(await tabs.getByRole('button', { name: '파일 연결', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await tabs.getByRole('button', { name: '기능별 연결', exact: true }).getAttribute('aria-pressed'), 'false');
      assert.equal(await app.evaluate(() => globalThis.mapTabCalls.map), 1);
      await dialogTo(second);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('heading', { name: '다른 프로젝트', exact: true }).waitFor();
      await page.getByRole('button', { name: '프로젝트 지도', exact: true }).click();
      assert.equal(await tabs.getByRole('button', { name: '파일 연결', exact: true }).getAttribute('aria-pressed'), 'true');
      await mapPage.getByRole('button', { name: '지도 다시 만들기', exact: true }).waitFor();
      assert.equal(await app.evaluate(() => globalThis.mapTabCalls.map), 2);
    } finally {
      await app.evaluate(({ ipcMain }) => {
        for (const [channel, handler] of globalThis.mapTabOriginals) ipcMain._invokeHandlers.set(channel, handler);
      });
    }
  });
  await check('Project map areas: open one level, fold descendants and switch views', async () => {
    await dialogTo(areaMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '영역 지도 프로젝트', exact: true }).waitFor();
    await openFileMap();
    const boxes = page.getByTestId('map-canvas').locator('.react-flow__node');
    const chips = page.getByRole('group', { name: '펼친 곳', exact: true });
    await until(async () => await boxes.count() === 3);
    assert.equal(await chips.count(), 0);
    await boxes.filter({ hasText: 'web · 파일 4개' }).click();
    await until(async () => await boxes.count() === 6);
    await boxes.filter({ hasText: 'web/app · 파일 1개' }).waitFor();
    await boxes.filter({ hasText: 'web/lib · 파일 1개' }).waitFor();
    await boxes.filter({ hasText: 'web/e2e · 파일 1개' }).waitFor();
    await boxes.filter({ hasText: 'web 바로 아래 파일 · 1개' }).waitFor();
    assert.deepEqual(await chips.getByRole('button').allTextContents(), ['web 접기']);
    await boxes.filter({ hasText: 'web/app · 파일 1개' }).click();
    await boxes.filter({ hasText: 'page.ts' }).waitFor();
    await boxes.filter({ hasText: 'web 바로 아래 파일 · 1개' }).click();
    await boxes.filter({ hasText: 'index.ts' }).waitFor();
    assert.deepEqual(await chips.getByRole('button').allTextContents(), ['web 접기', 'web/app 접기', 'web 바로 아래 파일 접기']);
    await chips.getByRole('button', { name: 'web 접기', exact: true }).click();
    await until(async () => await boxes.count() === 3);
    assert.equal(await chips.count(), 0);
    // Reopening a parent must leave both its child area and its direct-file group closed.
    await boxes.filter({ hasText: 'web · 파일 4개' }).click();
    await boxes.filter({ hasText: 'web/app · 파일 1개' }).waitFor();
    await boxes.filter({ hasText: 'web 바로 아래 파일 · 1개' }).waitFor();
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
    await until(async () => await boxes.locator('.map-box__label > b').allTextContents().then(labels =>
      labels.length === 6 && labels.every(label => !label.includes('파일'))));
    assert.equal(await page.getByRole('button', { name: '파일 보기', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '설계 보기', exact: true }).click();
    await until(async () => await boxes.count() === 3);
    await boxes.filter({ hasText: '(최상위 폴더) 바로 아래 파일 · 1개' }).click();
    await boxes.filter({ hasText: 'root.ts' }).waitFor();
    await chips.getByRole('button', { name: '(최상위 폴더) 바로 아래 파일 접기', exact: true }).click();
    await boxes.filter({ hasText: '(최상위 폴더) 바로 아래 파일 · 1개' }).waitFor();
    assert.equal(await chips.count(), 0);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
  });
  await check('Project map focus: linked arrows, file buttons and clearing on area or view changes', async () => {
    await dialogTo(areaMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '영역 지도 프로젝트', exact: true }).waitFor();
    await openFileMap();
    const canvas = page.getByTestId('map-canvas');
    const boxes = canvas.locator('.react-flow__node');
    const arrows = canvas.locator('.react-flow__edge');
    const chips = page.getByRole('group', { name: '펼친 곳', exact: true });
    const focus = page.getByRole('group', { name: '이어진 것만 보는 중', exact: true });
    const appBox = boxes.filter({ hasText: 'web/app · 파일 1개' });
    const appFocus = appBox.getByRole('button', { name: 'web/app · 파일 1개 이어진 것만 보기', exact: true });
    const libFocus = canvas.getByRole('button', { name: 'web/lib · 파일 1개 이어진 것만 보기', exact: true });
    const directFocus = canvas.getByRole('button', { name: 'web 바로 아래 파일 · 1개 이어진 것만 보기', exact: true });
    await until(async () => await boxes.count() === 3);
    await boxes.filter({ hasText: 'web · 파일 4개' }).locator('.map-box__label').click();
    await until(async () => await boxes.count() === 6 && await arrows.count() === 2);

    await appFocus.click();
    await until(async () => await arrows.count() === 1);
    assert.equal(await boxes.count(), 6);
    assert.deepEqual(await chips.getByRole('button').allTextContents(), ['web 접기']);
    assert.match(await focus.innerText(), /가져다 씀 1곳 · 이 상자를 가져다 씀 0곳/);
    assert.equal(await appFocus.getAttribute('aria-pressed'), 'true');
    assert.match(await appBox.getAttribute('class'), /\bmap-box--focus\b/);
    assert.match(await boxes.filter({ hasText: 'web/e2e · 파일 1개' }).getAttribute('class'), /\bmap-box--dim\b/);
    assert.doesNotMatch(await boxes.filter({ hasText: 'web/lib · 파일 1개' }).getAttribute('class'), /\bmap-box--dim\b/);

    await libFocus.click();
    await until(async () => await arrows.count() === 2);
    assert.match(await focus.innerText(), /가져다 씀 0곳 · 이 상자를 가져다 씀 2곳/);
    assert.equal(await appFocus.getAttribute('aria-pressed'), 'false');
    assert.equal(await libFocus.getAttribute('aria-pressed'), 'true');
    await directFocus.click();
    await until(async () => await arrows.count() === 0);
    assert.match(await focus.innerText(), /지금 보이는 다른 상자와 이어진 import가 없어요\./);
    assert.equal(await boxes.count(), 6);
    await directFocus.click();
    await focus.waitFor({ state: 'detached' });
    await until(async () => await arrows.count() === 2);
    assert.equal(await directFocus.getAttribute('aria-pressed'), 'false');
    await appFocus.click();
    await focus.getByRole('button', { name: '모두 보기', exact: true }).click();
    await focus.waitFor({ state: 'detached' });
    await until(async () => await arrows.count() === 2);
    assert.equal(await canvas.locator('button[aria-pressed="true"]').count(), 0);
    assert.equal(await canvas.locator('.map-box--dim, .map-box--focus').count(), 0);

    await appBox.locator('.map-box__label').click();
    const fileBox = boxes.filter({ hasText: 'page.ts' });
    await fileBox.getByRole('button', { name: 'page.ts 이어진 것만 보기', exact: true }).click();
    await until(async () => await arrows.count() === 1);
    assert.equal(await canvas.isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: 'web/app/page.ts', exact: true }).count(), 0);
    assert.match(await focus.innerText(), /‘page.ts’과 이어진 것만 보는 중 · 가져다 씀 1곳 · 이 상자를 가져다 씀 0곳/);
    assert.deepEqual(await chips.getByRole('button').allTextContents(), ['web 접기', 'web/app 접기']);
    assert.equal(await arrows.getAttribute('data-id'), `${await fileBox.getAttribute('data-id')}->folder:web/lib`);
    // Opening another area clears focus even though page.ts remains visible.
    await boxes.filter({ hasText: 'web/e2e · 파일 1개' }).locator('.map-box__label').click();
    await focus.waitFor({ state: 'detached' });
    await boxes.filter({ hasText: 'check.ts' }).waitFor();
    await until(async () => await arrows.count() === 2);
    await fileBox.getByRole('button', { name: 'page.ts 이어진 것만 보기', exact: true }).click();
    await focus.waitFor();
    await chips.getByRole('button', { name: 'web 접기', exact: true }).click();
    await focus.waitFor({ state: 'detached' });
    await until(async () => await boxes.count() === 3 && await arrows.count() === 0);
    await boxes.filter({ hasText: 'web · 파일 4개' }).locator('.map-box__label').click();
    await until(async () => await boxes.count() === 6 && await arrows.count() === 2);
    assert.equal(await focus.count(), 0);
    await appFocus.click();
    await focus.waitFor();
    await chips.getByRole('button', { name: 'web 접기', exact: true }).click();
    await focus.waitFor({ state: 'detached' });
    await boxes.filter({ hasText: 'web · 파일 4개' }).locator('.map-box__label').click();
    await until(async () => await boxes.count() === 6 && await arrows.count() === 2);
    assert.equal(await focus.count(), 0);
    assert.equal(await appFocus.getAttribute('aria-pressed'), 'false');
    await appFocus.click();
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
    await focus.waitFor({ state: 'detached' });
    await until(async () => await arrows.count() === 2);
    await canvas.getByRole('button', { name: 'page.ts 이어진 것만 보기', exact: true }).click();
    await focus.waitFor();
    await page.getByRole('button', { name: '설계 보기', exact: true }).click();
    await focus.waitFor({ state: 'detached' });
    await until(async () => await boxes.count() === 3 && await arrows.count() === 0);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
  });
  await check('Project map hover: faint arrows, computed emphasis, stale hover and connection-list focus', async () => {
    await dialogTo(areaMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '영역 지도 프로젝트', exact: true }).waitFor();
    await openFileMap();
    const canvas = page.getByTestId('map-canvas');
    const boxes = canvas.locator('.react-flow__node');
    const arrows = canvas.locator('.react-flow__edge');
    const strong = canvas.locator('.map-arrow--strong');
    const faint = canvas.locator('.map-arrow--faint');
    const chips = page.getByRole('group', { name: '펼친 곳', exact: true });
    const focus = page.getByRole('group', { name: '이어진 것만 보는 중', exact: true });
    const list = page.getByRole('region', { name: '상자별 연결', exact: true });
    const heading = page.getByRole('heading', { name: '프로젝트 지도', exact: true });
    const appBox = boxes.filter({ hasText: 'web/app · 파일 1개' });
    const e2eBox = boxes.filter({ hasText: 'web/e2e · 파일 1개' });
    await until(async () => await boxes.count() === 3);
    await boxes.filter({ hasText: 'web · 파일 4개' }).locator('.map-box__label').click();
    await heading.hover();
    await until(async () => await boxes.count() === 6 && await faint.count() === 2);
    assert.equal(await strong.count(), 0);
    assert.equal(await canvas.locator('.map-box--dim, .map-box--focus').count(), 0);

    await appBox.hover();
    await until(async () => await strong.count() === 1 && await faint.count() === 1);
    assert.equal(await arrows.count(), 2);
    assert.equal(await strong.getAttribute('data-id'), 'folder:web/app->folder:web/lib');
    assert.equal(await faint.getAttribute('data-id'), 'folder:web/e2e->folder:web/lib');
    assert.match(await e2eBox.getAttribute('class'), /\bmap-box--dim\b/);
    assert.doesNotMatch(await appBox.getAttribute('class'), /\bmap-box--(?:dim|focus)\b/);
    assert.doesNotMatch(await boxes.filter({ hasText: 'web/lib · 파일 1개' }).getAttribute('class'), /\bmap-box--dim\b/);
    assert.equal(await strong.locator('.react-flow__edge-path').evaluate(path => getComputedStyle(path).strokeWidth), '2.4px');
    assert.equal(await faint.locator('.react-flow__edge-path').evaluate(path => getComputedStyle(path).opacity), '0.25');
    await heading.hover();
    await until(async () => await strong.count() === 0 && await faint.count() === 2);
    assert.equal(await canvas.locator('.map-box--dim, .map-box--focus').count(), 0);

    // Opening the hovered area removes its id; bringing it back must not revive that hover.
    await e2eBox.hover();
    await until(async () => await strong.count() === 1);
    assert.equal(await strong.getAttribute('data-id'), 'folder:web/e2e->folder:web/lib');
    await e2eBox.locator('.map-box__label').click();
    await boxes.filter({ hasText: 'check.ts' }).waitFor();
    await e2eBox.waitFor({ state: 'detached' });
    await heading.hover();
    await until(async () => await faint.count() === 2 && await strong.count() === 0);
    await chips.getByRole('button', { name: 'web 접기', exact: true }).click();
    await until(async () => await boxes.count() === 3 && await arrows.count() === 0);
    await boxes.filter({ hasText: 'web · 파일 4개' }).locator('.map-box__label').click();
    await heading.hover();
    await until(async () => await boxes.count() === 6 && await faint.count() === 2);
    assert.equal(await strong.count(), 0);
    assert.equal(await canvas.locator('.map-box--dim, .map-box--focus').count(), 0);

    assert.equal(await list.getByRole('heading', { level: 3 }).innerText(), '상자별 연결 · 상자 6개');
    const appRow = list.locator('li').filter({ has: page.getByRole('button', { name: 'web/app', exact: true }) });
    assert.match(await appRow.innerText(), /가져다 씀 1곳: lib\//);
    const libButton = list.getByRole('button', { name: 'web/lib', exact: true });
    await libButton.click();
    await focus.waitFor();
    // The list may scroll the canvas out of view; bring it back before counting rendered arrows.
    await heading.hover();
    await until(async () => await arrows.count() === 2 && await strong.count() === 2);
    assert.match(await focus.innerText(), /가져다 씀 0곳 · 이 상자를 가져다 씀 2곳/);
    assert.equal(await libButton.getAttribute('aria-pressed'), 'true');
    assert.equal(await canvas.getByRole('button', { name: 'web/lib · 파일 1개 이어진 것만 보기', exact: true })
      .getAttribute('aria-pressed'), 'true');
    assert.equal(await list.locator('li').count(), 6);
    await libButton.click();
    await focus.waitFor({ state: 'detached' });
    await heading.hover();
    await until(async () => await faint.count() === 2 && await strong.count() === 0);
    assert.equal(await libButton.getAttribute('aria-pressed'), 'false');
    assert.equal(await canvas.locator('.map-box--dim, .map-box--focus').count(), 0);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
  });
  await check('Project map: an unused candidate opens its file in the code reader', async () => {
    await dialogTo(unusedMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '안 쓰는 파일 후보 프로젝트', exact: true }).waitFor();
    await openFileMap();
    const candidates = page.getByRole('region', { name: '아무도 가져다 쓰지 않는 파일 후보', exact: true });
    await candidates.getByRole('heading', { name: '아무도 가져다 쓰지 않는 파일 후보 · 1개', exact: true }).waitFor();
    assert.equal(await candidates.getByRole('button', { name: 'html-entry.ts', exact: true }).count(), 0);
    await candidates.getByText('뺀 파일: 설정·HTML에 적힌 파일 1', { exact: true }).waitFor();
    await candidates.getByRole('button', { name: 'orphan.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'orphan.ts', exact: true }).waitFor();
    assert.match(await page.locator('.reader').innerText(), /const orphanValue = 42;/);
  });

  await check('Project map: file and design views, evidence, freshness, reopening and cancelled or stale maps', async () => {
    await dialogTo(mapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '지도 프로젝트', exact: true }).waitFor();
    await openFileMap();
    assert.equal(await page.getByRole('tablist', { name: '프로젝트 지도 보기' }).count(), 0);
    const boxes = page.locator('.react-flow__node');
    // Small projects also start with folded folders; the deep file was never listed.
    await until(async () => await boxes.count() === 3);
    assert.equal(await page.getByRole('button', { name: '설계 보기', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '파일 보기', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
    await until(async () => await boxes.count() === 5);
    // The feature guide keeps its own (hidden) copy of the folder warnings while the full map is shown.
    await page.getByText('초기 탐색 제한(파일 1,000개·항목 5,000개·깊이 20)에 도달했습니다.', { exact: false }).filter({ visible: true }).waitFor();
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
    const files = page.getByRole('region', { name: '파일 목록', exact: true });
    await files.getByRole('button', { name: 'store/save.ts', exact: true }).waitFor();
    assert.equal(await files.getByRole('button', { name: 'store/save.ts', exact: true }).getAttribute('aria-current'), 'true');
    assert.equal(await files.getByRole('button', { name: '폴더 store', exact: true }).getAttribute('aria-expanded'), 'true');
    // An import's evidence opens the importing file with that import highlighted.
    await openFileMap();
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    const loadLine = page.locator('.map-list li').filter({ hasText: 'store/load.ts 1행 → ui/view.ts' });
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByRole('heading', { name: 'store/load.ts', exact: true }).waitFor();
    assert.match(await page.getByTestId('evidence-range').innerText(), /store\/load\.ts · 1–1줄/);
    // A wake from sleep while that file is read (sent as the read request leaves for the worker): no highlight.
    await openFileMap();
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
    await openFileMap();
    await rebuildFreshMap();
    // A change after the map was drawn: the map asks for a re-check and the old position is not highlighted.
    await openFileMap();
    await writeFile(path.join(mapFixture, 'store/load.ts'), "\n" + mapFiles['store/load.ts']);
    await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await page.getByText('연결 목록 · 6개', { exact: true }).click();
    await loadLine.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByText('지도를 만든 뒤 이 파일이 바뀌어 import 위치를 강조하지 않았어요.', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await openFileMap();
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
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    if (await page.getByRole('button', { name: '폴더 shared', exact: true }).getAttribute('aria-expanded') === 'false') {
      await page.getByRole('button', { name: '폴더 shared', exact: true }).click();
    }
    await page.getByRole('button', { name: 'shared/format.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'shared/format.ts', exact: true }).waitFor();
    await openFileMap();
    await page.getByRole('button', { name: '지도 만들기 취소', exact: true }).click();
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).waitFor();
    // A map still being drawn when the folder is opened again is dropped; reopening shows new files.
    await page.getByRole('button', { name: '지도 다시 만들기', exact: true }).click();
    await page.getByText('지도를 만드는 중…', { exact: true }).waitFor();
    await writeFile(path.join(mapFixture, 'ui/extra.ts'), "import { view } from './view';\nexport const extra = 1;\n");
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await app.evaluate(() => { process.getBuiltinModule('node:worker_threads').Worker.prototype.once = globalThis.testOriginalOnce; });
    await openFileMap();
    // Reopening the folder returns to the overview when its scan ends.
    const allTab = page.getByRole('button', { name: '프로젝트 지도', exact: true });
    await until(async () => {
      if (await allTab.getAttribute('aria-current') !== 'page') await openFileMap();
      // The map can be redrawn between these calls, so a vanished button is tried again on the next pass.
      const fileView = page.getByRole('button', { name: '파일 보기', exact: true });
      if (await fileView.getAttribute('aria-pressed', { timeout: 200 }).catch(() => null) === 'false') await fileView.click({ timeout: 1000 }).catch(() => {});
      return await boxes.count() === 6;
    });
    assert.equal(await page.getByText('지도를 만드는 동안', { exact: false }).count(), 0);
    // A larger project: cancelling while its files are parsed stops the map, not the app.
    await dialogTo(bigMapFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '큰 지도 프로젝트', exact: true }).waitFor();
    await openFileMap();
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
    const importButton = page.locator('details').filter({ hasText: '연결 목록 · 65개' }).locator('.map-list button').first();
    assert.equal(await importButton.isDisabled(), true);
    await importButton.click({ force: true });
    await app.evaluate(() => globalThis.testMapReleaseDialog());
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'order.ts', exact: true }).isVisible(), true);
  });
  await check('Cancelling while files are parsed leaves the app running, and the next open works', async () => {
    for (let round = 0; round < 3; round++) {
      // Opening runs the overview, which parses up to 20 files of about 100 KB.
      await dialogTo(bigMapFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('button', { name: '프로젝트 닫기' }).click();
      assert.equal(await app.evaluate(() => 'alive'), 'alive');
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).waitFor();
    }
    for (let round = 0; round < 3; round++) {
      await dialogTo(bigMapFixture);
      await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
      await page.getByRole('heading', { name: '큰 지도 프로젝트', exact: true }).waitFor();
      await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
      await page.getByRole('button', { name: `폴더 part${round}`, exact: true }).click();
      await page.getByRole('button', { name: `part${round}/file${round}.ts`, exact: true }).click();
      await page.getByRole('button', { name: '프로젝트 닫기' }).click();
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
    await page.getByRole('button', { name: '프로젝트 닫기' }).click();
    await until(() => app.evaluate(() => globalThis.testUiTerminateWaiting === true));
    await page.getByRole('button', { name: '프로젝트 닫기' }).click();
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
    await page.getByRole('button', { name: '프로젝트 닫기' }).click();
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
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await openAiSection('질문하기');
    const blocked = page.getByTestId('send-blocked');
    await blocked.getByText('먼저 ‘설정’에서 ‘로컬 AI 설치 확인’을 눌러 주세요.', { exact: true }).waitFor();
    const send = page.getByRole('button', { name: '질문 보내기', exact: true });
    assert.equal(await send.isDisabled(), true);
    assert.equal(await send.getAttribute('aria-describedby'), await blocked.getAttribute('id'));
    const sendBox = await send.boundingBox();
    const reasonBox = await blocked.boundingBox();
    assert.ok(sendBox && reasonBox && reasonBox.y >= sendBox.y + sendBox.height, 'the reason sits below the send button');
    await page.getByRole('button', { name: '질문하기', exact: true }).click();
    assert.equal(await blocked.isVisible(), false);
    await openAiSection('질문하기');
    assert.equal(await blocked.isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '설정', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('combobox', { name: 'AI 사용 방식' }).isVisible(), false);
    await page.getByText('AI · 로컬 워커 · 설치 확인 필요', { exact: true }).waitFor();
    await openAiSection('설정');
    const selector = page.getByRole('combobox', { name: 'AI 사용 방식' });
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)),
      ['local-worker', 'codex', 'claude-code', 'antigravity']);
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('설정 보존 확인');
    // Original production handler: fixed installation candidates and --version only.
    // No authentication or AI request is performed by this button.
    await openAiSection('설정');
    await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
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
    await checkConsentDisclosure(page.locator('.ai-panel'), '선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·관련 파일(추가 최대 4개)·질문·최근 답변을 Codex와 Gemini에 보내는 데 동의합니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.');
    // Each single mode opens with its own CLI, names it, and reads no other file.
    for (const [mode, binary, recipient] of [['codex', 'Codex', 'Codex'], ['antigravity', 'Antigravity', 'Gemini(Antigravity)']]) {
      await selector.selectOption(mode);
      const found = new RegExp(`${binary} · 설치 확인`).test(listed);
      assert.match(await page.getByTestId('ai-readiness').innerText(), found ? /한 AI가 바로 설명하고 다른 AI의 대조는 없어요/ : /단독에는 .+ 필요해요/);
      assert.equal(await page.getByRole('checkbox').isEnabled(), found);
      await checkConsentDisclosure(page.locator('.ai-panel'), `선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·질문·최근 답변을 ${recipient}에 보내는 데 동의합니다. 다른 파일은 더 읽지 않습니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.`);
      assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
    }
    await selector.selectOption('claude-code');
    assert.equal(await page.getByTestId('ai-readiness').innerText(), 'Claude Code 단독은 아직 준비 중이에요.');
    assert.equal(await page.getByRole('checkbox').isEnabled(), false);
    await checkConsentDisclosure(page.locator('.ai-panel'), '선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·질문·최근 답변을 Claude Code에 보내는 데 동의합니다. 다른 파일은 더 읽지 않습니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.');
    await selector.selectOption('local-worker');
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
    assert.equal(await selector.inputValue(), 'local-worker');
    assert.equal(await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue(), '설정 보존 확인');
  });
  await check('FAKE AI IPC: completion before start response is retained across panel/question folding', async () => {
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
              { kind: 'concept', text: '일반 개념 설명입니다.' }],
            terms: globalThis.testFakeAiFlow ? [{ term: 'login', meaning: '로그인 요청을 보내는 함수' }] : [],
            examples: globalThis.testFakeAiFlow ? [
              { given: '주문 2개, 재고 5개일 때', result: '주문 가능한지 확인하고 남은 재고 3개를 돌려줘요.',
                evidenceIds: [request.evidenceId, related.id, request.evidenceId] },
              { given: '주문 8개, 재고 5개일 때', result: '재고가 부족합니다에서 멈춰요.', evidenceIds: [request.evidenceId] },
            ] : [],
            unknowns: globalThis.testFakeAiFlow ? ['실제 서버 응답은 확인하지 못했어요.'] : [] },
          review: 'AI 검토됨', models: [{ stage: 'explaining', provider: 'antigravity',
            requestedModel: 'gemini-3.8-flash-high', reportedModel: null }],
        };
        const completed = { kind: 'completed', jobId, projectId: request.projectId, result };
        globalThis.testFakeAiCalls.push({ jobId, request });
        if (globalThis.testFakeAiBehavior === 'fail') return { ok: false, code: 'AI_FAILED', message: '가짜 질문 실패' };
        if (globalThis.testFakeAiBehavior === 'hold') {
          globalThis.testFakeAiLate = () => event.sender.send('learning:ai-event', completed);
        } else {
          event.sender.send('learning:ai-event', completed);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { ok: true, value: { jobId } };
      });
    });
    await openAiSection('설정');
    await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('ai-readiness').innerText()).includes('테스트 전용'));
    // Reopen with no file read yet: a wake-up must ask for a read before asking for a code selection.
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
    await openAiSection('질문하기');
    const blocked = page.getByTestId('send-blocked');
    const send = page.getByRole('button', { name: '질문 보내기', exact: true });
    const selectionReason = '코드 읽기에서 함수나 구문을 골라 주세요. 고른 부분이 질문할 범위가 돼요.';
    const staleReason = '코드가 바뀌었어요. 코드 읽기에서 파일을 다시 열고(이미 열려 있으면 ‘파일 다시 읽기’) 함수나 구문을 다시 골라 주세요.';
    await blocked.getByText(selectionReason, { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).count(), 0);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await blocked.getByText(staleReason, { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'order.ts', exact: true }).click();
    await blocked.getByText(selectionReason, { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('');
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await blocked.getByText('질문을 적어 주세요.', { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    const sendBox = await send.boundingBox();
    const reasonBox = await blocked.boundingBox();
    assert.ok(sendBox && reasonBox && reasonBox.y >= sendBox.y + sendBox.height, 'even a short reason sits below the send button');
    // A real file change clears the selection. Rereading first, then choosing it again resolves each reason.
    const beforeChange = await readFile(path.join(fixture, 'order.ts'), 'utf8');
    await writeFile(path.join(fixture, 'order.ts'), `${beforeChange}\n// Send reason fixture change.\n`);
    await blocked.getByText(staleReason, { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '주문', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await blocked.getByText(selectionReason, { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('button', { name: '주문', exact: true }).click();
    await blocked.getByText('질문을 적어 주세요.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('빠른 응답');
    await blocked.getByText('‘보낼 자료에 동의’에 체크해 주세요.', { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('checkbox').check();
    await until(async () => await send.isEnabled());
    assert.equal(await blocked.count(), 0);
    assert.equal(await send.getAttribute('aria-describedby'), null);
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText('가짜 설명: 빠른 응답', { exact: true }).waitFor();
    await page.getByText('AI · 로컬 워커 · 준비됨', { exact: true }).waitFor();
    await page.getByText('Antigravity · 호출 모델 gemini-3.8-flash-high · 응답 모델 미보고', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
    await page.getByRole('button', { name: '질문하기', exact: true }).click();
    assert.equal(await page.getByText('가짜 설명: 빠른 응답', { exact: true }).isVisible(), true);
    assert.equal(await page.getByTestId('question-scope').isVisible(), true);
    assert.equal(await page.getByTestId('question-scope').count(), 1);
    await openAiSection('질문하기');
    await page.getByText('가짜 설명: 빠른 응답', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'AI 설명' }).count(), 1);
    assert.equal(await page.getByRole('region', { name: '예시로 따라가기', exact: true }).count(), 0);
  });
  await check('FAKE AI IPC: cancelled job completion is ignored and a subsequent question succeeds', async () => {
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; });
    await page.getByRole('textbox', { name: '선택한 코드에 질문' }).fill('취소할 질문');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await until(() => app.evaluate(() => globalThis.testFakeAiCalls.length === 2));
    // Allow the immediate start response to register its job before cancellation.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('button', { name: '질문하기', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '선택한 코드에 질문' }).isVisible(), false);
    assert.equal(await page.locator('.ai-panel > [role="status"]').isVisible(), true);
    assert.equal(await page.getByTestId('question-scope').isVisible(), true);
    assert.equal(await page.getByTestId('question-scope').count(), 1);
    await page.getByRole('button', { name: 'AI 작업 취소', exact: true }).click();
    await page.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    await openAiSection('질문하기');
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
    await answer.locator('details > summary').click();
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
  await check('AI question failure stays visible when the question is folded', async () => {
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'fail'; });
    await openAiSection('질문하기');
    const panel = page.locator('.ai-panel');
    await panel.getByRole('textbox').fill('실패할 질문');
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: '가짜 질문 실패' }).waitFor();
    await panel.getByRole('button', { name: '질문하기', exact: true }).click();
    assert.equal(await panel.getByRole('alert').isVisible(), true);
    assert.equal(await panel.getByRole('textbox').isVisible(), false);
    await app.evaluate(() => { globalThis.testFakeAiBehavior = 'early'; });
  });
  await check('Flow question (fake AI): keeps the step and narrow code selection, asks consent and renders easy-to-code layers', async () => {
    const { story, question, ask } = await openLoginFlowQuestion();
    const topic = await story.locator(':scope > .map-actions > h3').innerText();
    const title = await story.getByTestId('story-step').getByRole('heading', { level: 3 }).innerText();
    const expected = `‘${topic.slice(0, 80)}’ 기능의 4번째 단계 ‘${title.slice(0, 80)}’에서 이 함수가 하는 일을 쉽게 설명해 주세요. `
      + '무엇을 받아서, 무엇을 확인하고, 무엇을 돌려주거나 바꾸는지 알려 주고, 실패하거나 멈추는 경우도 적어 주세요.';
    const range = await story.getByTestId('evidence-range').innerText();
    const code = await story.getByTestId('flow-code').innerText();
    const calls = await app.evaluate(() => globalThis.testFakeAiCalls.length);
    await page.getByRole('button', { name: '질문하기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await ask.click();
    await until(async () => await question.inputValue() === expected);
    assert.equal(await page.getByRole('button', { name: '질문하기', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('button', { name: '흐름 따라가기', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await story.getByRole('button', { name: '4단계 서버 받는 곳', exact: true }).getAttribute('aria-current'), 'step');
    assert.equal(await story.getByTestId('evidence-range').innerText(), range);
    assert.equal(await story.getByTestId('flow-code').innerText(), code);
    assert.equal(await page.getByTestId('question-scope').innerText(), '질문 기준: api/controller.ts · 1–1행');
    assert.equal(await app.evaluate(() => globalThis.testFakeAiCalls.length), calls);
    const panel = page.locator('.ai-panel');
    const consent = panel.getByRole('checkbox', { name: '보낼 자료에 동의', exact: true });
    assert.equal(await consent.isChecked(), false);
    assert.equal(await panel.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), true);
    await app.evaluate(() => { globalThis.testFakeAiFlow = true; });
    try {
      await consent.check();
      await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
      const answer = panel.getByRole('region', { name: 'AI 설명', exact: true }).last();
      await answer.getByText(`학습 주제: ${topic}`, { exact: true }).waitFor();
      assert.equal(await answer.locator(':scope > b').innerText(), expected);
      assert.deepEqual(await answer.locator(':scope > h4, :scope > section h4, :scope > details > summary').allInnerTexts(),
        ['쉽게', '낱말 풀이', '예시로 따라가기', '자세히 보기 · 단계 1개 · 설명 2개', '코드']);
      assert.deepEqual(await answer.getByRole('region', { name: '낱말 풀이', exact: true }).locator('dt, dd').allInnerTexts(),
        ['login', '로그인 요청을 보내는 함수']);
      const examples = answer.getByRole('region', { name: '예시로 따라가기', exact: true });
      assert.equal(await examples.isVisible(), true);
      assert.equal(await examples.getByText('코드를 실제로 실행한 결과가 아니에요. AI가 코드를 읽고 만든 가상의 값이에요.', { exact: true }).isVisible(), true);
      const items = examples.locator(':scope > ol > li');
      assert.equal(await items.count(), 2);
      for (const item of await items.all()) {
        assert.equal(await item.getByText('가상의 예시 · 실행하지 않음', { exact: true }).isVisible(), true);
        assert.equal(await item.getByRole('button').first().isEnabled(), true);
      }
      assert.deepEqual(await items.locator(':scope > p').allInnerTexts(), [
        '예를 들어 주문 2개, 재고 5개일 때', '→ 주문 가능한지 확인하고 남은 재고 3개를 돌려줘요.',
        '예를 들어 주문 8개, 재고 5개일 때', '→ 재고가 부족합니다에서 멈춰요.',
      ]);
      assert.deepEqual(await examples.getByRole('list', { name: '예시 1의 근거', exact: true }).getByRole('button').allInnerTexts(),
        ['order.ts · 1–1행', 'related.ts · 파일 전체 근거 · 세부 위치 미확인']);
      assert.deepEqual(await examples.getByRole('list', { name: '예시 2의 근거', exact: true }).getByRole('button').allInnerTexts(), ['order.ts · 1–1행']);
      assert.equal(await answer.locator('details').evaluate(element => element.open), false);
      assert.equal(await answer.getByText('가짜 단계', { exact: true }).isVisible(), false);
      const unknown = answer.getByText('확인하지 못함: 실제 서버 응답은 확인하지 못했어요.', { exact: true });
      assert.equal(await unknown.isVisible(), true);
      assert.equal(await unknown.evaluate(element => !!(element.previousElementSibling?.matches('ul[aria-label="답변에 제공한 파일"]'))), true);
      await answer.locator('details > summary').click();
      await answer.getByText('가짜 단계', { exact: true }).waitFor();
      await answer.getByRole('list', { name: '‘가짜 단계’의 근거' }).waitFor();
      // A moved step does not retarget the prepared question. A narrow line stays narrow when asking about its function.
      const scope = await page.getByTestId('question-scope').innerText();
      await story.getByRole('button', { name: '5단계 화면 결과', exact: true }).click();
      await story.getByRole('region', { name: '응답 뒤 화면', exact: true }).getByRole('button', { name: '이 줄 보기', exact: true }).click();
      await until(async () => /web\/app\/login\/page.tsx · 6–6줄/.test(await story.getByTestId('evidence-range').innerText()));
      assert.equal(await page.getByTestId('question-scope').innerText(), scope);
      const narrowRange = await story.getByTestId('evidence-range').innerText();
      const narrowCode = await story.getByTestId('flow-code').innerText();
      // The old answer makes this a follow-up conversation, cancelled when a new step question is prepared.
      await question.fill('진행 중인 질문');
      await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; });
      await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
      await until(() => app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request.question === '진행 중인 질문'));
      await panel.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
      await ask.click();
      await until(async () => (await question.inputValue()).includes('5번째 단계'));
      await until(() => app.evaluate(() => globalThis.testFakeAiCancelled.includes(globalThis.testFakeAiCalls.at(-1).jobId)));
      assert.equal(await consent.isChecked(), false);
      assert.equal(await story.getByTestId('evidence-range').innerText(), narrowRange);
      assert.equal(await story.getByTestId('flow-code').innerText(), narrowCode);
      assert.equal(await story.getByRole('button', { name: '5단계 화면 결과', exact: true }).getAttribute('aria-current'), 'step');
      assert.equal(await page.getByTestId('question-scope').innerText(), '질문 기준: web/app/login/page.tsx · 4–7행');
      await story.getByTestId('flow-code').locator('.cm-content').focus();
      await until(async () => await page.evaluate(() => getSelection()?.toString()) === "router.push('/')");
      await app.evaluate(() => { globalThis.testFakeAiLate(); globalThis.testFakeAiBehavior = 'early'; });
      await consent.check();
      await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
      await until(() => app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request.question.includes('5번째 단계')));
      assert.equal(await app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request.conversationId), undefined);
      await panel.getByRole('region', { name: 'AI 설명', exact: true }).getByText(`학습 주제: ${topic}`, { exact: true }).waitFor();
      assert.equal(await panel.getByText('가짜 설명: 진행 중인 질문', { exact: true }).count(), 0);
    } finally {
      await app.evaluate(() => { globalThis.testFakeAiFlow = false; globalThis.testFakeAiBehavior = 'early'; });
    }
  });
  await check('Flow question: changed or missing function and read failures keep the question and release the lock', async () => {
    for (const failure of ['changed', 'missing', 'source-IO', 'evidence-IO', 'evidence-CHANGED', 'evidence-NOT_ALLOWED']) {
      const { story, question, ask } = await openLoginFlowQuestion();
      const scope = await page.getByTestId('question-scope').innerText();
      const range = await story.getByTestId('evidence-range').innerText();
      const code = await story.getByTestId('flow-code').innerText();
      await app.evaluate(({ ipcMain }, failure) => {
        const channel = failure.startsWith('evidence-') ? 'learning:evidence' : 'learning:read';
        const original = ipcMain._invokeHandlers.get(channel);
        ipcMain._invokeHandlers.set(channel, async (...args) => {
          ipcMain._invokeHandlers.set(channel, original);
          if (failure.includes('-')) return { ok: false, code: failure.split('-')[1], message: `시험용 질문 준비 실패: ${failure}` };
          const result = await original(...args);
          if (!result.ok) throw new Error('Expected real source for flow question');
          if (failure === 'changed') return { ...result, value: { ...result.value, hash: '0'.repeat(64) } };
          return { ...result, value: { ...result.value, analysis: { ...result.value.analysis,
            symbols: result.value.analysis.symbols.map(symbol => ({ ...symbol,
              evidence: { ...symbol.evidence, startUtf16: symbol.evidence.startUtf16 + 1 } })) } } };
        });
      }, failure);
      await ask.click();
      const message = failure === 'changed' ? '흐름을 찾은 뒤 이 파일이 바뀌어 질문을 준비하지 않았어요. 주소를 다시 찾아 주세요.'
        : failure === 'missing' ? '이 함수는 코드 분석 범위 밖이라 질문할 코드로 고르지 못했어요. 코드 읽기에서 범위를 골라 질문해 주세요.'
          : `시험용 질문 준비 실패: ${failure}`;
      await page.getByText(message, { exact: true }).waitFor();
      assert.equal(await page.getByTestId('question-scope').innerText(), scope, failure);
      assert.equal(await question.inputValue(), '기존 질문 유지', failure);
      assert.equal(await story.getByTestId('evidence-range').innerText(), range, failure);
      assert.equal(await story.getByTestId('flow-code').innerText(), code, failure);
      assert.equal(await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isEnabled(), true, failure);
      if (['evidence-CHANGED', 'evidence-NOT_ALLOWED'].includes(failure)) {
        await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
      } else {
        assert.equal(await story.getByRole('button', { name: '5단계 화면 결과', exact: true }).isEnabled(), true, failure);
      }
    }
  });
  await check('Flow question: both reads discard revision changes and superseded requests without unlocking a newer read', async () => {
    for (const channel of ['learning:read', 'learning:evidence']) {
      for (const transition of ['revision', 'other-read', 'close', 'switch']) {
        const { story, question, ask } = await openLoginFlowQuestion();
        // An answer's related-file button can start a newer read while question preparation is locked.
        if (transition === 'other-read') {
          await page.locator('.ai-panel').getByRole('checkbox', { name: '보낼 자료에 동의', exact: true }).check();
          await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
          await page.getByText('가짜 설명: 기존 질문 유지', { exact: true }).waitFor();
          await question.fill('다른 읽기 뒤에도 남을 질문');
        }
        await app.evaluate(({ ipcMain }, channel) => {
          const originals = new Map(['learning:read', 'learning:evidence'].map(name => [name, ipcMain._invokeHandlers.get(name)]));
          const state = { calls: { 'learning:read': 0, 'learning:evidence': 0 }, waiting: false, returned: false,
            otherWaiting: false, holdOther: false, release: null, releaseOther: null };
          globalThis.testFlowQuestion = state;
          globalThis.testRestoreFlowQuestion = () => {
            for (const [name, original] of originals) ipcMain._invokeHandlers.set(name, original);
            state.release?.(); state.releaseOther?.();
          };
          for (const [name, original] of originals) ipcMain._invokeHandlers.set(name, async (event, request) => {
            state.calls[name]++;
            const result = await original(event, request);
            if (name === channel && !state.waiting) {
              if (!result.ok) throw new Error('Expected successful read before delaying flow question');
              state.projectId = request.projectId;
              state.waiting = true;
              await new Promise(resolve => { state.release = resolve; });
              state.returned = true;
            } else if (name === 'learning:evidence' && state.holdOther) {
              state.holdOther = false;
              state.otherWaiting = true;
              await new Promise(resolve => { state.releaseOther = resolve; });
            }
            return result;
          });
        }, channel);
        try {
          await ask.click();
          await until(() => app.evaluate(() => globalThis.testFlowQuestion.waiting));
          assert.equal(await story.getByRole('button', { name: '5단계 화면 결과', exact: true }).isDisabled(), true);
          const evidenceReads = await app.evaluate(() => globalThis.testFlowQuestion.calls['learning:evidence']);
          if (transition === 'revision') {
            // Only a renderer change notice: no new read and no request counter increment.
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('learning:project-event',
              { projectId: globalThis.testFlowQuestion.projectId, kind: 'changed' }));
            await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
            await until(async () => await page.getByTestId('question-scope').count() === 0);
          } else if (transition === 'other-read') {
            await app.evaluate(() => { globalThis.testFlowQuestion.holdOther = true; });
            await page.getByRole('region', { name: 'AI 설명', exact: true }).getByRole('button', { name: 'related.ts · 1–1행', exact: true }).click();
            await until(() => app.evaluate(() => globalThis.testFlowQuestion.otherWaiting));
          } else {
            await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
            await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
            await until(() => page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isEnabled());
          }
          if (transition === 'switch') {
            await dialogTo(fixture);
            await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
            await page.getByRole('heading', { name: '한글 프로젝트', exact: true }).waitFor();
            await openTreeFile('order.ts');
            await page.getByRole('button', { name: '주문', exact: true }).click();
            await openAiSection('질문하기');
            await page.getByTestId('question-scope').waitFor();
            await question.fill('새 프로젝트 질문');
          }
          const scope = await page.getByTestId('question-scope').allTextContents();
          const draft = await question.count() ? await question.inputValue() : null;
          const alerts = await page.locator('.notices').allTextContents();
          const view = await page.locator('.views__item[aria-current="page"]').allTextContents();
          const readsBeforeRelease = await app.evaluate(() => globalThis.testFlowQuestion.calls['learning:evidence']);
          await app.evaluate(() => globalThis.testFlowQuestion.release());
          await until(() => app.evaluate(() => globalThis.testFlowQuestion.returned));
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.deepEqual(await page.getByTestId('question-scope').allTextContents(), scope, `${channel} ${transition}`);
          assert.equal(await question.count() ? await question.inputValue() : null, draft, `${channel} ${transition}`);
          assert.deepEqual(await page.locator('.notices').allTextContents(), alerts, `${channel} ${transition}`);
          assert.deepEqual(await page.locator('.views__item[aria-current="page"]').allTextContents(), view, `${channel} ${transition}`);
          assert.equal(await app.evaluate(() => globalThis.testFlowQuestion.calls['learning:evidence']), readsBeforeRelease,
            'An obsolete source reply must not start an evidence read');
          if (transition === 'other-read') {
            assert.equal(await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isDisabled(), true,
              'The old question must not unlock the newer evidence read');
            await app.evaluate(() => globalThis.testFlowQuestion.releaseOther());
            await until(async () => (await page.locator('.cm-line').allTextContents()).join('\n').includes('export const related'));
            assert.deepEqual(await page.getByTestId('question-scope').allTextContents(), scope);
            assert.equal(await question.inputValue(), draft);
          }
          await until(() => page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).isEnabled());
          if (transition === 'revision') {
            assert.equal(await app.evaluate(() => globalThis.testFlowQuestion.calls['learning:evidence']), evidenceReads);
            await page.getByText('코드 변경 또는 잠자기 복귀:', { exact: false }).waitFor();
            assert.equal(await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).isEnabled(), true);
            assert.equal(await ask.isDisabled(), true);
          }
        } finally {
          await app.evaluate(() => globalThis.testRestoreFlowQuestion());
        }
      }
    }
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
    await checkConsentDisclosure(card, '프로젝트 파일 목록, 고른 시작 파일, Codex가 고른 관련 파일(최대 4개)을 Codex와 Gemini에 보내는 데 동의합니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.');
    assert.equal(await create.isDisabled(), true);
    await card.getByRole('checkbox').check();
    // While the overview runs, the shared installation check is closed in the question panel too.
    await app.evaluate(() => { globalThis.testOverviewHold = true; });
    await create.click();
    await card.getByText('개요 작업 시작 중', { exact: true }).waitFor();
    const more = page.locator('details[aria-label="더 알아보기"]');
    await more.locator(':scope > summary').click();
    assert.equal(await more.evaluate(element => element.open), true);
    await more.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await more.evaluate(element => element.open), true);
    assert.equal(await card.getByText('개요 작업 시작 중', { exact: true }).isVisible(), true);
    assert.equal(await card.getByRole('button', { name: '개요 작업 취소', exact: true }).isVisible(), true);
    await openAiSection('설정');
    assert.equal(await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).isDisabled(), true);
    // The fake handler reads three files before it keeps the reply, so wait for it rather than racing those reads.
    await until(() => app.evaluate(() => typeof globalThis.testOverviewLate === 'function'));
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
    await answers.last().locator('details > summary').click();
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
    await openFileMap();
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
    await openFunctionFlow();
    await topicBar.getByRole('button', { name: '주제 닫기', exact: true }).click();
    await page.getByRole('button', { name: 'dup.ts', exact: true }).click();
    const runs = page.getByRole('button', { name: /^(First|Second)\.run$/ });
    await runs.nth(1).click();
    await topicBar.getByRole('button', { name: '이 함수에서 학습 시작', exact: true }).click();
    await topicBar.getByText('학습 주제 · 지금 고른 함수', { exact: true }).waitFor();
    await topicBar.getByRole('textbox', { name: '학습 이름' }).fill('두 번째 실행');
    await topicBar.getByText('원래 이름: Second.run', { exact: true }).waitFor();
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
    // Going back reopens the place's own view (the function view), so no function is chosen here: that would be a move.
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
    // The file tree is only in code reading. Opening that tab records the same place in code reading, so going back
    // passes through it before reaching the function view.
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'settings.ts', exact: true }).click();
    await page.getByRole('heading', { name: 'settings.ts', exact: true }).waitFor();
    await settle();
    await back.click();
    await settle();
    assert.equal(await page.getByRole('button', { name: '코드 읽기', exact: true }).getAttribute('aria-current'), 'page');
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
    await openFunctionFlow();
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
    await openFileMap();
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
    await openAiSection('질문하기');
    await until(async () => (await page.getByTestId('question-scope').innerText()).endsWith('4–6행'));
    await page.getByRole('button', { name: 'AI에게 단순하게 쓰는 법 묻기', exact: true }).click();
    await until(async () => (await page.getByTestId('question-scope').innerText()) === '질문 기준: src/work.ts · 3–66행');
    assert.equal(await page.getByRole('button', { name: '질문하기', exact: true }).getAttribute('aria-expanded'), 'true');
    const question = '이 함수를 더 단순하고 읽기 쉽게 쓸 수 있을까요? 바꾼다면 어디를 어떻게 바꾸면 좋을지 알려 주세요.';
    // The draft effect fills the question box and opens its input area.
    await until(async () => await page.getByRole('textbox', { name: '선택한 코드에 질문' }).inputValue() === question);
    await page.screenshot({ path: path.join(artifacts, 'hard-code-reader.png') });
    // Sent through the test-only AI handlers above: the request names the whole function's evidence.
    await openAiSection('설정');
    await page.locator('.ai-panel').getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('ai-readiness').innerText()).includes('테스트 전용'));
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText(`가짜 설명: ${question}`, { exact: true }).waitFor();
    const sent = await app.evaluate(() => globalThis.testFakeAiCalls.at(-1).request);
    const named = await page.evaluate(request => window.learning.readEvidence({ projectId: request.projectId, evidenceId: request.evidenceId }), sent);
    assert.deepEqual([named.ok, named.value.evidence.startLine, named.value.evidence.endLine], [true, 3, 66]);
    // After a change the map's entry no longer fits the file, so nothing is chosen.
    await writeFile(path.join(hardFixture, 'src/work.ts'), `// changed\n${hardSource}`);
    await openFileMap();
    await page.getByText('지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요.', { exact: false }).waitFor();
    await list.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByText('지도를 만든 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 지도를 다시 만들어 주세요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'long', exact: true }).getAttribute('aria-pressed'), 'false');
  });
  await check('Calls: what a function calls and where it is called from, moving to either, and stale after a change', async () => {
    await dialogTo(callsFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '호출 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await openTreeFile('src/app.ts');
    await page.getByRole('button', { name: 'placeOrder', exact: true }).click();
    await openFunctionFlow();
    const summary = page.getByRole('article', { name: '함수 요약' });
    await summary.getByText('부르는 것 · 3개', { exact: true }).waitFor();
    const calledList = summary.getByRole('list', { name: '이 함수가 부르는 것' });
    assert.deepEqual(await calledList.locator('li').allInnerTexts(), [
      '3행 check(order) → check src/app.ts 그 함수로 호출 위치',
      '4행 save(order) → save src/store.ts 그 함수로 호출 위치',
      '5행 log.info(order) · 확인 못 함멤버 호출이라 대상을 정하지 못했어요 호출 위치',
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
    await openFunctionFlow();
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
    await openFunctionFlow();
    await page.getByRole('button', { name: 'quick', exact: true }).click();
    await summary.getByText('부르는 것 · 1개', { exact: true }).waitFor();
    // After a change the lists are marked, and moving to a changed file does not choose anything.
    await writeFile(path.join(callsFixture, 'src/store.ts'), '// changed\nexport function save(order: string) {\n  return order;\n}\n');
    await summary.getByText('호출을 찾은 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 아래 목록은 그 전 코드 기준이에요.', { exact: true }).waitFor();
    await calledList.getByRole('button', { name: '그 함수로', exact: true }).click();
    await page.getByText('호출을 찾은 뒤 이 파일이 바뀌어 그 함수를 고르지 않았어요. 다시 찾아 주세요.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'save', exact: true }).getAttribute('aria-pressed'), 'false');
  });
  await check('Typed calls: navigate from controller to service, keeping incoming values unconfirmed', async () => {
    await dialogTo(callsFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '호출 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await openTreeFile('src/auth.controller.ts');
    await page.getByRole('button', { name: 'AuthController.login', exact: true }).click();
    await openFunctionFlow();
    const summary = page.getByRole('article', { name: '함수 요약' });
    const outgoing = summary.getByRole('list', { name: '이 함수가 부르는 것' });
    await outgoing.getByText('· 타입으로 찾음', { exact: true }).waitFor();
    assert.match(await outgoing.innerText(), /AuthService.signup/);
    await outgoing.getByRole('button', { name: '그 함수로', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'AuthService.signup', exact: true }).getAttribute('aria-pressed') === 'true');
    await summary.getByText('타입으로 찾은 부르는 곳 · 1개', { exact: true }).waitFor();
    await summary.getByText('부르는 곳 · 0개', { exact: true }).waitFor();
    await summary.getByRole('group', { name: '받는 값' }).getByRole('button', { name: 'input', exact: true }).click();
    await summary.getByText('이 함수로 이어진 부르는 곳이 없어 들어오는 값을 찾지 못했어요.', { exact: true }).waitFor();
    assert.equal(await summary.getByRole('list', { name: 'input에 넘기는 값', exact: true }).count(), 0);
    await summary.getByRole('list', { name: '타입으로 찾은 부르는 곳' }).getByRole('button', { name: '호출 위치', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'AuthController.login', exact: true }).getAttribute('aria-pressed') === 'true');
  });
  await check('Values: names a function uses, arguments from calls and tests, fixed values and writes, never run values', async () => {
    await dialogTo(valuesFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '값 프로젝트', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await openTreeFile('src/price.ts');
    await page.getByRole('button', { name: 'price', exact: true }).click();
    await openFunctionFlow();
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
    await openFunctionFlow();
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
    await openTreeFile('src/label.ts');
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
    await openTreeFile('src/func.ts');
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
    await openFileMap();
    const box = name => page.locator('.react-flow__node').filter({ hasText: name });
    await page.getByRole('button', { name: '파일 보기', exact: true }).click();
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
  await check('Function bands: exact lines, source-only search and copy, card focus, toggling and stale removal', async () => {
    await dialogTo(guideFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await openTreeFile('src/auth.controller.ts');
    const headers = page.locator('.code-function-header');
    const buttons = page.locator('.code-function-button');
    const guide = page.getByRole('region', { name: '이 파일 안내', exact: true }).locator('.file-guide');
    if (await guide.evaluate(element => element.open)) await guide.locator(':scope > summary').click();
    assert.equal(await guide.evaluate(element => element.open), false);
    const toggle = page.getByRole('button', { name: '설명 줄', exact: true });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await buttons.first().waitFor();
    const original = await readFile(path.join(guideFixture, 'src/auth.controller.ts'), 'utf8');
    assert.equal(await headers.count(), await page.locator('.symbols__item').count());
    assert.deepEqual(await headers.evaluateAll(elements => elements.map(element => ({
      text: element.nextElementSibling.textContent, band: element.nextElementSibling.classList.contains('cm-function-band--server'),
    }))), [{ text: original.split('\n')[2], band: true }]);
    assert.match(await buttons.first().innerText(), /POST \/auth\/login \(공통 앞 경로 제외\)/);
    assert.equal(await buttons.first().getAttribute('tabindex'), '-1');
    // Inspect the actual CodeMirror document without adding an app test API.
    const content = page.locator('.cm-content');
    assert.equal(await content.evaluate(element => element.cmTile.root.view.state.doc.toString()), original);
    const headerText = await buttons.first().innerText();
    assert.equal(original.includes(headerText), false);
    await content.focus();
    await page.keyboard.press('Meta+f');
    await page.locator('.cm-search input[name="search"]').fill(headerText);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.cm-searchMatch, .cm-searchMatch-selected').count(), 0);
    await page.keyboard.press('Escape');
    // The selected range crosses the widget; Cmd+C must copy only the raw source.
    const copied = await content.evaluate(element => {
      const editor = element.cmTile.root.view;
      const end = editor.state.doc.line(3).to;
      editor.dispatch({ selection: { anchor: 0, head: end } });
      editor.focus();
      return editor.state.doc.sliceString(0, end);
    });
    await app.evaluate(({ clipboard }) => clipboard.writeText('copy has not run'));
    await page.keyboard.press('Meta+c');
    await until(async () => await app.evaluate(({ clipboard }) => clipboard.readText()) === copied);
    assert.equal(copied, original.split('\n').slice(0, 3).join('\n'));
    const visibleCard = id => page.locator('.file-guide [data-symbol-id]').evaluateAll((cards, id) => {
      const card = cards.find(card => card.dataset.symbolId === id);
      if (!card) return false;
      const rect = card.querySelector('.file-guide__function-heading').getBoundingClientRect();
      const panel = card.closest('.file-guide-fold').getBoundingClientRect();
      // Long cards scroll inside the capped guide; their heading must be brought fully into view.
      return rect.height > 0 && rect.top >= panel.top - 1 && rect.bottom <= Math.min(panel.bottom, innerHeight) + 1;
    }, id);
    const id = await buttons.first().getAttribute('data-symbol-id');
    await buttons.first().click();
    await until(async () => await page.locator('.symbols__item[aria-pressed="true"]').innerText() === 'Auth.login');
    assert.equal(await guide.evaluate(element => element.open), true);
    await until(() => visibleCard(id));
    await until(() => buttons.first().isEnabled());
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.code-function-header, .cm-function-band').count(), 0);
    await toggle.click();
    await buttons.first().waitFor();
    assert.equal(await page.locator('.cm-function-band').count(), 1);

    await openTreeFile('src/functions.ts');
    await until(async () => await buttons.count() === 14);
    assert.equal(await headers.count(), 13);
    assert.deepEqual(await headers.last().locator('button').allTextContents(), ['a · 받는 것: 없음', 'b · 받는 것: 없음']);
    const functionsSource = await readFile(path.join(guideFixture, 'src/functions.ts'), 'utf8');
    assert.deepEqual(await headers.evaluateAll(elements => elements.map(element => element.nextElementSibling.textContent)), functionsSource.trimEnd().split('\n'));
    const ninth = buttons.filter({ hasText: /^run8 ·/ });
    const ninthId = await ninth.getAttribute('data-symbol-id');
    assert.equal(await guide.locator('[data-symbol-id]').count(), 8);
    await guide.locator(':scope > summary').click();
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await ninth.click();
    await until(async () => await page.locator('.symbols__item[aria-pressed="true"]').innerText() === 'run8');
    await until(() => visibleCard(ninthId));
    assert.equal(await guide.evaluate(element => element.open), true);
    assert.equal(await guide.locator('[data-symbol-id]').count(), 14);
    assert.equal(await page.locator('aside[aria-label="AI 질문"]').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).isVisible(), true);
    await until(() => ninth.isEnabled());
    await page.getByRole('region', { name: '이 파일 안내', exact: true }).evaluate(element => { element.scrollTop = 0; });
    assert.equal(await visibleCard(ninthId), false);
    await ninth.click();
    await until(() => visibleCard(ninthId));
    await until(() => ninth.isEnabled());
    await page.screenshot({ path: path.join(artifacts, 'function-bands.png') });
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
    await writeFile(path.join(guideFixture, 'src/functions.ts'), functionsSource + '// changed\n');
    await page.getByText('파일이 바뀌어 설명 줄을 숨겼어요. 파일 다시 읽기를 눌러 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.code-function-header, .cm-function-band').count(), 0);
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await buttons.first().waitFor();
    assert.equal(await page.getByText('파일이 바뀌어 설명 줄을 숨겼어요.', { exact: false }).count(), 0);
    assert.equal(await readFile(path.join(guideFixture, 'src/auth.controller.ts'), 'utf8'), original);
  });
  await check('Function bands: busy clicks are blocked and a missing guide still allows function selection', async () => {
    await openTreeFile('src/auth.controller.ts');
    await app.evaluate(({ ipcMain }) => {
      const read = ipcMain._invokeHandlers.get('learning:read');
      const evidence = ipcMain._invokeHandlers.get('learning:evidence');
      globalThis.testBandHandlers = { read, evidence };
      globalThis.testBandClicks = 0;
      ipcMain.removeHandler('learning:read');
      ipcMain.handle('learning:read', async (event, request) => {
        const result = await read(event, request);
        return result.ok ? { ...result, value: { ...result.value, guide: null } } : result;
      });
      ipcMain.removeHandler('learning:evidence');
      ipcMain.handle('learning:evidence', async (event, request) => {
        globalThis.testBandClicks++;
        await new Promise(resolve => { globalThis.testBandRelease = resolve; });
        const result = await evidence(event, request);
        return result.ok ? { ...result, value: { ...result.value, source: { ...result.value.source, guide: null } } } : result;
      });
    });
    try {
      await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
      const button = page.locator('.code-function-button');
      await until(async () => await button.innerText() === 'Auth.login · 받는 것: input: string');
      assert.equal(await page.locator('.file-guide').count(), 0);
      await button.click();
      await until(() => button.isDisabled());
      await button.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      assert.equal(await app.evaluate(() => globalThis.testBandClicks), 1);
      assert.equal(await page.locator('.cm-function-band--plain.cm-line').count(), 1);
      await app.evaluate(() => globalThis.testBandRelease());
      await until(() => button.isEnabled());
      assert.equal(await page.locator('.symbols__item[aria-pressed="true"]').innerText(), 'Auth.login');
      assert.equal(await page.locator('.file-guide').count(), 0);
    } finally {
      await app.evaluate(({ ipcMain }) => {
        globalThis.testBandRelease?.();
        ipcMain.removeHandler('learning:read'); ipcMain.handle('learning:read', globalThis.testBandHandlers.read);
        ipcMain.removeHandler('learning:evidence'); ipcMain.handle('learning:evidence', globalThis.testBandHandlers.evidence);
      });
    }
  });
  await check('File guide: immediate roles, ranges, function selection, collapsed limitations and stale hash rejection', async () => {
    await dialogTo(guideFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await openTreeFile('src/auth.controller.ts');
    const guide = await openFileGuide();
    assert.equal(await page.locator('.center .file-guide').count(), 1);
    assert.equal(await page.locator('.panel .file-guide, .center .file-explanation, .reader__cards').count(), 0);
    assert.deepEqual(await page.locator('.reader').evaluate(reader => [...reader.children].map(child => child.className)), ['reader__head', 'file-guide-fold', 'reader__body']);
    await guide.getByText('NestJS 컨트롤러', { exact: true }).waitFor();
    assert.match(await guide.innerText(), /POST \/auth\/login[\s\S]*앱 공통 앞 경로는 빼고 봤어요/);
    await guide.getByRole('button', { name: '이 함수 고르기', exact: true }).click();
    await openAiSection('질문하기');
    await until(async () => await page.locator('.symbols__item[aria-pressed="true"]').innerText() === 'Auth.login');
    await until(async () => /auth.controller.ts · 3–3행/.test(await page.getByTestId('question-scope').innerText()));
    const scope = await page.getByTestId('question-scope').innerText();
    await guide.getByRole('button', { name: '코드 보기', exact: true }).first().click();
    await until(async () => /auth.controller.ts · 3–3줄/.test(await page.getByTestId('evidence-range').innerText()));
    assert.equal(await page.locator('.symbols__item[aria-pressed="true"]').innerText(), 'Auth.login');
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await guide.getByRole('button', { name: /^근거:/ }).click();
    await until(async () => /auth.controller.ts · 1–1줄/.test(await page.getByTestId('evidence-range').innerText()));
    await guide.getByRole('button', { name: 'auth.service.ts 열기', exact: true }).click();
    await page.getByRole('heading', { name: 'src/auth.service.ts', exact: true }).waitFor();
    await openTreeFile('src/auth.controller.ts');
    // The source can disagree with an old guide before a filesystem watch event arrives.
    await app.evaluate(({ ipcMain }) => {
      const read = ipcMain._invokeHandlers.get('learning:read');
      ipcMain.removeHandler('learning:read');
      ipcMain.handle('learning:read', async (event, request) => {
        const result = await read(event, request);
        ipcMain.removeHandler('learning:read'); ipcMain.handle('learning:read', read);
        return result.ok ? { ...result, value: { ...result.value, hash: 'f'.repeat(64) } } : result;
      });
    });
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await guide.getByRole('button', { name: '코드 보기', exact: true }).first().click();
    await page.getByText('안내를 만든 뒤 이 파일이 바뀌어 강조하지 않았어요. 파일을 다시 읽고 확인해 주세요.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await guide.getByRole('button', { name: /^근거:/ }).click();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await openTreeFile('src/broken.ts');
    await guide.getByText('구문 오류가 있어 일부 코드는 나누지 않았어요', { exact: true }).waitFor();
    await openTreeFile('src/many.ts');
    await guide.getByText('덩어리 3개는 설명하지 않았어요', { exact: true }).waitFor();
    assert.equal(await guide.getByRole('button', { name: '코드 보기', exact: true }).count(), 0);
    await guide.getByText('그 밖의 코드 80개', { exact: true }).click();
    assert.equal(await guide.getByRole('button', { name: '코드 보기', exact: true }).count(), 8);
    await guide.getByRole('button', { name: '더 보기', exact: true }).click();
    assert.equal(await guide.getByRole('button', { name: '코드 보기', exact: true }).count(), 80);
    await guide.getByRole('button', { name: '접기', exact: true }).click();
    assert.equal(await guide.getByText('덩어리 3개는 설명하지 않았어요', { exact: true }).isVisible(), true);
    await guide.locator(':scope > summary').click();
    assert.equal(await guide.getByRole('button', { name: '코드 보기', exact: true }).first().isVisible(), false);
    await openTreeFile('README.md');
    await page.getByRole('heading', { name: 'README.md', exact: true }).waitFor();
    assert.equal(await guide.count(), 0);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await openTreeFile('src/auth.controller.ts');
    assert.equal(await guide.evaluate(element => element.open), false);
    await openFileGuide();
    await guide.getByText('NestJS 컨트롤러', { exact: true }).waitFor();
  });
  await check('File explanation (fake AI): consent, selected mode, early result, independent code ranges and direct function summaries', async () => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('learning:connections');
      ipcMain.handle('learning:connections', () => ({ ok: true, value: { checkedAt: new Date().toISOString(), providers: [],
        modes: ['codex', 'antigravity', 'local-worker'].map(mode => ({ mode, ready: true, reason: '테스트 전용 가짜 실행기' })) } }));
      ipcMain.removeHandler('learning:file-explanation');
      globalThis.testFileExplanationCalls = [];
      ipcMain.handle('learning:file-explanation', async (event, request) => {
        if (globalThis.testFileExplanationFail) return { ok: false, code: 'AI_FAILED', message: '가짜 파일 설명 실패' };
        const { randomUUID } = process.getBuiltinModule('node:crypto');
        const read = ipcMain._invokeHandlers.get('learning:read');
        const opened = await read(event, { projectId: request.projectId, fileId: request.fileId });
        if (!opened.ok) return opened;
        const source = opened.value;
        const jobId = randomUUID();
        let startUtf16 = 0;
        const chunks = source.text.trimEnd().split('\n').map((line, index) => {
          const range = { fileId: source.fileId, fileHash: source.hash, startUtf16, endUtf16: startUtf16 + line.length, startLine: index + 1, endLine: index + 1 };
          startUtf16 += line.length + 1;
          const fn = source.analysis.symbols.find(symbol => symbol.name === 'run' && symbol.evidence.startLine === index + 1);
          return { id: randomUUID(), kind: fn ? 'function' : 'variable', name: fn ? 'run' : line.match(/const (\w+)/)[1], range,
            functionRange: fn ? { startUtf16: fn.evidence.startUtf16, endUtf16: fn.evidence.endUtf16 } : null };
        });
        const result = { jobId, projectId: request.projectId, relativePath: source.relativePath, mode: request.mode,
          range: { fileId: source.fileId, fileHash: source.hash, startUtf16: 0, endUtf16: source.text.length, startLine: 1, endLine: chunks.length }, chunks,
          explanation: { summary: `${source.relativePath} 파일 설명`, chunks: chunks.filter((_, index) => index !== 2).map(chunk => ({ chunkId: chunk.id, summary: `${chunk.name} 덩어리 설명` })), unknowns: ['실행 결과는 확인하지 않았어요.'] },
          limitations: [], review: request.mode === 'local-worker' ? 'AI 검토됨' : 'AI 대조 없음',
          models: [{ stage: 'explaining', provider: request.mode === 'codex' ? 'codex' : 'antigravity', requestedModel: null, reportedModel: 'test-model' }] };
        globalThis.testFileExplanationCalls.push(request);
        const send = () => event.sender.send('learning:ai-event', { kind: 'file-explanation-completed', jobId, projectId: request.projectId, result });
        if (globalThis.testFileExplanationHold) globalThis.testFileExplanationLate = send;
        else { send(); await new Promise(resolve => setTimeout(resolve, 100)); }
        return { ok: true, value: { jobId } };
      });
      globalThis.testFakeAiBehavior = 'early';
    });
    await dialogTo(fileExplanationFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '파일 설명 프로젝트', exact: true }).waitFor();
    await openTreeFile('README.md');
    assert.equal(await page.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'chunks.ts', exact: true }).click();
    const card = page.locator('.panel').getByRole('region', { name: '이 파일 설명', exact: true });
    const disclosure = page.locator('.panel > details').filter({ has: page.getByText('AI로 이 파일 설명 만들기', { exact: true }) });
    assert.equal(await disclosure.evaluate(element => element.open), false);
    await disclosure.locator(':scope > summary').click();
    assert.equal(await card.getByRole('checkbox').count(), 0);
    assert.equal(await app.evaluate(() => globalThis.testFileExplanationCalls.length), 0);
    await page.getByRole('button', { name: 'run', exact: true }).click();
    await openAiSection('질문하기');
    const panel = page.locator('.ai-panel');
    await openAiSection('설정');
    for (const [mode, recipient] of [['local-worker', 'Gemini와 Codex'], ['antigravity', 'Gemini(Antigravity)'], ['claude-code', 'Claude Code']]) {
      await panel.getByRole('combobox', { name: 'AI 사용 방식' }).selectOption(mode);
      await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
      await checkConsentDisclosure(card, `이 파일의 경로와 원문(비밀값처럼 보이는 형태는 가림)·덩어리 목록(ID·종류·이름·행 범위)을 ${recipient}에 보내는 데 동의합니다. 다른 파일은 보내지 않습니다. 모든 비밀값을 찾는다고 보장하지는 않습니다.`);
      assert.equal(await card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true }).isDisabled(), true);
      if (mode === 'claude-code') assert.equal(await card.getByRole('checkbox').isDisabled(), true);
    }
    await panel.getByRole('combobox', { name: 'AI 사용 방식' }).selectOption('codex');
    await panel.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => (await page.getByTestId('ai-readiness').innerText()).includes('테스트 전용'));
    await panel.getByRole('textbox').fill('파일 설명을 열어도 남을 질문');
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await page.getByText('가짜 설명: 파일 설명을 열어도 남을 질문', { exact: true }).waitFor();
    const scope = await page.getByTestId('question-scope').innerText();
    const guide = await openFileGuide();
    const selected = await page.locator('.symbols__item[aria-pressed="true"]').innerText();
    await app.evaluate(({ ipcMain }) => {
      const read = ipcMain._invokeHandlers.get('learning:read');
      globalThis.testGuideReadCount = 0;
      globalThis.testGuideRestoreRead = () => { ipcMain.removeHandler('learning:read'); ipcMain.handle('learning:read', read); };
      ipcMain.removeHandler('learning:read');
      ipcMain.handle('learning:read', (event, request) => { globalThis.testGuideReadCount++; return read(event, request); });
    });
    for (const running of [false, true]) {
      if (running) {
        await app.evaluate(() => { globalThis.testFakeAiBehavior = 'hold'; globalThis.testFakeAiLate = null; });
        await panel.getByRole('textbox').fill('안내를 보는 동안 진행 중인 질문');
        await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
        await until(() => app.evaluate(() => typeof globalThis.testFakeAiLate === 'function'));
      }
      const draft = await panel.getByRole('textbox').inputValue();
      const reads = await app.evaluate(() => globalThis.testGuideReadCount);
      const answers = await page.getByRole('region', { name: 'AI 설명' }).allInnerTexts();
      const cancelled = await app.evaluate(() => globalThis.testFakeAiCancelled.length);
      const otherCode = guide.locator('details').filter({ has: page.getByText('그 밖의 코드 79개', { exact: true }) });
      if (!await otherCode.evaluate(element => element.open)) await otherCode.locator('summary').click();
      await otherCode.getByRole('button', { name: '코드 보기', exact: true }).first().click();
      await until(async () => /chunks.ts · 2–2줄/.test(await page.getByTestId('evidence-range').innerText()));
      for (const basis of [false, true]) {
        if (basis) await guide.getByRole('button', { name: /^근거:/ }).click();
        assert.equal(await page.locator('.symbols__item[aria-pressed="true"]').innerText(), selected);
        assert.equal(await page.getByTestId('question-scope').innerText(), scope);
        assert.equal(await panel.getByRole('textbox').inputValue(), draft);
        assert.deepEqual(await page.getByRole('region', { name: 'AI 설명' }).allInnerTexts(), answers);
        assert.equal(await app.evaluate(() => globalThis.testGuideReadCount), reads);
        assert.equal(await app.evaluate(() => globalThis.testFakeAiCancelled.length), cancelled);
        if (running) assert.equal(await panel.getByRole('button', { name: 'AI 작업 취소', exact: true }).isVisible(), true);
      }
      if (running) {
        await app.evaluate(() => { globalThis.testFakeAiLate(); globalThis.testFakeAiBehavior = 'early'; });
        await page.getByText('가짜 설명: 안내를 보는 동안 진행 중인 질문', { exact: true }).waitFor();
      }
    }
    await app.evaluate(() => globalThis.testGuideRestoreRead());
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    const create = card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true });
    assert.equal(await create.isDisabled(), true);
    assert.match(await card.innerText(), /Codex 단독/);
    await checkConsentDisclosure(card, '이 파일의 경로와 원문(비밀값처럼 보이는 형태는 가림)·덩어리 목록(ID·종류·이름·행 범위)을 Codex에 보내는 데 동의합니다. 다른 파일은 보내지 않습니다. 모든 비밀값을 찾는다고 보장하지는 않습니다.');
    assert.equal(await create.isDisabled(), true);
    await card.getByRole('checkbox').check();
    await app.evaluate(() => { globalThis.testFileExplanationFail = true; });
    await create.click();
    await card.getByText('가짜 파일 설명 실패', { exact: true }).waitFor();
    assert.equal(await disclosure.evaluate(element => element.open), true);
    assert.equal(await card.getByTestId('file-summary').count(), 0);
    await disclosure.locator(':scope > summary').click();
    assert.equal(await card.getByText('가짜 파일 설명 실패', { exact: true }).isVisible(), true);
    await app.evaluate(() => { globalThis.testFileExplanationFail = false; });
    await card.getByRole('checkbox').check();
    await create.click();
    await card.getByTestId('file-summary').waitFor();
    const runCard = guide.locator('.file-guide__functions > li').filter({ has: page.getByText('run', { exact: true }) });
    await runCard.getByRole('heading', { name: 'AI 요약', exact: true }).waitFor();
    await runCard.getByText('AI 해석', { exact: true }).waitFor();
    assert.match(await runCard.innerText(), /run 덩어리 설명/);
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    assert.equal(await card.getByRole('checkbox').isChecked(), false);
    assert.equal(await card.locator('.consent-details').evaluate(element => element.open), false);
    assert.equal(await create.isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: '코드 보기', exact: true }).count(), 6);
    await card.getByText('설명 없음', { exact: true }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.testFileExplanationCalls.at(-1).mode), 'codex');
    assert.ok(await page.locator('.code-step-marker').count() > 0);
    await card.getByRole('button', { name: '코드 보기', exact: true }).first().click();
    await until(async () => /chunks.ts · 1–1줄/.test(await page.getByTestId('evidence-range').innerText()));
    assert.equal(await page.locator('.symbols__item[aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('.code-step-marker').count(), 0);
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    assert.equal(await page.getByText('가짜 설명: 파일 설명을 열어도 남을 질문', { exact: true }).count(), 1);
    await card.getByRole('button', { name: '파일 전체 근거', exact: true }).click();
    await until(async () => /chunks.ts · 1–80줄/.test(await page.getByTestId('evidence-range').innerText()));
    assert.equal(await page.getByTestId('question-scope').innerText(), scope);
    await page.getByRole('button', { name: 'run', exact: true }).click();
    await page.getByTestId('function-chunk-summary').getByText('run 덩어리 설명', { exact: true }).waitFor();
    await page.getByRole('button', { name: '이 함수 흐름으로 보기', exact: true }).click();
    await page.getByTestId('function-chunk-summary').getByText('run 덩어리 설명', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-guide').count(), 0);
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await page.getByRole('button', { name: 'map에 넘긴 함수 (1행)', exact: true }).click();
    await page.getByTestId('function-chunk-summary').getByText('이 함수는 따로 설명한 덩어리가 없어요', { exact: true }).waitFor();
  });
  await check('File explanation without a result stays open during progress and after cancellation', async () => {
    await page.getByRole('button', { name: 'other0.ts', exact: true }).click();
    // The panel keeps the previous file's card until the new file is read, so wait for the new one.
    await until(async () => (await page.getByRole('navigation', { name: '현재 학습 위치', exact: true }).innerText()).includes('other0.ts'));
    const card = page.locator('.panel').getByRole('region', { name: '이 파일 설명', exact: true });
    const disclosure = page.locator('.panel > details');
    assert.equal(await disclosure.evaluate(element => element.open), false);
    await disclosure.locator(':scope > summary').click();
    await app.evaluate(() => { globalThis.testFileExplanationHold = true; globalThis.testFileExplanationLate = null; });
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true }).click();
    await until(() => app.evaluate(() => typeof globalThis.testFileExplanationLate === 'function'));
    await page.getByRole('button', { name: 'chunks.ts', exact: true }).click();
    await page.getByRole('button', { name: 'other0.ts', exact: true }).click();
    await card.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
    assert.equal(await disclosure.evaluate(element => element.open), true);
    assert.equal(await card.getByTestId('file-summary').count(), 0);
    await disclosure.locator(':scope > summary').click();
    assert.equal(await card.getByRole('button', { name: 'AI 작업 취소', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await page.locator('.topbar').getByText('파일 설명 진행 중', { exact: false }).waitFor();
    await page.getByRole('button', { name: '파일 설명 작업 취소', exact: true }).click();
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
    await card.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'chunks.ts', exact: true }).click();
    await page.getByRole('button', { name: 'other0.ts', exact: true }).click();
    await card.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    assert.equal(await disclosure.evaluate(element => element.open), true);
    await app.evaluate(() => { globalThis.testFileExplanationLate(); globalThis.testFileExplanationHold = false; });
    await page.getByRole('button', { name: 'chunks.ts', exact: true }).click();
  });
  await check('File explanation (fake AI): 80 ranges survive other reads, cancellation, stale files and project reopening', async () => {
    const card = page.locator('.panel').getByRole('region', { name: '이 파일 설명', exact: true });
    for (let index = 0; index < 6; index++) {
      await page.getByRole('button', { name: `other${index}.ts`, exact: true }).click();
      await page.getByRole('heading', { name: `other${index}.ts`, exact: true }).waitFor();
    }
    await page.getByText('AI로 이 파일 설명 만들기', { exact: true }).click();
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true }).click();
    await card.getByTestId('file-summary').getByText('other5.ts 파일 설명', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'chunks.ts', exact: true }).click();
    await card.getByTestId('file-summary').getByText('chunks.ts 파일 설명', { exact: true }).waitFor();
    assert.equal(await card.locator('..').evaluate(element => element.open), true);
    await card.getByRole('button', { name: '코드 보기', exact: true }).first().click();
    await until(async () => /chunks.ts · 1–1줄/.test(await page.getByTestId('evidence-range').innerText()));
    await card.getByRole('button', { name: '더 보기', exact: true }).click();
    assert.equal(await card.getByRole('button', { name: '코드 보기', exact: true }).count(), 80);
    await card.getByRole('button', { name: '코드 보기', exact: true }).last().click();
    await until(async () => /chunks.ts · 80–80줄/.test(await page.getByTestId('evidence-range').innerText()));
    // A held result cannot overwrite the card after cancellation.
    await app.evaluate(() => { globalThis.testFileExplanationHold = true; });
    await card.getByRole('button', { name: '이 파일 설명 만들기', exact: true }).click();
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: '동의하고 파일 설명 만들기', exact: true }).click();
    await card.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
    assert.equal(await page.locator('.ai-panel').getByRole('combobox', { name: 'AI 사용 방식' }).isDisabled(), true);
    await until(() => app.evaluate(() => typeof globalThis.testFileExplanationLate === 'function'));
    await page.getByRole('button', { name: 'AI 칸 접기', exact: true }).click();
    await page.locator('.topbar').getByText('파일 설명 진행 중', { exact: false }).waitFor();
    await page.getByRole('button', { name: '파일 설명 작업 취소', exact: true }).click();
    await page.getByRole('button', { name: 'AI 칸 펼치기', exact: true }).click();
    await card.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.testFileExplanationLate(); globalThis.testFileExplanationHold = false; });
    await card.getByText('AI 작업을 취소했습니다.', { exact: true }).waitFor();
    // A range must check the hash even before a watch notice arrives.
    await app.evaluate(({ ipcMain }) => {
      const read = ipcMain._invokeHandlers.get('learning:read');
      ipcMain.removeHandler('learning:read');
      ipcMain.handle('learning:read', async (event, request) => {
        const result = await read(event, request);
        ipcMain.removeHandler('learning:read'); ipcMain.handle('learning:read', read);
        return result.ok ? { ...result, value: { ...result.value, hash: 'f'.repeat(64) } } : result;
      });
    });
    await card.getByRole('button', { name: '코드 보기', exact: true }).first().click();
    await page.getByText('설명을 만든 뒤 이 파일이 바뀌어 강조하지 않았어요', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await page.getByRole('button', { name: '파일 다시 읽기', exact: true }).click();
    await until(async () => await card.getByRole('button', { name: '파일 전체 근거', exact: true }).isEnabled());
    await writeFile(path.join(fileExplanationFixture, 'chunks.ts'), fileExplanationSource + '// changed\n');
    await card.getByText('다시 확인 필요:', { exact: false }).waitFor();
    await page.locator('.file-guide').getByText('파일이 바뀌어 AI 요약을 숨겼어요. 다시 만들어 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-guide').getByRole('heading', { name: 'AI 요약', exact: true }).count(), 0);
    assert.equal(await page.locator('.file-guide').getByText('AI 해석', { exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.file-guide').innerText(), /run 덩어리 설명/);
    // The map buttons do not depend on the open file, so a change notice leaves them usable (plan E).
    const guideButtons = page.locator('.file-guide').getByRole('button')
      .filter({ hasNot: page.locator('xpath=self::*[ancestor::section[@aria-label="이 파일을 가져다 쓰는 파일"]]') });
    assert.ok(await guideButtons.count() > 0);
    for (const button of await guideButtons.all()) assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('.file-guide').getByRole('button', { name: '지도 만들어 찾기', exact: true }).isDisabled(), false);
    assert.equal(await card.getByRole('button', { name: '파일 전체 근거', exact: true }).isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: '코드 보기', exact: true }).first().isDisabled(), true);
    assert.equal(await page.getByTestId('evidence-range').count(), 0);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await openTreeFile('chunks.ts');
    assert.equal(await card.getByTestId('file-summary').count(), 0);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
  });
  await check('Feature guide (fake AI): consent, grouped routes, route-specific stories, refresh and late result rejection', async () => {
    // Real route and story analysis, with only the AI result replaced. No AI CLI is started.
    await writeFile(path.join(featureFlowFixture, 'api/controller.ts'), featureFlowFiles['api/controller.ts'].replace(
      "@Delete(':id')", "@Get(':id') get(id) { return id; } @Delete(':id')"));
    await app.evaluate(({ ipcMain }) => {
      const routes = ipcMain._invokeHandlers.get('learning:routes');
      ipcMain.removeHandler('learning:routes');
      ipcMain.handle('learning:routes', async (event, request) => {
        const result = await routes(event, request);
        if (result.ok) globalThis.testGuideRoutes = result.value;
        return result;
      });
      ipcMain.removeHandler('learning:feature-guide');
      globalThis.testGuideCalls = [];
      ipcMain.handle('learning:feature-guide', async (event, request) => {
        const { randomUUID } = process.getBuiltinModule('node:crypto');
        const jobId = randomUUID();
        const routes = globalThis.testGuideRoutes;
        const indices = routes.routes.map((_, index) => index);
        const result = { jobId, projectId: request.projectId, routesId: request.routesId, mode: request.mode,
          guide: { summary: '반려견의 정보를 관리하는 프로젝트예요.', groups: [{ name: '반려견 관리', about: '반려견을 살펴보고 지워요.',
            features: [{ name: '반려견 살펴보기와 삭제', about: '반려견 정보를 조회하거나 삭제해요.', routes: indices }] }], unknowns: ['실제 실행은 확인하지 않았어요.'] },
          limitations: [], review: 'AI 검토됨', models: [{ stage: 'explaining', provider: 'antigravity', requestedModel: 'gemini-3.8-flash-high', reportedModel: 'test-model' }] };
        globalThis.testGuideCalls.push(request);
        const send = () => event.sender.send('learning:ai-event', { kind: 'feature-guide-completed', jobId, projectId: request.projectId, result });
        if (globalThis.testGuideHold) globalThis.testGuideLate = send;
        else { send(); await new Promise(resolve => setTimeout(resolve, 100)); }
        return { ok: true, value: { jobId } };
      });
    });
    await dialogTo(featureFlowFixture);
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: '기능 흐름 프로젝트', exact: true }).waitFor();
    await page.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
    const overview = page.getByRole('region', { name: '큰 그림', exact: true });
    await openServerFeatures();
    const list = page.getByRole('region', { name: '기능 목록', exact: true });
    const aiFeature = list.getByRole('listitem').filter({ hasText: '반려견 정보를 조회하거나 삭제해요.' });
    await overview.getByText('기능 2개', { exact: true }).waitFor();
    await list.getByRole('button', { name: 'AI로 기능 정리하기', exact: true }).click();
    await list.getByRole('button', { name: '로컬 AI 설치 확인', exact: true }).click();
    await until(async () => await list.getByRole('checkbox').isEnabled());
    await checkConsentDisclosure(list, '프로젝트 이름, 앱이 찾은 서버 주소·요청·화면 목록(파일 경로와 함수 이름 포함)을 Gemini와 Codex에 보내는 데 동의합니다. 코드 원문은 보내지 않습니다. 비밀값처럼 보이는 부분은 가리지만 모두 찾는다고 보장하지 않습니다.');
    const send = list.getByRole('button', { name: '동의하고 정리하기', exact: true });
    assert.equal(await send.isDisabled(), true);
    assert.equal(await app.evaluate(() => globalThis.testGuideCalls.length), 0);
    await app.evaluate(() => { globalThis.testGuideHold = true; });
    await list.getByRole('checkbox').check(); await send.click();
    await list.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
    await page.getByRole('button', { name: '코드 읽기', exact: true }).click();
    await until(async () => await app.evaluate(() => typeof globalThis.testGuideLate === 'function'));
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await openServerFeatures();
    await list.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
    await app.evaluate(() => { globalThis.testGuideLate(); globalThis.testGuideHold = false; });
    await overview.getByText('반려견의 정보를 관리하는 프로젝트예요.', { exact: false }).waitFor();
    await list.getByRole('heading', { name: '반려견 관리', exact: true }).waitFor();
    await list.getByText('반려견 정보를 조회하거나 삭제해요.', { exact: true }).waitFor();
    const calls = await app.evaluate(() => globalThis.testGuideCalls);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['consent', 'mode', 'projectId', 'routesId']);
    assert.equal(calls[0].consent, true);
    const index = page.getByRole('region', { name: '기능 목차', exact: true });
    assert.ok((await index.locator('li > b').allTextContents()).includes('‘삭제’ 버튼 · 지우기'));
    await aiFeature.getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    const story = page.getByRole('region', { name: '기능 따라가기', exact: true });
    const evidenceStrip = story.getByRole('region', { name: '선택한 연결의 근거', exact: true });
    const diagram = story.getByTestId('feature-flow-canvas');
    await until(async () => await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).isEnabled());
    await diagram.getByRole('group', { name: 'api/service.ts · DogsService.remove', exact: true }).click();
    await evidenceStrip.getByTestId('flow-snippet').waitFor();
    await until(async () => await evidenceStrip.getByRole('button', { name: '코드 보기', exact: true }).isEnabled());
    await story.getByRole('heading', { name: '반려견 살펴보기와 삭제', exact: true, level: 3 }).waitFor();
    assert.equal(await story.locator(':scope > .map-actions > h3').innerText(), '반려견 살펴보기와 삭제');
    // DELETE has a sure frontend link, so it is preferred over GET regardless of the AI's order.
    await story.getByRole('button', { name: '4단계 서버 받는 곳', exact: true }).click();
    await story.getByText('DogsController.remove가 요청을 받아요 → DogsService.remove에 넘겨요', { exact: true }).waitFor();
    await story.getByRole('button', { name: '7단계 화면 결과', exact: true }).click();
    const summary = story.getByRole('region', { name: '한 문장으로 정리', exact: true });
    await summary.getByRole('textbox', { name: '받는 것', exact: true }).fill('삭제할 번호');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await openServerFeatures();
    await list.getByRole('button', { name: 'GET /api/dogs/:id', exact: true }).click();
    await story.getByText('DogsController.get가 요청을 받아요', { exact: true }).waitFor();
    await evidenceStrip.getByText('지도에서 상자를 누르면 그 코드가 여기 보여요.', { exact: true }).waitFor();
    assert.equal(await evidenceStrip.getByTestId('flow-snippet').count(), 0);
    await until(async () => await story.getByRole('button', { name: '다른 기능 고르기', exact: true }).isEnabled());
    await diagram.getByRole('group', { name: 'api/controller.ts · DogsController.get', exact: true }).click();
    await evidenceStrip.getByTestId('flow-snippet').waitFor();
    await until(async () => await evidenceStrip.getByRole('button', { name: '코드 보기', exact: true }).isEnabled());

    for (const label of ['받는 것', '확인하는 것', '돌려주는 것']) {
      assert.equal(await summary.getByRole('textbox', { name: label, exact: true }).inputValue(), '');
    }
    await summary.getByRole('textbox', { name: '받는 것', exact: true }).fill('조회할 번호');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await openServerFeatures();
    await list.getByRole('button', { name: 'DELETE /api/dogs/:id', exact: true }).click();
    await evidenceStrip.getByText('지도에서 상자를 누르면 그 코드가 여기 보여요.', { exact: true }).waitFor();
    assert.equal(await evidenceStrip.getByTestId('flow-snippet').count(), 0);
    await story.getByRole('button', { name: '4단계 서버 받는 곳', exact: true }).click();
    await story.getByText('DogsController.remove가 요청을 받아요 → DogsService.remove에 넘겨요', { exact: true }).waitFor();
    await story.getByRole('button', { name: '7단계 화면 결과', exact: true }).click();
    assert.equal(await summary.getByRole('textbox', { name: '받는 것', exact: true }).inputValue(), '삭제할 번호');
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).click();
    await openServerFeatures();
    await page.getByRole('textbox', { name: '기능 검색' }).fill('DogsController.get');
    await aiFeature.getByRole('button', { name: '이 기능 따라가기', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '기능 검색' }).fill('');
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await page.getByRole('button', { name: '다시 찾기', exact: true }).click();
    await openServerFeatures();
    await list.getByText('지우기 · /api/dogs/:id', { exact: true }).waitFor();
    assert.equal(await list.getByRole('heading', { name: '반려견 관리', exact: true }).count(), 0);
    await app.evaluate(() => { globalThis.testGuideHold = true; });
    await list.getByRole('button', { name: 'AI로 기능 정리하기', exact: true }).click();
    await list.getByRole('checkbox').check(); await send.click();
    await list.getByRole('button', { name: 'AI 작업 취소', exact: true }).waitFor();
    await until(async () => await app.evaluate(() => typeof globalThis.testGuideLate === 'function'));
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await page.getByRole('button', { name: '다시 찾기', exact: true }).click();
    await openServerFeatures();
    await list.getByText('지우기 · /api/dogs/:id', { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.testGuideLate(); globalThis.testGuideHold = false; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await list.getByRole('heading', { name: '반려견 관리', exact: true }).count(), 0);
    assert.equal(await overview.getByText('반려견의 정보를 관리하는 프로젝트예요.', { exact: false }).count(), 0);
    await list.getByRole('button', { name: 'AI로 기능 정리하기', exact: true }).click();
    await list.getByRole('checkbox').check(); await send.click();
    await list.getByRole('heading', { name: '반려견 관리', exact: true }).waitFor();
    await writeFile(path.join(featureFlowFixture, 'api/controller.ts'), featureFlowFiles['api/controller.ts'] + '\n// changed\n');
    await openServerFeatures();
    await list.getByText('지우기 · /api/dogs/:id', { exact: true }).waitFor();
    assert.equal(await list.getByRole('heading', { name: '반려견 관리', exact: true }).count(), 0);
    assert.equal(await list.getByRole('button', { name: 'AI로 기능 정리하기', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '프로젝트 닫기', exact: true }).click();
    await page.getByRole('heading', { name: '프로젝트를 열어 코드를 읽어 보세요', exact: true }).waitFor();
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
    await page.getByRole('button', { name: '프로젝트 닫기' }).click();
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
