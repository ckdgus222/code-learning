import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { buildFeatureFlow, buildFeatureFlows } from '../src/core/analysis/feature-flow';
import { findFunctionCalls, type CallsCache } from '../src/core/analysis/calls';
import { storyOf } from '../src/core/analysis/flow-story';
import { MAP_LIMITS } from '../src/core/analysis/project-map';

let root: string;
beforeEach(async () => { root = await mkdtemp('/private/tmp/learning-feature-flow-'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(name: string, text: string) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}
async function fixture() {
  await put('web/next.config.ts', 'export default {}');
  await put('web/app/dogs/page.tsx', "import {DogList} from '../../components/DogList'; export default function DogsPage() { return <DogList />; }");
  await put('web/components/DogList.tsx', `import {useDeleteDog} from '../lib/dogs';
export function DogList() {
  const remove = useDeleteDog();
  const removeDog = (dog) => remove.mutate(dog.id);
  return query.data.map(dog => <button onClick={() => removeDog(dog)}>삭제</button>);
}`);
  await put('web/lib/dogs.ts', "import {useMutation} from '@tanstack/react-query'; import {apiRequest} from './auth'; export function useDeleteDog() { return useMutation({mutationFn: (id) => apiRequest(`/api/dogs/${id}`, {method:'DELETE'})}); }");
  await put('web/lib/auth.ts', `export function apiRequest(path, init) { return apiFetch(path, init); }
function apiFetch(path, init = {}) { const headers = new Headers(init.headers); fetch(path, {...init, headers}); return fetch(path, {...init, headers}); }`);
  await put('api/setup.ts', "app.setGlobalPrefix('api');");
  await put('api/dogs.controller.ts', "import {DogsService} from './dogs.service'; @Controller('dogs') export class DogsController { constructor(private dogs: DogsService) {} @Delete(':id') remove(id) { return this.dogs.remove(id); } }");
  await put('api/dogs.service.ts', `export class DogsService { remove(id) { return this.prisma.$transaction(async tx => {
    await tx.dog.findFirst(id); await tx.dog.count(); return tx.dog.delete(id);
  }); } }`);
}
async function analyze() {
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  const flow = await buildFeatureFlow(root, project.id, project.files, routes, 0);
  return { project, routes, flow };
}
it('connects a Next screen, nested event, hook result, request, controller and service', async () => {
  await fixture();
  const { routes, flow } = await analyze();
  expect(routes.routes[0].path).toBe('/api/dogs/:id');
  expect(routes.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
  const node = (name: string) => flow.nodes.find(node => node.name === name)!;
  expect(flow.nodes.map(node => node.name)).toEqual(expect.arrayContaining(['DogsPage', 'DogList', 'onClick 함수 (5행)', 'removeDog', 'useDeleteDog', 'mutationFn', 'DogsController.remove', 'DogsService.remove']));
  expect(node('DogsPage').screen).toBe('/dogs');
  expect(node('onClick 함수 (5행)').event).toBe('onClick');
  const kinds = flow.edges.map(edge => edge.kind);
  expect(kinds).toEqual(expect.arrayContaining(['placed', 'inside', 'event', 'hook', 'route', 'typed', 'calls']));
  expect(flow.edges.filter(edge => !edge.sure).map(edge => edge.kind)).toEqual(['hook']);
  expect(node('DogsService.remove').outside).toEqual(expect.arrayContaining([
    expect.stringContaining('this.prisma.$transaction'), expect.stringContaining('안쪽 함수에서 tx.dog.findFirst'), expect.stringContaining('안쪽 함수에서 tx.dog.delete'),
  ]));
  for (const edge of flow.edges) {
    const from = flow.nodes.find(node => node.id === edge.from)!;
    const to = flow.nodes.find(node => node.id === edge.to)!;
    if (from.side === 'front') expect(from.depth, `${from.name} → ${to.name}`).toBeGreaterThan(to.depth);
  }
  const reachable = new Set([node('DogsPage').id]);
  for (let i = 0; i < flow.nodes.length; i++) for (const edge of flow.edges) if (reachable.has(edge.from)) reachable.add(edge.to);
  expect(reachable.has(node('DogsService.remove').id)).toBe(true);
  expect(flow.limited).toBe(true);
  expect(flow.notes).toContain('여러 곳을 부르는 함수는 확인 창과 응답 뒤 할 일을 찾지 않았어요.');
  const story = storyOf(flow);
  expect(story.map(step => step.kind)).toEqual(['screen', 'front', 'request', 'handler', 'back', 'store']);
  // The click path, not DogList's direct hook call, even though DogList is deeper.
  expect(story[0].text).toBe('화면 /dogs에서 ‘삭제’ 버튼을 누르면 시작해요');
  expect(story[0].nodes.map(node => node.name)).toEqual(expect.arrayContaining(['DogsPage', 'DogList']));
  expect(story[1].text).toBe('removeDog → useDeleteDog → mutationFn 순서로 이어져요');
  expect(story[4].representative.name).toBe('DogsService.remove');
});
it('uses the same calls result with and without a per-job cache', async () => {
  await fixture();
  const { project, routes } = await analyze();
  const cache: CallsCache = { texts: new Map(), parsed: new Map() };
  for (const target of [routes.routes[0].handler, { fileId: routes.requests[0].fileId, fileHash: routes.requests[0].fileHash, ...routes.requests[0].inFunction! }]) {
    const plain = await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS);
    expect(await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, () => false, cache)).toEqual(plain);
  }
});
it('keeps cycles as edges without expanding a function twice', async () => {
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('client.ts', "function a() { b(); fetch('/x'); } function b() { a(); }");
  const { flow } = await analyze();
  expect(flow.nodes.filter(node => node.side === 'front')).toHaveLength(2);
  expect(flow.edges.filter(edge => edge.kind === 'calls')).toHaveLength(3);
  expect(flow.nodes.every(node => Number.isFinite(node.depth))).toBe(true);
});
it('caps requests and frontend nodes across all requests', async () => {
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('client.ts', Array.from({ length: 16 }, (_, i) => `function f${i}() { ${i < 15 ? `f${i + 1}();` : ''} ${i > 9 ? "fetch('/x');" : ''} }`).join('\n'));
  const { flow } = await analyze();
  expect(flow.nodes.filter(node => node.side === 'request')).toHaveLength(5);
  expect(flow.nodes.filter(node => node.side === 'front')).toHaveLength(12);
  expect(flow.nodes.length).toBeLessThanOrEqual(27);
  expect(flow.limited).toBe(true);
});
it('limits backend depth and outside calls and reports omitted calls', async () => {
  await put('server.ts', `function d() { e(); } function e() {} function c() { d(); } function b() { c(); }
@Controller('x') class C { @Get() get() { b(); ${Array.from({ length: 9 }, (_, i) => `external${i}();`).join(' ')} } }`);
  const { flow } = await analyze();
  expect(flow.nodes.filter(node => node.side === 'back').map(node => node.depth)).toEqual([0, 1, 2, 3]);
  expect(flow.nodes[0].outside).toHaveLength(6);
  expect(flow.nodes[0].outsideOmitted).toBe(3);
  expect(flow.limited).toBe(true);
});
it('rejects a changed handler hash and stops cancelled work', async () => {
  await fixture();
  const { project, routes } = await analyze();
  await expect(buildFeatureFlow(root, project.id, project.files, routes, 0, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  await put('api/dogs.controller.ts', 'export class Changed {}');
  await expect(buildFeatureFlow(root, project.id, project.files, routes, 0)).rejects.toMatchObject({ code: 'CHANGED' });
});
it('follows a destructured hook result and a default component import', async () => {
  await fixture();
  await put('web/components/DogList.tsx', `import {useDeleteDog} from '../lib/dogs';
export default function DogList() {
  const { mutate } = useDeleteDog();
  const removeDog = dog => mutate(dog.id);
  return <button onClick={() => removeDog(dog)}>삭제</button>;
}`);
  await put('web/app/dogs/page.tsx', "import List from '../../components/DogList'; export default function DogsPage() { return <List />; }");
  const { flow } = await analyze();
  expect(flow.edges.find(edge => edge.kind === 'hook')).toMatchObject({ sure: false, reasons: ['훅이 돌려준 값 mutate를 써요'] });
  expect(flow.nodes.find(node => node.name === 'DogsPage')?.screen).toBe('/dogs');
});
it('does not link a hook result that is reassigned', async () => {
  await fixture();
  await put('web/components/DogList.tsx', "import {useDeleteDog} from '../lib/dogs'; export function DogList() { let remove = useDeleteDog(); remove = other; const removeDog = dog => remove.mutate(dog.id); return <button onClick={() => removeDog(dog)}>삭제</button>; }");
  expect((await analyze()).flow.edges.some(edge => edge.kind === 'hook')).toBe(false);
});
it('caps backend nodes even with many sibling callees', async () => {
  await put('server.ts', `${Array.from({ length: 12 }, (_, i) => `function child${i}() {}`).join('\n')}
@Controller('x') class C { @Get() get() { ${Array.from({ length: 12 }, (_, i) => `child${i}();`).join(' ')} } }`);
  const { flow } = await analyze();
  expect(flow.nodes.filter(node => node.side === 'back')).toHaveLength(10);
  expect(flow.limited).toBe(true);
});

it('bounds arrows and callers when one function is called thousands of times', async () => {
  await put('api/setup.ts', "app.setGlobalPrefix('api');");
  await put('api/controller.ts', "@Controller('dogs') export class DogsController { @Get() list() {} }");
  await put('web/request.ts', "export function load() { return fetch('/api/dogs'); }");
  await put('web/many.ts', `import {load} from './request';\nexport function Many() {\n${Array.from({ length: 3000 }, () => '  load();').join('\n')}\n}`);
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  const started = performance.now();
  const flow = await buildFeatureFlow(root, project.id, project.files, routes, 0);
  expect(performance.now() - started).toBeLessThan(15000);
  expect(flow.edges.length).toBeLessThanOrEqual(200);
  expect(flow.notes).toContain('함수마다 부르는 곳은 50개까지만 따라가요.');
  expect(flow.nodes.some(node => node.name === 'Many')).toBe(true);
}, 60000);

it('reads only a few callbacks of a backend function and stops when asked', async () => {
  await put('api/setup.ts', "app.setGlobalPrefix('api');");
  await put('api/controller.ts', `@Controller('dogs') export class DogsController { @Get() list() {\n${Array.from({ length: 5000 }, (_, index) => `  run(() => db.q${index}());`).join('\n')}\n} }`);
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  const started = performance.now();
  const flow = await buildFeatureFlow(root, project.id, project.files, routes, 0);
  expect(performance.now() - started).toBeLessThan(15000);
  expect(flow.notes).toContain('안쪽 함수는 함수마다 3개까지만 봐요.');
  let checks = 0;
  await expect(buildFeatureFlow(root, project.id, project.files, routes, 0, MAP_LIMITS, () => ++checks > 3)).rejects.toThrow('취소');
}, 60000);

it('finds written throws, nearest conditions and literal messages only in the body and direct callbacks', async () => {
  await put('server.ts', `@Controller('dogs') class C { @Delete() remove() {
    if (!dog) throw new NotFoundException('반려견을 찾을 수 없어요.');
    if (count <= 1) { throw new errors.ConflictException('최소 한 마리'); }
    else { throw new BadRequestException(\`bad \${count}\`); }
    try { throw new Error('caught here'); } catch (error) { throw new ConflictException(); }
    run(() => { throw new Error('callback'); });
    function unused() { throw new Error('unused'); }
    const unusedArrow = () => { throw new Error('unused arrow'); };
    run(() => { run(() => { throw new Error('too deep'); }); });
    throw error;
  } }`);
  const { flow } = await analyze();
  const node = flow.nodes[0];
  expect(node.stops.map(({ kind, message, condition }) => ({ kind, message, condition }))).toEqual([
    { kind: 'NotFoundException', message: '반려견을 찾을 수 없어요.', condition: '!dog' },
    { kind: 'ConflictException', message: '최소 한 마리', condition: 'count <= 1' },
    { kind: 'BadRequestException', message: null, condition: '아니면: count <= 1' },
    { kind: 'Error', message: 'caught here', condition: null },
    { kind: 'ConflictException', message: null, condition: '오류가 나면' },
    { kind: 'Error', message: 'callback', condition: null },
  ]);
  expect(node.stopsOmitted).toBe(0);
  expect(node.stops.map(stop => stop.site.startLine)).toEqual([2, 3, 4, 5, 5, 6]);
  expect(node.stops[0].site).toMatchObject({ fileId: node.fileId, fileHash: node.fileHash,
    text: "throw new NotFoundException('반려견을 찾을 수 없어요.');" });
});

it('bounds messages, conditions and stops, but reads more than three direct callbacks', async () => {
  const message = '가'.repeat(130);
  const condition = `ready &&\n ${'condition'.repeat(12)}`;
  await put('server.ts', `@Controller('x') class C { @Get() get() {
    if (${condition}) throw new Error('${message}');
    throw new Error('escaped\\nmessage');
    ${Array.from({ length: 6 }, (_, i) => `run(() => { throw new Error('callback ${i}'); });`).join('\n')}
  } }`);
  const node = (await analyze()).flow.nodes[0];
  expect(node.stops).toHaveLength(6);
  expect(node.stopsOmitted).toBe(2);
  expect(node.stops[0].message).toBe(`${message.slice(0, 120)}…`);
  expect(node.stops[0].condition).toBe(`${condition.replace(/\s+/g, ' ').slice(0, 80)}…`);
  expect(node.stops[1].message).toBeNull();
  expect(node.stops[5].message).toBe('callback 3');
});

it('recognizes Prisma-shaped model and raw calls, including a transaction parameter', async () => {
  await put('server.ts', `@Controller('x') class C { @Get() async get() {
    await this.prisma.dog.findFirst();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw\`SELECT id FROM dogs\`;
      await tx.dog.count();
      await tx.dog.delete();
    });
    prisma.user.create();
    this.prisma.dog.upsert();
    prisma.$executeRawUnsafe('SQL');
    this.prisma.$queryRawUnsafe('SQL');
    this.repo.dog.delete();
    tx.dog.delete();
    function unused() { prisma.dog.delete(); }
    run(() => run(() => prisma.dog.delete()));
  } }`);
  const node = (await analyze()).flow.nodes[0];
  expect(node.stores.map(({ model, action }) => [model, action])).toEqual([
    ['dog', 'read'], [null, 'raw'], ['dog', 'count'], ['dog', 'delete'],
    ['user', 'create'], ['dog', 'upsert'], [null, 'raw'], [null, 'raw'],
  ]);
  expect(node.storesOmitted).toBe(0);
  expect(node.stores.map(store => store.site.startLine)).toEqual([2, 4, 5, 6, 8, 9, 10, 11]);
});

it.each([
  'tx = other; tx.dog.delete();',
  'tx.dog.delete(); tx = other;',
  'var tx = other; tx.dog.delete();',
  '{ const tx = other; tx.dog.delete(); }',
  'function tx() {} tx.dog.delete();',
])('does not treat a shadowed or reassigned transaction parameter as Prisma: %s', async body => {
  await put('server.ts', `@Controller('x') class C { @Get() get() {
    this.prisma.$transaction(async tx => { ${body} });
  } }`);
  expect((await analyze()).flow.nodes[0].stores).toEqual([]);
});

it('recognizes a renamed first transaction parameter but rejects other parameters and callback kinds', async () => {
  await put('server.ts', `@Controller('x') class C { @Get() get() {
    this.prisma.$transaction(async (database, tx) => { database.dog.delete(); tx.dog.delete(); });
    run(tx => tx.dog.delete());
    this.prisma.$transaction(({ tx }) => tx.dog.delete());
  } }`);
  expect((await analyze()).flow.nodes[0].stores.map(store => store.site.text)).toEqual(['database.dog.delete()']);
});

it.each([
  ['findUnique', 'read'], ['findUniqueOrThrow', 'read'], ['findFirstOrThrow', 'read'], ['findMany', 'read'],
  ['aggregate', 'read'], ['groupBy', 'read'], ['createMany', 'create'], ['createManyAndReturn', 'create'],
  ['update', 'update'], ['updateMany', 'update'], ['deleteMany', 'delete'],
])('maps Prisma %s to %s', async (op, action) => {
  await put('server.ts', `@Controller('x') class C { @Get() get() { prisma.dog.${op}(); } }`);
  expect((await analyze()).flow.nodes[0].stores).toEqual([expect.objectContaining({ model: 'dog', action })]);
});

it('caps storage calls and keeps front and request nodes empty', async () => {
  await put('server.ts', `@Controller('x') class C { @Get() get() {
    ${Array.from({ length: 10 }, () => 'run(() => prisma.dog.delete());').join('\n')}
  } }`);
  await put('client.ts', "function load() { prisma.user.create(); fetch('/x'); throw new Error('front'); }");
  const { flow } = await analyze();
  expect(flow.nodes[0].stores).toHaveLength(8);
  expect(flow.nodes[0].storesOmitted).toBe(2);
  for (const node of flow.nodes.filter(node => node.side !== 'back')) {
    expect(node).toMatchObject({ stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0 });
  }
});

async function frontFixture(code: string) {
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('client.tsx', code);
  return (await analyze()).flow;
}

it.each([
  ['<button onClick={() => send()}>삭제</button>', 'button', ['삭제']],
  ['<button onClick={() => send()}>{busy ? "삭제 중…" : "삭제"}</button>', 'button', ['삭제 중…', '삭제']],
  ["<button onClick={() => send()}>{kind === 'danger' ? '삭제' : '저장'}</button>", 'button', ['삭제', '저장']],
  ['<button onClick={() => send()}>{busy && "저장 중"}</button>', 'button', ['저장 중']],
  ['<button onClick={() => send()}>{busy ? (other ? "A" : "B") : "C"}</button>', 'button', ['A', 'B', 'C']],
  ['<button aria-label="닫기" onClick={() => send()}><Icon/></button>', 'button', ['닫기']],
  ["<button onClick={() => send()}>{t('x')}</button>", 'button', []],
  ['<form onSubmit={() => send()}>이름 <button>보내기</button></form>', 'form', []],
  ['<input onChange={() => send()} value="x"/>', 'input', ['x']],
  ['<input onChange={() => send()} aria-label="이름" title="설명" value="x"/>', 'input', ['이름']],
  ['<input onChange={() => send()} title="설명" value="x"/>', 'input', ['설명']],
  ['<button onClick={() => send()}>모두 <span>삭제</span></button>', 'button', ['모두 삭제']],
  ['<button onClick={() => send()}>{icon} 저장</button>', 'button', ['저장']],
  ["<button onClick={() => send()}>모두 {busy ? '삭제' : '저장'}</button>", 'button', ['모두']],
])('reads only visible control text: %s', async (jsx, tag, texts) => {
  const flow = await frontFixture(`function send() { return fetch('/x'); } function Page() { return ${jsx}; }`);
  expect(flow.nodes.find(node => node.event)?.control).toEqual({ tag, texts });
});

it('bounds control text and removes duplicate branches', async () => {
  const long = '가'.repeat(35);
  const flow = await frontFixture(`function Page() { return <button onClick={() => fetch('/x')}>{busy ? '${long}' : '${long}'}</button>; }`);
  expect(flow.nodes.find(node => node.event)?.control?.texts).toEqual(['가'.repeat(30) + '…']);
});

it.each(['const handleSubmit = async () => { await send(); };', 'async function handleSubmit() { await send(); }'])('resolves a named JSX handler: %s', async handler => {
  const flow = await frontFixture(`function send() { return fetch('/x'); } function Page() { ${handler} return <form onSubmit={handleSubmit}>이름</form>; }`);
  const submit = flow.nodes.find(node => node.name === 'handleSubmit')!;
  expect(submit).toMatchObject({ event: 'onSubmit', control: { tag: 'form', texts: [] } });
  expect(flow.edges.find(edge => edge.from === submit.id)).toMatchObject({ kind: 'event' });
});

it('does not assign a shadowed handler or an unused event to a control', async () => {
  const flow = await frontFixture(`function send() { return fetch('/x'); } function Page() {
    function handleSubmit() { send(); } function Other(handleSubmit) { return <form onSubmit={handleSubmit}/>; }
    return handleSubmit;
  }`);
  expect(flow.nodes.find(node => node.name === 'handleSubmit')).toMatchObject({ event: null, control: null });
});

it('does not assign a reassigned named handler to an event', async () => {
  const flow = await frontFixture(`function Page() {
    let handleSubmit = () => fetch('/x'); handleSubmit = other;
    return <form onSubmit={handleSubmit}/>;
  }`);
  expect(flow.nodes.find(node => node.name === 'handleSubmit')).toMatchObject({ event: null, control: null });
});

it('does not infer an event from an object property name', async () => {
  const flow = await frontFixture("const handlers = { onClick: () => fetch('/x') };");
  expect(flow.nodes.filter(node => node.side === 'front')).toEqual([expect.objectContaining({ event: null, control: null })]);
});

it.each([
  ["if (!confirm('정말?')) { return; }", '정말?'],
  ['if (!(window.confirm(`${name}를 지울까요?`))) return;', '…를 지울까요?'],
  ['if (!confirm(message)) return;', null],
])('reads a first-statement confirmation: %s', async (guard, message) => {
  const flow = await frontFixture(`function run() { ${guard} fetch('/x'); }`);
  expect(flow.nodes.find(node => node.name === 'run')?.asks).toEqual([expect.objectContaining({ message,
    site: expect.objectContaining({ text: guard }) })]);
});

it.each([
  "if (!confirm('정말?')) return fetch('/x');",
  "fetch('/x'); if (!confirm('정말?')) return;",
  "try { if (!confirm('정말?')) return; fetch('/x'); } finally { clean(); }",
  "const unused = () => { if (!confirm('정말?')) return; }; fetch('/x');",
  "ready(); if (!confirm('정말?')) return; fetch('/x');",
  "if (!confirm('정말?')) { ready(); return; } fetch('/x');",
])('rejects confirmation shapes that cannot stop the whole function: %s', async body => {
  const flow = await frontFixture(`function run() { ${body} }`);
  expect(flow.nodes.find(node => node.name === 'run')?.asks).toEqual([]);
});

it('keeps only the first confirmation and clips its message', async () => {
  const flow = await frontFixture(`function run() { ${Array.from({ length: 4 }, () => `if (!confirm('${'가'.repeat(90)}')) return;`).join(' ')} fetch('/x'); }`);
  expect(flow.nodes.find(node => node.name === 'run')?.asks.map(ask => ask.message)).toEqual(['가'.repeat(80) + '…']);
});

it.each([
  ['export const useAuth = () => ({ login });', 'const { login } = useAuth();', 'login', 'login'],
  ['export function useAuth() { return { user, login }; }', 'const { login } = useAuth();', 'login', 'login'],
  ['export function useAuth() { return { signIn: login }; }', 'const { signIn: enter } = useAuth();', 'enter', 'signIn'],
  ['export function useAuth() { return { login: login }; }', 'const auth = useAuth();', 'auth.login', 'login'],
])('follows returned functions through %s and %s', async (hook, binding, call, property) => {
  await put('web/next.config.ts', 'export default {}');
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('web/lib/auth.ts', "export function login() { return fetch('/x'); } export function direct() { return login(); }");
  await put('web/lib/provider.ts', `import {login} from './auth'; ${hook}`);
  await put('web/app/login/page.tsx', `import {useAuth} from '../../lib/provider'; export default function LoginPage() {
    ${binding} const handleSubmit = async () => { try { await ${call}(); router.push('/'); } catch { setError('bad'); } finally { setPending(false); } };
    return <form onSubmit={handleSubmit}>계정</form>;
  }`);
  const { flow } = await analyze();
  const handler = flow.nodes.find(node => node.name === 'handleSubmit')!;
  expect(flow.edges.find(edge => edge.from === handler?.id && edge.kind === 'hook')).toMatchObject({ sure: false, reasons: [`훅이 돌려준 ${property} 함수를 불러요`] });
  expect(flow.nodes.find(node => node.name === 'LoginPage')?.screen).toBe('/login');
  expect(handler).toMatchObject({ event: 'onSubmit', control: { tag: 'form', texts: [] } });
  expect(handler.after.map(item => [item.when, item.action, item.target])).toEqual([
    ['success', 'navigate', '/'], ['error', 'state', 'error'], ['settled', 'state', 'pending'],
  ]);
  expect(storyOf(flow)[0].text).toBe('화면 /login에서 입력 양식을 보내면 시작해요');
  expect(storyOf(flow).at(-1)?.text).toBe('handleSubmit · 성공하면: 화면 /로 이동하기 · 실패하면: 화면 값 error 바꾸기 · 끝나면: 화면 값 pending 바꾸기');
});

it.each([
  "import {login} from './other'; export function useAuth() { return {login}; }",
  "import {login} from './auth'; export function useAuth() { login = other; return {login}; }",
  "import {login} from './auth'; export function useAuth(login) { return {login}; }",
  "import {login} from './auth'; export function factory() { return {login}; }",
])('does not resolve a different, reassigned, shadowed or non-hook function: %s', async provider => {
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('auth.ts', "export function login() { return fetch('/x'); }");
  await put('other.ts', 'export function login() {}');
  await put('provider.ts', provider);
  await put('page.tsx', "import {useAuth, factory} from './provider'; function Page() { const {login} = useAuth(); const auth = factory(); function submit() { login(); auth.login(); } return <form onSubmit={submit}/>; }");
  expect((await analyze()).flow.edges.filter(edge => edge.kind === 'hook')).toEqual([]);
});

it.each(['let {login} = useAuth(); login = other;', 'let auth = useAuth(); auth = other;'])('rejects reassigned returned bindings: %s', async binding => {
  const flow = await frontFixture(`function login() { return fetch('/x'); } function useAuth() { return {login}; }
    function Page() { ${binding} function submit() { login(); auth.login(); } return <form onSubmit={submit}/>; }`);
  expect(flow.edges.filter(edge => edge.kind === 'hook')).toEqual([]);
});

it('reads only the request-body option object and preserves dog-walk cancel/cache callbacks', async () => {
  const flow = await frontFixture(`function useDeleteDog() { return useMutation({ mutationFn: () => fetch('/x'),
    onSuccess: async () => { await queryClient.cancelQueries({queryKey: key}); queryClient.setQueryData(key, dogs => dogs?.filter(dog => dog.id !== id)); },
    onError: handleError, onSettled: () => { void toast.done(); }
  }); }`);
  expect(flow.nodes.find(node => node.name === 'useDeleteDog')?.after.map(item => [item.when, item.action, item.target])).toEqual([
    ['success', 'cancel', null], ['success', 'cache', null], ['error', 'call', 'handleError'], ['settled', 'notify', null],
  ]);
});

it('does not attach an onSuccess notification to the request sent inside onSuccess', async () => {
  const flow = await frontFixture(`function useSave() { return useMutation({mutationFn: () => fetch('/save'), onSuccess: () => { toast('saved'); return fetch('/x'); }}); }`);
  expect(flow.nodes.flatMap(node => node.after)).toEqual([]);
});

it('ignores unrelated option objects', async () => {
  const flow = await frontFixture(`async function run() { const unrelated = {onSuccess: () => toast('wrong')}; await fetch('/x'); }`);
  expect(flow.nodes.flatMap(node => node.after)).toEqual([]);
});

it('reads mutate options at the hook-result call', async () => {
  const flow = await frontFixture(`function useSave() { return useMutation({mutationFn: () => fetch('/x')}); }
    function Page() { const save = useSave(); function submit() { save.mutate(1, {onSuccess: () => router.replace('/done'), onError: fail}); } return <form onSubmit={submit}/>; }`);
  expect(flow.nodes.find(node => node.name === 'submit')?.after.map(item => [item.when, item.action, item.target])).toEqual([
    ['success', 'navigate', '/done'], ['error', 'call', 'fail'],
  ]);
});

it.each([
  ['queryClient.invalidateQueries()', 'refresh', null], ['queryClient.refetchQueries()', 'refresh', null],
  ['queryClient.resetQueries()', 'refresh', null], ['refetch()', 'refresh', null], ['queryClient.setQueryData(key)', 'cache', null],
  ['queryClient.cancelQueries()', 'cancel', null], ["router.push('/done')", 'navigate', '/done'],
  ["router.replace(`/dogs/${id}`)", 'navigate', '/dogs/…'], ['navigate(path)', 'navigate', null],
  ["redirect('/done')", 'navigate', '/done'], ['setError(error)', 'state', 'error'],
  ["alert('ok')", 'notify', null], ["window.alert('ok')", 'notify', null], ["toast('ok')", 'notify', null],
  ["toast.success('ok')", 'notify', null], ['other.push(path)', 'call', 'other.push(path)'],
])('classifies response action %s', async (call, action, target) => {
  const flow = await frontFixture(`async function run() { await fetch('/x'); ${call}; }`);
  expect(flow.nodes.find(node => node.name === 'run')?.after).toEqual([expect.objectContaining({ when: 'success', action, target })]);
});

it('bounds after actions and excludes inner callback bodies', async () => {
  const flow = await frontFixture(`async function run() { await fetch('/x'); const later = () => toast('hidden'); ${Array.from({ length: 8 }, (_, i) => `toast('${i}');`).join(' ')} }`);
  const node = flow.nodes.find(node => node.name === 'run')!;
  expect(node.after).toHaveLength(6);
  expect(node.afterOmitted).toBe(2);
  expect(node.after[0].site.text).toBe("toast('0')");
});

it.each([
  "async function run() { await fetch('/x'); toast('a'); await fetch('/x'); }",
  "async function run() { await fetch('/x'); if (!confirm('계속?')) return; await fetch('/y'); toast('b'); }",
  "async function send() { return fetch('/x'); } async function run() { await send(); if (!confirm('계속?')) return; await send(); }",
  "function a() { return fetch('/x'); } function b() { return fetch('/y'); } async function run() { if (!confirm('계속?')) return; await a(); await b(); toast('done'); }",
  "function a() { return fetch('/x'); } function validate() {} async function run() { if (!confirm('계속?')) return; validate(); await a(); toast('done'); }",
  "function a() { return fetch('/x'); } function c() { return fetch('/x'); } function b() { return c(); } async function run() { if (!confirm('계속?')) return; await a(); await b(); toast('done'); }",
])('guards multiple call positions after graph completion: %s', async code => {
  const flow = await frontFixture(code);
  expect(flow.nodes.find(node => node.name === 'run')).toMatchObject({ asks: [], after: [], afterOmitted: 0 });
  expect(flow.notes).toContain('여러 곳을 부르는 함수는 확인 창과 응답 뒤 할 일을 찾지 않았어요.');
});

it.each(['/x', '/y'])('rejects two request-body options even if only one request is in this graph: %s', async second => {
  const flow = await frontFixture(`function useSave() { const a = useMutation({mutationFn: () => fetch('/x'), onSuccess: () => toast('a')}); return useMutation({mutationFn: () => fetch('${second}'), onSuccess: () => toast('b')}); }`);
  expect(flow.nodes.find(node => node.name === 'useSave')?.after).toEqual([]);
});

it('rejects await-following actions when two returned functions are awaited', async () => {
  const flow = await frontFixture(`function login() { return fetch('/x'); } function logout() { return fetch('/y'); }
    function useAuth() { return {login, logout}; } function Page() { const {login, logout} = useAuth();
      async function submit() { await login(); await logout(); router.push('/'); } return <form onSubmit={submit}/>; }`);
  expect(flow.nodes.find(node => node.name === 'submit')?.after).toEqual([]);
});

it('reads the statement immediately after await without requiring whitespace', async () => {
  const flow = await frontFixture("async function run(){await fetch('/x');toast('ok');}");
  expect(flow.nodes.find(node => node.name === 'run')?.after.map(item => item.action)).toEqual(['notify']);
});

it('does not read inherited option names as response callbacks', async () => {
  const flow = await frontFixture("function useSave() { return useMutation({mutationFn: () => fetch('/x'), constructor: () => toast('wrong'), toString: wrong}); }");
  expect(flow.nodes.flatMap(node => node.after)).toEqual([]);
});

it('deduplicates callbacks also seen after await and ignores nested await expressions', async () => {
  const flow = await frontFixture(`function useSave() { return useMutation({mutationFn: () => fetch('/x')}); }
    function Page() { const save = useSave(); async function submit() {
      const unused = async () => { await other(); };
      await save.mutateAsync(1, {onSuccess: () => toast('saved')}); router.push('/');
    } return <form onSubmit={submit}/>; }`);
  expect(flow.nodes.find(node => node.name === 'submit')?.after.map(item => item.action)).toEqual(['notify', 'navigate']);
});

it('accepts a default imported function but rejects a reassigned export', async () => {
  await put('server.ts', "@Controller('x') class C { @Get() get() {} }");
  await put('auth.ts', "export default function login() { return fetch('/x'); }");
  await put('provider.ts', "import enter from './auth'; export function useAuth() { return {login: enter}; }");
  await put('page.tsx', 'import {useAuth} from "./provider"; function Page() { const {login} = useAuth(); const submit = () => login(); return <form onSubmit={submit}/>; }');
  expect((await analyze()).flow.edges.filter(edge => edge.kind === 'hook')).toHaveLength(1);
  await put('auth.ts', "export default function login() { return fetch('/x'); } login = other;");
  expect((await analyze()).flow.edges.filter(edge => edge.kind === 'hook')).toEqual([]);
});

it('caps returned hooks at three and uses at three across properties of each hook', async () => {
  const flow = await frontFixture(`function login() { return fetch('/x'); }
    ${Array.from({ length: 4 }, (_, i) => `function useAuth${i}() { return {login, signIn: login}; }
      function Page${i}() { const {login, signIn} = useAuth${i}(); function submit() { login(); signIn(); login(); signIn(); }
        return <form onSubmit={submit}/>; }`).join('\n')}`);
  const hooks = flow.edges.filter(edge => edge.kind === 'hook');
  expect(hooks).toHaveLength(9);
  expect(new Set(hooks.map(edge => edge.from)).size).toBe(3);
  expect(flow.notes).toContain('돌려주는 훅은 함수마다 3개까지만 봐요.');
  expect(flow.notes).toContain('훅 결과를 쓰는 곳은 훅마다 3개까지만 보여요.');
});

it('keeps returned properties tied to their functions when reusing a hook for multiple flow nodes', async () => {
  const flow = await frontFixture(`function login() { return fetch('/x'); } function logout() { return fetch('/x'); }
    function useAuth() { return {login, logout}; }
    function Page() { const {login, logout} = useAuth();
      function enter() { login(); } function leave() { logout(); }
      return <><button onClick={enter}>로그인</button><button onClick={leave}>로그아웃</button></>;
    }`);
  expect(flow.edges.filter(edge => edge.kind === 'hook').map(edge => [
    flow.nodes.find(node => node.id === edge.from)?.name,
    flow.nodes.find(node => node.id === edge.to)?.name,
  ])).toEqual([['enter', 'login'], ['leave', 'logout']]);
});

it('excludes hook users in test files and shadowed returned bindings', async () => {
  await put('page.test.tsx', 'import {useAuth} from "./client"; function Page() { const {login} = useAuth(); function submit() { login(); } return <form onSubmit={submit}/>; }');
  const flow = await frontFixture(`function login() { return fetch('/x'); } export function useAuth() { return {login}; }
    function Page() { const {login} = useAuth(); function submit(login) { login(); } return <form onSubmit={submit}/>; }`);
  expect(flow.edges.filter(edge => edge.kind === 'hook')).toEqual([]);
});

it('keeps a confirmation in the screen event step and response actions in the last step', async () => {
  const flow = await frontFixture(`function send() { return fetch('/x'); }
    function Page() { return <button onClick={async () => { if (!confirm('삭제?')) return; await send(); toast('done'); }}>삭제</button>; }`);
  const steps = storyOf(flow);
  expect(steps[0].asks.items.map(ask => ask.message)).toEqual(['삭제?']);
  expect(steps[1].asks.items).toEqual([]);
  expect(steps.at(-1)?.afterGroups.groups[0].items.map(item => item.action)).toEqual(['notify']);
});

it('keeps non-front screen facts empty', async () => {
  const flow = await frontFixture("function run() { return fetch('/x'); }");
  for (const node of flow.nodes.filter(node => node.side !== 'front')) expect(node).toMatchObject({ control: null, asks: [], after: [], afterOmitted: 0 });
});

it.each(['() => handleSuccess', 'createCallback()'])('does not mistake callback setup or a returned value for a response action: %s', callback => {
  return frontFixture(`function useSave() { return useMutation({mutationFn: () => fetch('/x'), onSuccess: ${callback}}); }`)
    .then(flow => expect(flow.nodes.flatMap(node => node.after)).toEqual([]));
});

it('reads queryFn options and uses the first line for an unknown action', async () => {
  const flow = await frontFixture(`function useLoad() { return useQuery({queryFn: () => fetch('/x'), onSuccess: () => unknownAction(
    first, second
  )}); }`);
  expect(flow.nodes.find(node => node.name === 'useLoad')?.after).toEqual([expect.objectContaining({ action: 'call', target: 'unknownAction( …' })]);
});

it.each(['next-nest', 'shared-hooks'] as const)('batch flows equal independent flows in every array order: %s', async kind => {
  await fixture();
  await put('web/app/other/page.tsx', "import {DogList} from '../../components/DogList'; export default function Other() { return <DogList />; }");
  await put('api/extra.controller.ts', "@Controller('extra') class Extra { @Get() other() {} }");
  if (kind === 'shared-hooks') {
    await put('web/save.ts', "export function save() { return fetch('/api/save', {method:'POST'}); }");
    await put('api/save.controller.ts', "@Controller('save') class Save { @Post() save() {} }");
    for (const name of ['A', 'B', 'C', 'Z']) {
      await put(`web/hooks${name}.tsx`, `import {save} from './save';
export function use${name}() { return {save}; }
export function Button${name}() { const hook = use${name}(); return <button onClick={() => hook.save()}>save</button>; }
${name === 'Z' ? "@Controller('prime') class Prime { @Get() prime() {} }" : ''}`);
    }
  }
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  // Parse Z first: reading the entire shared cache would change which first three hooks survive the cap.
  routes.routes.sort((a, b) => Number(b.path === '/api/prime') - Number(a.path === '/api/prime'));
  // Route indexes must still describe the reordered routes.
  const original = await findProjectRoutes(root, project.id, project.files);
  routes.links = original.links.map(link => ({ ...link, routeIndex: routes.routes.findIndex(route => route.path === original.routes[link.routeIndex].path) }));
  const batch = await buildFeatureFlows(root, project.id, project.files, routes);
  expect(batch).toHaveLength(routes.routes.length);
  for (let index = 0; index < batch.length; index++) {
    expect(batch[index], routes.routes[index].path!).toEqual(await buildFeatureFlow(root, project.id, project.files, routes, index));
  }
  expect(batch.some(flow => flow.nodes.filter(node => node.screen !== null).length === 2)).toBe(true);
});
it('rejects more than 200 routes before reading and honours cancellation, including an empty batch', async () => {
  await fixture();
  const { project, routes } = await analyze();
  await expect(buildFeatureFlows(root, project.id, project.files, { ...routes, routes: Array(201).fill(routes.routes[0]) }))
    .rejects.toMatchObject({ code: 'LIMIT' });
  await expect(buildFeatureFlows(root, project.id, project.files, routes, MAP_LIMITS, () => true))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(buildFeatureFlows(root, project.id, project.files, { ...routes, routes: [] }, MAP_LIMITS, () => true))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(buildFeatureFlows(root, project.id, project.files, { ...routes, routes: [] })).resolves.toEqual([]);
});


it('accepts the 200-route boundary, cancels between flows and rejects an oversized combined result', async () => {
  await put('server.ts', "@Controller('small') class Small { @Get() read() {} }");
  const { project, routes } = await analyze();
  const repeated = { ...routes, routes: Array(200).fill(routes.routes[0]) };
  await expect(buildFeatureFlows(root, project.id, project.files, repeated)).resolves.toHaveLength(200);
  let flowChecks = 0;
  await buildFeatureFlow(root, project.id, project.files, repeated, 0, MAP_LIMITS, () => { flowChecks++; return false; });
  let checks = 0;
  // The batch checks once before the first flow, then again before starting the second.
  await expect(buildFeatureFlows(root, project.id, project.files, repeated, MAP_LIMITS, () => ++checks > flowChecks + 1))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  expect(checks).toBe(flowChecks + 2);
  await expect(buildFeatureFlows(root, project.id, project.files, { ...repeated, notes: ['large'.repeat(10_000)] }))
    .rejects.toMatchObject({ code: 'LIMIT' });
});
