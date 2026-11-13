import { describe, expect, it } from 'vitest';
import { djangoFile, djangoRoutes, type DjangoFile, type DjangoRoom } from '../src/core/analysis/django-routes';
import { walkPython } from '../src/core/analysis/python-routes';

const setup = 'from django.urls import path, re_path\n';
const base = 'from rest_framework.viewsets import ViewSet\n';
const methods = '    def list(self, request): pass\n    def create(self, request): pass\n';
const cls = 'class Users(ViewSet):\n' + methods;
const generated = "Users.as_view({'get': 'list', 'post': 'create'})";
const registration = (expression = generated) => `urlpatterns = [path('users/', ${expression})]\n`;
function collect(sources: Record<string, string>, budget = 20000, nodes = 100000) {
  const room: DjangoRoom = { entries: 20000, views: budget };
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, nodes), 'hash-' + relativePath, room)]));
  return { result: djangoRoutes(files, new Set(files.keys()), 1000, () => false, true), room, files };
}
const one = (body: string) => collect({ 'pkg/urls.py': setup + body }).result;

describe('DRF ViewSet import and binding guards', () => {
  it.each([
    ['from .views import Users', 'consume(Users)', generated],
    ['from .views import Users', 'def patch():\n    consume(Users)', generated],
    ['from . import views', 'consume(views.Users)', "views.Users.as_view({'get': 'list'})"],
    ['from . import views', 'consume(views)', "views.Users.as_view({'get': 'list'})"],
    ['from . import views', 'def patch():\n    views.Users.list = other', "views.Users.as_view({'get': 'list'})"],
    ['from .views import user_view', 'consume(user_view)', 'user_view'],
    ['from .views import user_view', 'def patch():\n    user_view.actions = other', 'user_view'],
    ['from . import views', 'consume(views.user_view)', 'views.user_view'],
  ])('withholds imported class/module/view escapes: %s; %s', (statement, change, expression) => {
    const { result } = collect({ 'pkg/__init__.py': '', 'pkg/views.py': base + cls + `user_view = ${generated}\n`,
      'pkg/urls.py': setup + statement + '\n' + change + '\n' + registration(expression) });
    expect(result.routes).toEqual([]);
  });
  it('withholds a class whose generated view escapes in its defining module', () => {
    const { result } = collect({ 'pkg/__init__.py': '', 'pkg/views.py': base + cls + `consume(${generated})\n`,
      'pkg/urls.py': setup + 'from .views import Users\n' + registration() });
    expect(result.routes).toEqual([]);
  });
  it.each([['Users', generated], ['user_view', 'user_view']])('requires the imported %s before the URL registration', (name, expression) => {
    const { result } = collect({ 'pkg/__init__.py': '', 'pkg/views.py': base + cls + `user_view = ${generated}\n`,
      'pkg/urls.py': setup + registration(expression) + `from .views import ${name}\n` });
    expect(result.routes).toEqual([]);
  });
  it.each([
    ['from other import list', false], ['import list', false], ['from other import unrelated as list', false],
    ['from other import list as unrelated', true],
  ])('recognizes the actual class-body import binding: %s', (statement, supported) => {
    const result = one(base + cls + '    ' + statement + '\n' + registration());
    expect(result.routes).toHaveLength(supported ? 2 : 0);
  });
  it.each([['__list', false], ['__list__', true]])('does not confuse a private action string with its mangled name: %s', (action, supported) => {
    const result = one(base + `class Users(ViewSet):\n    def ${action}(self, request): pass\n` + registration(`Users.as_view({'get': '${action}'})`));
    expect(result.routes).toHaveLength(supported ? 1 : 0);
  });
  it.each([
    ['from rest_framework import viewsets as api', 'api.ViewSet'],
    ['import rest_framework.viewsets as api', 'api.ViewSet'],
    ['import rest_framework.viewsets', 'rest_framework.viewsets.ViewSet'],
  ])('resolves the explicit namespace base %s', (declaration, parent) => {
    const result = one(`${declaration}\nclass Users(${parent}):\n${methods}` + registration());
    expect(result.routes.map(route => [route.method, route.handler.name])).toEqual([['GET', 'Users.list'], ['POST', 'Users.create']]);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('resolves one imported generated-view alias to the original action methods', () => {
    const { result } = collect({ 'pkg/__init__.py': '',
      'pkg/views.py': base + cls + `user_view = ${generated}\n`,
      'pkg/urls.py': setup + 'from .views import user_view as endpoint\n' + registration('endpoint'),
    });
    expect(result.routes).toHaveLength(2);
    expect(result.routes.every(route => route.handler.fileId === 'pkg/views.py' && route.handler.fileHash === 'hash-pkg/views.py')).toBe(true);
    expect(result.routes.every(route => route.basis.range.fileId === 'pkg/urls.py')).toBe(true);
  });
  it.each([
    ['nested class mutation', 'def patch():\n    Users.list = replacement\npatch()\n'],
    ['nested base mutation', 'def patch():\n    ViewSet.as_view = replacement\npatch()\n'],
    ['base escape', 'consume(ViewSet)\n'],
    ['late base rebind', 'ViewSet = replacement\n'],
  ])('withholds action links after %s', (_, change) => {
    expect(one(base + cls + change + registration()).routes).toEqual([]);
  });
  it('does not infer a class whose base import appears after its declaration', () => {
    expect(one(cls + base + registration()).routes).toEqual([]);
  });
  it('does not infer a class declared after an inline URL registration', () => {
    expect(one(base + registration() + cls).routes).toEqual([]);
  });
  it.each([
    ['assignment before declaration', '    list = other\n' + methods],
    ['assignment after declaration', methods + '    list = other\n'],
    ['duplicate declaration', methods + '    def list(self, request): pass\n'],
    ['decorated nested class', methods + '    @decorate\n    class list:\n        pass\n'],
  ])('does not retain an action after %s', (_, body) => {
    expect(one(base + 'class Users(ViewSet):\n' + body + registration()).routes).toEqual([]);
  });
});

describe('DRF collection limits and Django compatibility', () => {
  it('withholds a map that reads a method already overwritten by an earlier mapping', () => {
    const source = base + cls + '    def get(self, request): pass\n';
    expect(one(source + registration("Users.as_view({'get': 'list', 'post': 'get'})")).routes).toEqual([]);
  });
  it('preserves maps whose original method is read before it is overwritten', () => {
    const source = base + cls + '    def get(self, request): pass\n';
    const result = one(source + registration("Users.as_view({'post': 'get', 'get': 'list'})"));
    expect(result.routes.map(route => route.handler.name)).toEqual(['Users.get', 'Users.list']);
  });
  it.each(['name', 'description', 'suffix', 'detail', 'basename', 'action_map'])('withholds an action replaced by DRF before dispatch: %s', name => {
    const source = base + `class Users(ViewSet):\n    def ${name}(self, request): pass\n`;
    expect(one(source + registration(`Users.as_view({'get': '${name}'})`)).routes).toEqual([]);
  });
  it('charges one class, two actions and one generated alias to the shared view budget', () => {
    const source = setup + base + cls + `endpoint = ${generated}\n` + registration('endpoint');
    const exact = collect({ 'pkg/urls.py': source }, 4);
    expect(exact.result.routes).toHaveLength(2);
    expect(exact.room.views).toBe(0);
    expect(exact.room.viewsCut).not.toBe(true);
    const short = collect({ 'pkg/urls.py': source }, 3);
    expect(short.result.routes).toEqual([]);
    expect(short.room.viewsCut).toBe(true);
  });
  it('does not reparse a truncated walk to recover class actions or aliases', () => {
    const { result, files } = collect({ 'pkg/urls.py': setup + base + cls + `endpoint = ${generated}\n` + registration('endpoint') }, 20000, 1);
    expect(files.get('pkg/urls.py')!.plain).toBe(false);
    expect(result.routes).toEqual([]);
  });
  it('keeps ordinary Django as_view keyword compatibility without treating actions as DRF', () => {
    const result = one("class Page:\n    def get(self, request): pass\nurlpatterns = [path('page/', Page.as_view(actions={'post': 'missing'}))]\n");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ method: 'GET', handler: { name: 'Page.get' } });
    expect(result.unresolvedRoutes).toEqual([]);
  });
  it.each([
    `path('users/', ${generated}, view=${generated})`,
    `path('users/', ${generated}, route='other/')`,
    `path('users/', ${generated}, unexpected=True)`,
    `path('users/', ${generated}, **options)`,
    `re_path('users/', ${generated}, view=${generated})`,
    `re_path('users/', ${generated}, route='other/')`,
  ])('does not emit action routes for an invalid registration signature: %s', call => {
    expect(one(base + cls + `urlpatterns = [${call}]\n`).routes).toEqual([]);
  });
});
