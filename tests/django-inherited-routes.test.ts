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
const setup = 'from django.urls import path\n';
const parent = 'class Base:\n    def get(self, request): pass\n    def post(self, request): pass\n';
const child = 'class Child(Base):\n    pass\n';
const registration = "urlpatterns = [path('page/', Child.as_view())]\n";
function join(sources: Record<string, string>, stop = () => false, views = 20000) {
  const room = { entries: 20000, views };
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, 200000), 'hash-' + relativePath, room)]));
  return djangoRoutes(files, new Set(files.keys()), 1000, stop, true);
}
const one = (text: string) => join({ 'pkg/urls.py': setup + text });
const withoutParent = (result: ReturnType<typeof one>) => expect(result.routes.filter(route => route.handler.name.startsWith('Base.'))).toEqual([]);

describe('ordinary Django local inheritance', () => {
  it('requires the selected child class before the URL registration', () => {
    withoutParent(one(parent + registration + child));
  });
  it.each(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])('withholds new inherited methods for a forbidden %s initkwarg', name => {
    withoutParent(one(parent + child + `urlpatterns = [path('page/', Child.as_view(${name}=other))]\n`));
  });
  it('does not add inherited handlers for duplicate initialization keywords', () => {
    withoutParent(one(parent + child + "urlpatterns = [path('page/', Child.as_view(template_name='one', template_name='two'))]\n"));
  });
  it('uses original parent methods while keeping the child registration as evidence', () => {
    const text = setup + parent + child + registration;
    const result = join({ 'pkg/urls.py': text });
    expect(result.routes.map(route => [route.method, route.handler.name])).toEqual([['GET', 'Base.get'], ['POST', 'Base.post']]);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
    for (const route of result.routes) {
      expect(route.handler).toMatchObject({ fileId: 'pkg/urls.py', fileHash: 'hash-pkg/urls.py' });
      expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe("path('page/', Child.as_view())");
      expect(text.slice(route.handler.startUtf16, route.handler.endUtf16)).toMatch(/^def (get|post)\(/);
    }
  });
  it('follows two local inheritance levels through an empty intermediate class', () => {
    const result = one(parent + 'class Middle(Base):\n    pass\nclass Child(Middle):\n    pass\n' + registration);
    expect(result.routes.map(route => route.handler.name)).toEqual(['Base.get', 'Base.post']);
  });
  it('keeps own GET certainty while inherited POST remains unknown', () => {
    const result = join({ 'manage.py': '', 'pkg/settings.py': "ROOT_URLCONF = 'pkg.urls'\n",
      'pkg/urls.py': setup + parent + 'class Child(Base):\n    def get(self, request): pass\n' + registration });
    expect(result.routes.find(route => route.method === 'GET')).toMatchObject({ prefix: 'known', handler: { name: 'Child.get' } });
    expect(result.routes.find(route => route.method === 'POST')).toMatchObject({ prefix: 'unknown', handler: { name: 'Base.post' } });
    expect(result.routes).toHaveLength(2);
  });
  it.each([
    ['from .base import Base', 'Base'],
    ['from .base import Base as Parent', 'Parent'],
    ['from . import base as module', 'module.Base'],
  ])('follows an explicitly imported parent: %s', (declaration, base) => {
    const result = join({ 'pkg/__init__.py': '', 'pkg/base.py': parent,
      'pkg/urls.py': setup + declaration + `\nclass Child(${base}):\n    pass\n` + registration });
    expect(result.routes).toHaveLength(2);
    expect(result.routes.every(route => route.handler.fileId === 'pkg/base.py' && route.handler.fileHash === 'hash-pkg/base.py' && route.prefix === 'unknown')).toBe(true);
  });
  it.each([
    ['assignment', '    get = other\n'],
    ['deletion', '    del get\n'],
    ['duplicate methods', '    def get(self, request): pass\n    def get(self, request): pass\n'],
    ['decorated method', '    @decorate\n    def get(self, request): pass\n'],
    ['conditional method', '    if flag:\n        def get(self, request): pass\n'],
  ])('never falls back through a child get slot affected by %s', (_, body) => {
    const result = one(parent + 'class Child(Base):\n' + body + registration);
    // Existing direct/decorated-method policy may retain Child.get; only parent fallback is prohibited.
    expect(result.routes.filter(route => route.handler.name === 'Base.get')).toEqual([]);
  });
  it.each([
    ['decorated class', '@decorate\nclass Child(Base):\n    def put(self, request): pass\n'],
    ['dispatch override', 'class Child(Base):\n    def dispatch(self, request): pass\n'],
    ['setup override', 'class Child(Base):\n    def setup(self, request): pass\n'],
    ['custom constructor', 'class Child(Base):\n    def __init__(self): pass\n'],
    ['class creation hook', 'class Child(Base):\n    def __init_subclass__(cls): pass\n'],
  ])('does not add inherited methods through unsafe %s', (_, declaration) => {
    withoutParent(one(parent + declaration + registration));
  });
  it.each([
    ['multiple bases', 'Base, Other'],
    ['dynamic base', 'choose_base()'],
    ['metaclass', 'Base, metaclass=Meta'],
  ])('withholds new inheritance but preserves direct GET for %s', (_, bases) => {
    const result = one(parent + `class Child(${bases}):\n    def get(self, request): pass\n` + registration);
    withoutParent(result);
    expect(result.routes.find(route => route.method === 'GET')).toMatchObject({ handler: { name: 'Child.get' } });
  });
  it('does not inherit through a parent class creation hook', () => {
    withoutParent(one(parent + '    def __init_subclass__(cls): pass\n' + child + registration));
  });
  it.each([
    ['late parent', child + parent],
    ['rebound parent', parent + 'Base = other\n' + child],
    ['changed parent method', parent + 'Base.get = other\n' + child],
  ])('does not inherit through %s', (_, declarations) => {
    withoutParent(one(declarations + registration));
  });
  it('does not infer a base import written after the child class', () => {
    const result = join({ 'pkg/__init__.py': '', 'pkg/base.py': parent,
      'pkg/urls.py': setup + child + 'from .base import Base\n' + registration });
    withoutParent(result);
  });
  it('withholds inherited actions when another project file escapes the parent class', () => {
    const result = join({ 'pkg/__init__.py': '', 'pkg/base.py': parent,
      'pkg/urls.py': setup + 'from .base import Base\n' + child + registration,
      'pkg/z_mutate.py': 'from .base import Base\nconsume(Base)\n' });
    withoutParent(result);
  });
  it('terminates cyclic parent references without producing a guessed inherited handler', () => {
    const result = one('class Base(Child):\n    def get(self, request): pass\nclass Child(Base):\n    pass\n' + registration);
    withoutParent(result);
  });
  it('does not traverse beyond the eight-parent bound', () => {
    const declarations = parent + Array.from({ length: 9 }, (_, i) => `class Level${i}(${i === 0 ? 'Base' : 'Level' + (i - 1)}):\n    pass\n`).join('');
    const result = one(declarations + "urlpatterns = [path('page/', Level8.as_view())]\n");
    withoutParent(result);
    expect(result.cut).toBe(true);
  });
  it('shares the existing class view budget rather than recovering discarded parent metadata', () => {
    const result = join({ 'pkg/urls.py': setup + parent + child + registration }, () => false, 0);
    expect(result.routes).toEqual([]);
  });
  it('cancels inheritance resolution', () => {
    expect(() => join({ 'pkg/urls.py': setup + parent + child + registration }, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
  it('retains an unresolved record for external ListView without fabricating its inherited get', () => {
    const result = one('from django.views.generic import ListView\nclass Child(ListView):\n    pass\n' + registration);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.unresolvedRoutes[0]).toMatchObject({ reason: 'unsupported-view' });
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('inherited Django project evidence', () => {
  it('keeps the parent Unicode source hash/range and the child URL basis', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-django-inheritance-')));
    roots.push(root);
    const origin = '# 🐍 부모\nclass Base:\n    def get(self, request):\n        return "자료"\n';
    const caller = setup + 'from .base import Base\n' + child + registration;
    for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', 'pkg/base.py': origin, 'pkg/urls.py': caller })) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), text);
    }
    const project = await scanProject(root, randomUUID());
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/base.py')!;
    const data = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(data.text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: data.hash }).symbols.find(symbol => symbol.name === 'Base.get')!;
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: data.hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const urlFile = project.files.find(file => file.relativePath === 'pkg/urls.py')!;
    const urlData = await readAllowed(root, urlFile.relativePath);
    expect(result.routes[0].basis.range).toMatchObject({ fileId: urlFile.id, fileHash: urlData.hash });
    expect(caller.slice(result.routes[0].basis.range.startUtf16, result.routes[0].basis.range.endUtf16)).toBe("path('page/', Child.as_view())");
    expect(data.text).toBe(origin);
  });
});
