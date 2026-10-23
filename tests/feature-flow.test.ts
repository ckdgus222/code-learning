import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { buildFeatureFlow } from '../src/core/analysis/feature-flow';
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
  expect(flow.limited).toBe(false);
  const story = storyOf(flow);
  expect(story.map(step => step.kind)).toEqual(['screen', 'front', 'request', 'handler', 'back', 'store']);
  // The click path, not DogList's direct hook call, even though DogList is deeper.
  expect(story[0].text).toBe('화면 /dogs에서 onClick 동작이 일어나요');
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
