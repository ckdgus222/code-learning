import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { djangoFile, djangoRoutes, type DjangoFile } from '../src/core/analysis/django-routes';
import { walkPython } from '../src/core/analysis/python-routes';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { readAllowed, scanProject } from '../src/core/project/files';
const urls = 'from django.urls import path\n';
const imported = 'from rest_framework.viewsets import ViewSet\n';
const actions = '    def list(self, request):\n        return 1\n    def create(self, request):\n        return 2\n';
const viewset = imported + 'class Users(ViewSet):\n' + actions;
const registration = (view = "Users.as_view({'get': 'list', 'post': 'create'})") => `urlpatterns = [path('users/', ${view})]\n`;
function join(sources: Record<string, string>, max = 1000, stop = () => false, viewBudget = 20000) {
  const room = { entries: 20000, views: viewBudget };
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, 200000), 'hash-' + relativePath, room)]));
  return djangoRoutes(files, new Set(files.keys()), max, stop, true);
}
const one = (body: string) => join({ 'pkg/urls.py': urls + body });

describe('manual DRF ViewSet registrations', () => {
  it.each(['ViewSet', 'GenericViewSet', 'ModelViewSet', 'ReadOnlyModelViewSet'])(
    'connects explicitly declared actions on the official %s base', base => {
      const result = one(`from rest_framework.viewsets import ${base} as Base\nclass Users(Base):\n` + actions + registration());
      expect(result.routes.map(route => [route.method, route.handler.name])).toEqual([['GET', 'Users.list'], ['POST', 'Users.create']]);
      expect(result.routes.every(route => route.prefix === 'unknown' && route.path === '/users/')).toBe(true);
      expect(result.unresolvedRoutes).toEqual([]);
    });
  it.each(["Users.as_view(actions={'get': 'list'})", "Users.as_view({'get': 'list'})"])(
    'accepts a literal actions argument: %s', expression => {
      const result = one(viewset + registration(expression));
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0]).toMatchObject({ method: 'GET', handler: { name: 'Users.list' }, prefix: 'unknown' });
    });
  it('allows a single earlier generated view alias to be reused at multiple URLs', () => {
    const result = one(viewset + "user_view = Users.as_view({'get': 'list'})\nurlpatterns = [path('one/', user_view), path('two/', user_view)]\n");
    expect(result.routes.map(route => route.path)).toEqual(['/one/', '/two/']);
    expect(result.routes.every(route => route.handler.name === 'Users.list' && route.prefix === 'unknown')).toBe(true);
  });
  it('maps all five supported HTTP methods to the written action without inventing ALL', () => {
    const mapping = "{'get': 'list', 'post': 'create', 'put': 'create', 'patch': 'create', 'delete': 'create'}";
    const result = one(viewset + registration(`Users.as_view(${mapping})`));
    expect(result.routes.map(route => route.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });
  it('withholds the whole mapping when an action exists only in an external base', () => {
    const result = one('from rest_framework.viewsets import ModelViewSet\nclass Users(ModelViewSet):\n    def create(self, request): pass\n' + registration());
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.unresolvedRoutes[0]).toMatchObject({ reason: 'unsupported-view' });
  });
  it.each([
    ['name alone', 'class ViewSet: pass\nclass Users(ViewSet):\n' + actions],
    ['custom base', imported + 'class Custom(ViewSet): pass\nclass Users(Custom):\n' + actions],
    ['mixin', imported + 'class Users(Mixin, ViewSet):\n' + actions],
    ['class decorator', imported + '@decorate\nclass Users(ViewSet):\n' + actions],
    ['dispatch override', viewset + '    def dispatch(self, request): pass\n'],
  ])('does not infer a DRF action through %s', (_, declaration) => {
    expect(one(declaration + registration()).routes).toEqual([]);
  });
  it.each([
    "{'GET': 'list'}",
    "{'head': 'list', 'options': 'list'}",
    "{'get': 'list', 'post': 'missing'}",
    "{'get': 'list', 'get': 'create'}",
    'dynamic_actions', '{}', "{**extra, 'get': 'list'}",
    "{'get': action_name}",
  ])('rejects the whole unsupported actions map: %s', mapping => {
    const result = one(viewset + registration(`Users.as_view(${mapping})`));
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
  });
  it('rejects duplicate actions and dispatch-changing options instead of selecting one mapping', () => {
    for (const expression of ["Users.as_view({'get': 'list'}, actions={'post': 'create'})", "Users.as_view({'get': 'list'}, dispatch=other)", "Users.as_view(**options)"]) {
      expect(one(viewset + registration(expression)).routes).toEqual([]);
    }
  });
  it.each([
    ['reassigned', 'user_view = other\n'],
    ['deleted', 'del user_view\n'],
    ['mutated', 'user_view.actions = other\n'],
    ['escaped', 'saved = [user_view]\n'],
    ['alias of alias', 'second = user_view\n'],
  ])('does not use an unsafe generated view alias: %s', (_, change) => {
    const target = change.includes('second') ? 'second' : 'user_view';
    expect(one(viewset + "user_view = Users.as_view({'get': 'list'})\n" + change + registration(target)).routes).toEqual([]);
  });
  it('requires a generated alias before its registration and the class before alias creation', () => {
    const alias = "user_view = Users.as_view({'get': 'list'})\n";
    expect(one(viewset + registration('user_view') + alias).routes).toEqual([]);
    expect(one(alias + viewset + registration('user_view')).routes).toEqual([]);
  });
  it('does not normalize the action lookup string as if it were a Python identifier', () => {
    const declaration = imported + 'class Users(ViewSet):\n    def K(self, request): pass\n';
    expect(one(declaration + registration("Users.as_view({'get': 'K'})")).routes).toEqual([]);
    const result = one(declaration + registration("Users.as_view({'get': 'K'})"));
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].method).toBe('GET');
  });
  it('does not retain actions after method decoration, mutation or class escape', () => {
    for (const declaration of [
      imported + 'class Users(ViewSet):\n    @decorate\n    def list(self, request): pass\n',
      viewset + 'Users.list = other\n', viewset + 'saved = Users\n',
    ]) expect(one(declaration + registration("Users.as_view({'get': 'list'})")).routes).toEqual([]);
  });
  it('honors the normal output limit without creating extra unresolved copies', () => {
    const result = join({ 'pkg/urls.py': urls + viewset + registration() }, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(result.unresolvedRoutes).toEqual([]);
  });
  it('does not create a handler after the shared view collection budget is exhausted', () => {
    const result = join({ 'pkg/urls.py': urls + viewset + registration() }, 1000, () => false, 0);
    expect(result.routes).toEqual([]);
  });
  it('cancels before manual action mappings are emitted', () => {
    expect(() => join({ 'pkg/urls.py': urls + viewset + registration() }, 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function prepare(sources: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-drf-actions-')));
  roots.push(root);
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', ...sources })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return { root, project: await scanProject(root, randomUUID()) };
}
describe('manual ViewSet project evidence', () => {
  it('preserves the existing unresolved policy for absolute imports from outside a package', async () => {
    const { root, project } = await prepare({ 'foreign/__init__.py': '', 'foreign/viewsets.py': viewset,
      'drfurls.py': urls + 'from foreign.viewsets import Users\n' + "user_view = Users.as_view({'get': 'list'})\n"
        + "urlpatterns = [path('drf-records/', Users.as_view({'get': 'list'})), path('drf-alias/', user_view)]\n" });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes?.map(route => route.path)).toEqual(['/drf-records/', '/drf-alias/']);
  });
  it.each([false, true])('retains the actual action source across an imported class: %s', isImported => {
    const caller = urls + (isImported ? 'from .views import Users as API\n' : viewset);
    const result = join({ 'pkg/__init__.py': '', 'pkg/urls.py': caller + registration(`${isImported ? 'API' : 'Users'}.as_view({'get': 'list'})`), ...(isImported ? { 'pkg/views.py': viewset } : {}) });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ handler: { fileId: isImported ? 'pkg/views.py' : 'pkg/urls.py', name: 'Users.list' }, basis: { range: { fileId: 'pkg/urls.py' } }, prefix: 'unknown' });
  });
  it('preserves Unicode method hash/range and the URL call as registration evidence', async () => {
    const declaration = imported + '# 🐍\nclass Users(ViewSet):\n    def 목록(self, request):\n        return 1\n';
    const caller = urls + "from .views import Users as API\nurlpatterns = [path('자료/', API.as_view({'get': '목록'}))]\n";
    const { root, project } = await prepare({ 'pkg/views.py': declaration, 'pkg/urls.py': caller });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/views.py')!;
    const data = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(data.text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: data.hash }).symbols.find(symbol => symbol.name === 'Users.목록')!;
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: data.hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const urlFile = project.files.find(file => file.relativePath === 'pkg/urls.py')!;
    const urlData = await readAllowed(root, urlFile.relativePath);
    const basis = result.routes[0].basis;
    expect(basis.range).toMatchObject({ fileId: urlFile.id, fileHash: urlData.hash });
    expect(caller.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe("path('자료/', API.as_view({'get': '목록'}))");
    expect(data.text).toBe(declaration);
  });
  it.each(['rest_framework.py', 'rest_framework/__init__.py'])(
    'withholds only DRF candidates when the project shadows %s', async shadow => {
      const { root, project } = await prepare({ [shadow]: '', 'pkg/urls.py': urls + viewset + "def page(request): pass\nurlpatterns = [path('page/', page), path('users/', Users.as_view({'get': 'list'}))]\n" });
      const result = await findProjectRoutes(root, project.id, project.files);
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].handler.name).toBe('page');
    });
});
