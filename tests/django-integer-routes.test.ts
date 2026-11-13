import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { djangoFile, djangoRoutes, type DjangoFile } from '../src/core/analysis/django-routes';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { findProjectRoutes, linkRoutes } from '../src/core/analysis/routes';
import { scanProject } from '../src/core/project/files';
import type { Request, Route } from '../src/shared/contracts';
const setup = 'from django.urls import path, include\ndef view(request): pass\n';
const urlconf = (route = 'users/<int:id>/') => setup + `urlpatterns = [path('${route}', view), path('health/', view)]\n`;
function join(sources: Record<string, string>, allRead = true, nodes = 100000) {
  const room = { entries: 20000, views: 20000 };
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, nodes), 'hash-' + relativePath, room)]));
  return djangoRoutes(files, new Set(files.keys()), 1000, () => false, allRead);
}
const known = (route = 'users/<int:id>/', extra: Record<string, string> = {}) => join({
  'manage.py': '', 'pkg/settings.py': "ROOT_URLCONF = 'pkg.urls'\n", 'pkg/urls.py': urlconf(route), ...extra,
});
const request = (address: string, prefix: Request['prefix'] = 'known'): Request => ({
  fileId: 'web', fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: '', args: [], inTest: false,
  inFunction: null, path: address, host: null, prefix, methods: ['GET'],
});

describe('Django built-in int request comparison', () => {
  it.each(['0', '001', '1234567890123456789012345678901234567890'])(
    'accepts ASCII digits without parsing or numeric precision loss: %s', value => {
      const result = known();
      const route = result.routes.find(route => route.path === '/users/<int:id>/')!;
      expect(route.typed).toBeUndefined();
      expect(route.unmatched).toBeUndefined();
      expect(linkRoutes([route], [request(`/users/${value}/`)])).toEqual([
        { requestIndex: 0, routeIndex: 0, sure: false, reasons: ['목록 밖 주소 가능'] },
      ]);
    });
  it.each(['-1', '+1', '1.5', '1e3', '１２', '١٢', 'abc', '12a'])(
    'rejects a value outside ASCII [0-9]+: %s', value => {
      const route = known().routes.find(route => route.path === '/users/<int:id>/')!;
      expect(linkRoutes([route], [request(`/users/${value}/`)])).toEqual([]);
    });
  it('keeps a dynamic request wildcard as a candidate with an unknown-value reason', () => {
    const route = known().routes.find(route => route.path === '/users/<int:id>/')!;
    const links = linkRoutes([route], [request('/users/*/')]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sure: false, reasons: expect.arrayContaining(['경로 값 모름', '목록 밖 주소 가능']) });
    expect(links[0].reasons).not.toContain('값 모양 모름');
  });
  it.each(['route', 'request'] as const)('keeps integer positions aligned after an unknown %s prefix', side => {
    const original = known(side === 'route' ? 'users/<int:id>/' : 'api/users/<int:id>/').routes.find(route => route.path!.includes('<int:'))!;
    const route: Route = { ...original, prefix: side === 'route' ? 'unknown' : 'known' };
    const prefix = side === 'request' ? 'unknown' : 'known';
    const address = side === 'route' ? '/api/users/' : '/users/';
    expect(linkRoutes([route], [request(address + '001/', prefix)])).toHaveLength(1);
    expect(linkRoutes([route], [request(address + 'nope/', prefix)])).toEqual([]);
  });
  it.each(['slug', 'uuid'])('keeps mixed int/%s uncertainty while checking the integer segment', converter => {
    const route = known(`users/<int:id>/<${converter}:key>/`).routes.find(route => route.path!.includes('<int:'))!;
    expect(route.typed).toBe(true);
    expect(linkRoutes([route], [request('/users/12/value/')])[0].reasons).toContain('값 모양 모름');
    expect(linkRoutes([route], [request('/users/abc/value/')])).toEqual([]);
  });
  it('checks integer positions contributed by both include and child fragments', () => {
    const result = known('unused/', {
      'pkg/urls.py': setup + "urlpatterns = [path('teams/<int:team>/', include('pkg.child'))]\n",
      'pkg/child.py': setup + "urlpatterns = [path('users/<int:user>/', view)]\n",
    });
    expect(result.routes).toHaveLength(1);
    const route = result.routes[0];
    expect(linkRoutes([route], [request('/teams/01/users/2/')])).toHaveLength(1);
    expect(linkRoutes([route], [request('/teams/bad/users/2/')])).toEqual([]);
    expect(linkRoutes([route], [request('/teams/1/users/bad/')])).toEqual([]);
  });
  it('does not repair broken converter fragments by joining them', () => {
    const result = known('unused/', {
      'pkg/urls.py': setup + "urlpatterns = [path('users/<int:', include('pkg.child'))]\n",
      'pkg/child.py': setup + "urlpatterns = [path('id>/', view)]\n",
    });
    expect(result.routes[0].unmatched).toBe(true);
    expect(linkRoutes(result.routes, [request('/users/123/')])).toEqual([]);
  });
  it('does not interpret the default DRF pk lookup as an integer converter', () => {
    const result = join({ 'pkg/urls.py': 'from rest_framework.routers import SimpleRouter\nfrom rest_framework.viewsets import ViewSet\nclass Users(ViewSet):\n    def retrieve(self, request, pk=None): pass\nrouter = SimpleRouter()\nrouter.register("users", Users, basename="users")\nurlpatterns = router.urls\n' });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users/<pk>/', typed: true });
    expect(linkRoutes(result.routes, [request('/users/abc/')])).toHaveLength(1);
  });
  it('preserves Flask typed candidates and Next dynamic parameter matching', () => {
    const text = 'from flask import Flask\napp = Flask(__name__)\n@app.route("/users/<int:id>")\ndef view(): pass\n';
    const flask = pythonRoutes({ id: 'flask', relativePath: 'app.py', size: 0 }, walkPython(text, 'app.py', 100000), 'hash', 1000).routes;
    expect(flask[0].typed).toBe(true);
    expect(linkRoutes(flask, [request('/users/abc')])).toHaveLength(1);
    const next: Route = { ...flask[0], framework: 'next', path: '/users/[id]', typed: undefined, segments: [{ text: 'users' }, { param: 'id' }] };
    expect(linkRoutes([next], [request('/users/abc')])).toHaveLength(1);
  });
});

