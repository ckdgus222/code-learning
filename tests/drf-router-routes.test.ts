import { describe, expect, it } from 'vitest';
import { djangoFile, djangoRoutes, type DjangoFile, type DjangoRoom } from '../src/core/analysis/django-routes';
import { walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';

const imports = 'from django.urls import path, include\nfrom rest_framework.routers import SimpleRouter\nfrom rest_framework.viewsets import ViewSet\n';
const methods = '    def list(self, request): pass\n    def retrieve(self, request, pk=None): pass\n';
const declaration = 'class Users(ViewSet):\n' + methods;
const registration = "router.register('users', Users, basename='users')\n";
const exposure = 'urlpatterns = router.urls\n';
function collect(sources: Record<string, string>, max = 1000, stop = () => false, nodes = 100000, views = 20000) {
  const room: DjangoRoom = { entries: 20000, views };
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, nodes), 'hash-' + relativePath, room)]));
  return djangoRoutes(files, new Set(files.keys()), max, stop, true);
}
const one = (text: string) => collect({ 'pkg/urls.py': text });
const basic = (options = '') => imports + declaration + `router = SimpleRouter(${options})\n` + registration;

describe('DRF local router registrations', () => {
  it('creates list/detail candidates with actual methods and register call evidence', () => {
    const text = basic() + exposure;
    const result = one(text);
    expect(result.routes.map(route => [route.method, route.path, route.handler.name])).toEqual([
      ['GET', '/users/', 'Users.list'], ['GET', '/users/<pk>/', 'Users.retrieve'],
    ]);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
    expect(result.routes[1].typed).toBe(true);
    const symbols = analyzeSource(text, 'pkg/urls.py', { projectId: 'project', fileId: 'pkg/urls.py', fileHash: 'hash-pkg/urls.py' }).symbols;
    for (const route of result.routes) {
      const symbol = symbols.find(symbol => symbol.name === route.handler.name)!;
      expect(route.handler).toMatchObject({ fileId: 'pkg/urls.py', fileHash: 'hash-pkg/urls.py', startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
      expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe(registration.trim());
    }
  });
  it.each([
    ['from rest_framework.routers import DefaultRouter as Router', 'Router'],
    ['from rest_framework import routers as api', 'api.SimpleRouter'],
    ['import rest_framework.routers as api', 'api.SimpleRouter'],
    ['import rest_framework.routers', 'rest_framework.routers.DefaultRouter'],
  ])('recognizes the explicit router namespace %s', (statement, ctor) => {
    const text = imports.replace('from rest_framework.routers import SimpleRouter', statement) + declaration + `router = ${ctor}()\n` + registration + exposure;
    const routes = one(text).routes;
    expect(routes.some(route => route.path === '/users/' && route.handler.name === 'Users.list')).toBe(true);
    expect(routes.some(route => route.path === '/users/<pk>/' && route.handler.name === 'Users.retrieve')).toBe(true);
  });
  it('finds an imported project ViewSet and keeps the source and registration files distinct', () => {
    const result = collect({ 'pkg/__init__.py': '',
      'pkg/views.py': 'from rest_framework.viewsets import ViewSet\n' + declaration,
      'pkg/urls.py': imports + 'from .views import Users as API\nrouter = SimpleRouter()\n' + registration.replace('Users', 'API') + exposure,
    });
    expect(result.routes).toHaveLength(2);
    expect(result.routes.every(route => route.handler.fileId === 'pkg/views.py' && route.handler.fileHash === 'hash-pkg/views.py')).toBe(true);
    expect(result.routes.every(route => route.basis.range.fileId === 'pkg/urls.py')).toBe(true);
  });
  it.each(['urlpatterns = [] + router.urls\n', 'urlpatterns = []\nurlpatterns += router.urls\n'])(
    'recognizes direct list addition %s', expression => {
      expect(one(basic() + expression).routes.map(route => route.path)).toEqual(['/users/', '/users/<pk>/']);
    });
  it('joins a literal include prefix without duplicating raw router templates', () => {
    const result = one(basic() + "urlpatterns = [path('api/', include(router.urls))]\n");
    expect(result.routes.map(route => route.path)).toEqual(['/api/users/', '/api/users/<pk>/']);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('honors trailing_slash=False', () => {
    expect(one(basic('trailing_slash=False') + exposure).routes.map(route => route.path)).toEqual(['/users', '/users/<pk>']);
  });
  it('accepts use_regex_path=False without assuming the regex lookup constraint', () => {
    const result = one(basic('use_regex_path=False') + exposure);
    expect(result.routes.map(route => route.path)).toEqual(['/users/', '/users/<pk>/']);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('does not emit routes for an unexposed router', () => {
    expect(one(basic()).routes).toEqual([]);
  });
  it('does not invent inherited external standard action handlers', () => {
    const text = imports.replace('import ViewSet', 'import ModelViewSet') + 'class Users(ModelViewSet):\n    pass\nrouter = SimpleRouter()\n' + registration + exposure;
    const result = one(text);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes.length).toBeGreaterThan(0);
    expect(result.unresolvedRoutes.every(route => route.reason === 'unsupported-view')).toBe(true);
  });
  it('emits no standard routes for a ViewSet with no standard actions', () => {
    const result = one(imports + 'class Users(ViewSet):\n    def helper(self): pass\nrouter = SimpleRouter()\n' + registration + exposure);
    expect(result.routes).toEqual([]);
  });
});

describe('DRF router extra actions', () => {
  const actionSource = (decorator: string, name = 'archive') => imports + 'from rest_framework.decorators import action\nclass Users(ViewSet):\n    ' + decorator + `\n    def ${name}(self, request, pk=None): pass\nrouter = SimpleRouter()\n` + registration + exposure;
  it.each([
    ["@action(detail=False, methods=['post'], url_path='archive-all')", '/users/archive-all/', 'POST'],
    ["@action(detail=True, methods=['post'], url_path='archive')", '/users/<pk>/archive/', 'POST'],
    ["@action(detail=False)", '/users/archive/', 'GET'],
    ["@action(detail=False, methods=None)", '/users/archive/', 'GET'],
    ["@action(detail=False, url_path='', url_name='different-name')", '/users/archive/', 'GET'],
  ])('uses declared action routing %s', (decorator, address, method) => {
    const text = actionSource(decorator);
    const result = one(text);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: address, method, prefix: 'unknown', handler: { name: 'Users.archive' } });
    expect(text.slice(result.routes[0].handler.startUtf16, result.routes[0].handler.endUtf16)).toContain(decorator);
    expect(text.slice(result.routes[0].basis.range.startUtf16, result.routes[0].basis.range.endUtf16)).toBe(registration.trim());
  });
  it('does not turn an empty action method list into GET or ALL', () => {
    expect(one(actionSource('@action(detail=False, methods=[])')).routes).toEqual([]);
  });
  it.each([
    ['stacked action', '@other\n    @action(detail=False)', 'archive'],
    ['reserved standard action', '@action(detail=False)', 'list'],
  ])('does not emit unsafe extra-action routes: %s', (_, decorator, name) => {
    expect(one(actionSource(decorator, name)).routes).toEqual([]);
  });
  it('does not guess a mapping.post action that changes a declared action', () => {
    const text = imports + 'from rest_framework.decorators import action\nclass Users(ViewSet):\n    @action(detail=False)\n    def archive(self, request): pass\n    @archive.mapping.post\n    def post_archive(self, request): pass\nrouter = SimpleRouter()\n' + registration + exposure;
    expect(one(text).routes).toEqual([]);
  });
});

describe('DRF router uncertainty and bounds', () => {
  it('reports the omitted API root of an exposed empty DefaultRouter without inventing source evidence', () => {
    const result = one('from rest_framework.routers import DefaultRouter\nrouter = DefaultRouter()\n' + exposure);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toEqual([]);
    expect(result.drfDefaults).toBe(1);
  });
  it('withholds DRF when third-file mutation metadata exceeds the shared project budget', () => {
    const noise = (offset: number) => Array.from({ length: 2500 }, (_, i) => `from .other import helper as h${i + offset}\nconsume(h${i + offset})\n`).join('');
    const result = collect({ 'pkg/__init__.py': '', 'pkg/views.py': imports + declaration,
      'pkg/urls.py': imports + 'from .views import Users\nrouter = SimpleRouter()\n' + registration + exposure,
      'pkg/other.py': 'def helper(): pass\n', 'pkg/noise1.py': noise(0), 'pkg/noise2.py': noise(2500),
      'pkg/effect.py': 'from .views import Users\nUsers.list = other\n' });
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes.length).toBeGreaterThan(0);
  });
  it('bounds the registrations, uses and actions product before retaining generated candidates', () => {
    const actions = Array.from({ length: 100 }, (_, i) => `    @action(detail=False)\n    def action_${i}(self, request): pass\n`).join('');
    const registrations = Array.from({ length: 100 }, (_, i) => `router.register('items${i}', Users, basename='items${i}')\n`).join('');
    const uses = 'urlpatterns = router.urls\n' + 'urlpatterns += router.urls\n'.repeat(100);
    const started = performance.now();
    const result = one(imports + 'from rest_framework.decorators import action\nclass Users(ViewSet):\n' + actions + 'router = SimpleRouter()\n' + registrations + uses);
    expect(result.routes).toHaveLength(1000);
    expect(result.cut).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  });
  it.each([
    'from rest_framework.routers import SimpleRouter\nSimpleRouter.register = other',
    'from rest_framework.viewsets import ViewSet\nViewSet.as_view = other',
    'from rest_framework.decorators import action\naction.__code__ = other.__code__',
    'from rest_framework import routers\nrouters.SimpleRouter.register = other',
    'import rest_framework.routers\nrest_framework.routers.SimpleRouter.register = other',
  ])('withholds candidates after a third file changes an official DRF object: %s', effect => {
    const result = collect({ 'pkg/__init__.py': '', 'pkg/urls.py': basic() + exposure, 'pkg/effect.py': effect });
    expect(result.routes).toEqual([]);
  });
  it('preserves candidates when another file only constructs an unrelated Response', () => {
    const result = collect({ 'pkg/__init__.py': '', 'pkg/urls.py': basic() + exposure,
      'pkg/effect.py': 'from rest_framework.response import Response\nResponse({})\n' });
    expect(result.routes).toHaveLength(2);
  });
  it.each(["user_view.actions['get'] = 'other'", 'consume(user_view)'])('keeps third-file mutation attached to a generated alias: %s', change => {
    const result = collect({ 'pkg/__init__.py': '', 'pkg/views.py': imports + declaration + "user_view = Users.as_view({'get': 'list'})\n",
      'pkg/urls.py': "from django.urls import path\nfrom .views import user_view\nurlpatterns = [path('users/', user_view)]\n",
      'pkg/effect.py': 'from .views import user_view\n' + change + '\n' });
    expect(result.routes).toEqual([]);
  });
  it.each(['post', 'POST', 'poſt'])('accepts only ASCII action HTTP method names: %s', method => {
    const text = imports + `from rest_framework.decorators import action\nclass Users(ViewSet):\n    @action(detail=False, methods=['${method}'])\n    def archive(self, request): pass\nrouter = SimpleRouter()\n` + registration + exposure;
    expect(one(text).routes).toHaveLength(method === 'poſt' ? 0 : 1);
  });
  it('does not normalize a non-ASCII manual HTTP mapping into POST', () => {
    const text = imports + declaration + "urlpatterns = [path('users/', Users.as_view({'poſt': 'list'}))]\n";
    expect(one(text).routes).toEqual([]);
  });
  it.each([
    ['from .urls import router', 'router.registry.clear()'],
    ['from .urls import router', 'consume(router)'],
    ['from .urls import router', 'def patch():\n    (router).registry.clear()'],
    ['from . import urls', 'urls.router.registry.clear()'],
  ])('withholds a router changed through a third file: %s; %s', (statement, change) => {
    const result = collect({ 'pkg/__init__.py': '', 'pkg/views.py': 'from rest_framework.viewsets import ViewSet\n' + declaration,
      'pkg/urls.py': imports + 'from .views import Users\nrouter = SimpleRouter()\n' + registration + exposure,
      'pkg/effect.py': statement + '\n' + change + '\n' });
    expect(result.routes).toEqual([]);
  });
  it.each(['path', 'include'])('requires the include helper %s before router use', helper => {
    const other = helper === 'path' ? 'include' : 'path';
    const text = basic().replace('from django.urls import path, include', `from django.urls import ${other}`)
      + "urlpatterns = [path('api/', include(router.urls))]\n" + `from django.urls import ${helper}\n`;
    expect(one(text).routes).toEqual([]);
  });
  it('does not treat a method used as lookup_field as the default lookup', () => {
    const text = imports + declaration + '    def lookup_field(self): pass\nrouter = SimpleRouter()\n' + registration + exposure;
    expect(one(text).routes).toEqual([]);
  });
  it.each([
    ['missing basename', "router.register('users', Users)"],
    ['dynamic basename', "router.register('users', Users, basename=name)"],
    ['dynamic prefix', "router.register(prefix, Users, basename='users')"],
  ])('records uncertainty rather than a guessed standard route for %s', (_, statement) => {
    const result = one(imports + declaration + 'router = SimpleRouter()\n' + statement + '\n' + exposure);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes.length).toBeGreaterThan(0);
  });
  it('keeps custom lookup behavior unresolved', () => {
    const result = one(imports + 'class Users(ViewSet):\n    lookup_field = "slug"\n' + methods + 'router = SimpleRouter()\n' + registration + exposure);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes.length).toBeGreaterThan(0);
  });
  it.each([
    ['fake constructor', 'class SimpleRouter: pass\n'],
    ['registry mutation', 'router.registry.clear()\n'],
    ['router escape', 'consume(router)\n'],
    ['duplicate basename', "router.register('other', Users, basename='users')\n"],
  ])('withholds routes after %s', (_, change) => {
    expect(one(basic() + change + exposure).routes).toEqual([]);
  });
  it('does not apply a registration written after urlpatterns consumed the router', () => {
    expect(one(imports + declaration + 'router = SimpleRouter()\n' + exposure + registration).routes).toEqual([]);
  });
  it('does not resolve a class defined after its registration', () => {
    expect(one(imports + 'router = SimpleRouter()\n' + registration + declaration + exposure).routes).toEqual([]);
  });
  it.each([
    "router.register('users', Users, basename='users', viewset=Users)",
    "router.register('users', Users, basename='users', **options)",
    "router.register('users', Users, basename='users', unexpected=True)",
  ])('rejects an invalid register call: %s', call => {
    expect(one(imports + declaration + 'router = SimpleRouter()\n' + call + '\n' + exposure).routes).toEqual([]);
  });
  it('honors maxRoutes while returning only actual action handlers', () => {
    const result = collect({ 'pkg/urls.py': basic() + exposure }, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(['Users.list', 'Users.retrieve']).toContain(result.routes[0].handler.name);
  });
  it('cancels before expanding router-generated candidates', () => {
    expect(() => collect({ 'pkg/urls.py': basic() + exposure }, 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
  it('does not recover action handlers after a node or view budget cut', () => {
    expect(collect({ 'pkg/urls.py': basic() + exposure }, 1000, () => false, 1).routes).toEqual([]);
    expect(collect({ 'pkg/urls.py': basic() + exposure }, 1000, () => false, 100000, 0).routes).toEqual([]);
  });
});