describe('project-wide Django converter uncertainty', () => {
  it.each([
    ['direct registration', 'from django.urls import register_converter\nregister_converter(Custom, "int")\n'],
    ['aliased registration', 'from django.urls import register_converter as register\nregister(Custom, "int")\n'],
    ['default registry', 'from django.urls.converters import DEFAULT_CONVERTERS\nDEFAULT_CONVERTERS["int"] = Custom()\n'],
    ['registered registry', 'from django.urls.converters import REGISTERED_CONVERTERS\nREGISTERED_CONVERTERS["int"] = Custom()\n'],
    ['integer class', 'from django.urls.converters import IntConverter\nIntConverter.regex = ".*"\n'],
    ['registry function', 'from django.urls.converters import get_converters\nget_converters()["int"] = Custom()\n'],
    ['converter namespace', 'from django.urls import converters\nconverters.IntConverter.regex = ".*"\n'],
    ['comment mentioning converters', '# register_converter may be configured elsewhere\n'],
    ['normalized converter name', '# ＩｎｔＣｏｎｖｅｒｔｅｒ\n'],
    ['reflective registry access', 'getattr(module, field)[key] = replacement\n'],
    ['dynamic execution', 'exec(code)\n'],
    ['star import', 'from custom_converters import *\n'],
    ['incomplete source', 'value = (\n'],
  ])('withholds integer matching after %s in another file', (_, change) => {
    const result = known('users/<int:id>/', { 'pkg/z_converters.py': change });
    const route = result.routes.find(route => route.path === '/users/<int:id>/')!;
    expect(route.unmatched).toBe(true);
    expect(linkRoutes([route], [request('/users/123/')])).toEqual([]);
    const literal = result.routes.find(route => route.path === '/health/')!;
    expect(literal.unmatched).toBeUndefined();
    expect(linkRoutes([literal], [request('/health/')])).toHaveLength(1);
  });
  it('does not claim converter safety when some project files were not read', () => {
    const result = join({ 'pkg/urls.py': urlconf() }, false);
    expect(result.routes.find(route => route.path === '/users/<int:id>/')!.unmatched).toBe(true);
    expect(result.routes.find(route => route.path === '/health/')!.unmatched).toBeUndefined();
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('compares real project fetch requests against int-only Django routes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-django-int-')));
  roots.push(root);
  const sources = { 'manage.py': '', 'pkg/__init__.py': '', 'pkg/settings.py': "ROOT_URLCONF = 'pkg.urls'\n", 'pkg/urls.py': urlconf(),
    'web.ts': "fetch('/users/001/'); fetch('/users/-1/'); fetch('/users/１２/');\n" };
  for (const [relative, text] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  const project = await scanProject(root, randomUUID());
  const result = await findProjectRoutes(root, project.id, project.files);
  expect(result.links).toHaveLength(1);
  expect(result.requests[result.links[0].requestIndex].path).toBe('/users/001');
  expect(result.links[0]).toMatchObject({ sure: false, reasons: ['목록 밖 주소 가능'] });
});
