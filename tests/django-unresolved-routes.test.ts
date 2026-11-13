import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { djangoFile, djangoRoutes, type DjangoFile } from '../src/core/analysis/django-routes';
import { walkPython } from '../src/core/analysis/python-routes';
import { assertResultSize, findProjectRoutes } from '../src/core/analysis/routes';
import { readAllowed, scanProject } from '../src/core/project/files';
import { featureGuideMaterial } from '../src/core/ai/feature-guide';
const setup = 'from django.urls import path, re_path, include\n';
const staticSetup = 'from django.conf.urls.static import static\n';
function join(sources: Record<string, string>, max = 1000, stop = () => false) {
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, 200000), 'hash-' + relativePath, { entries: 20000, views: 20000 })]));
  return djangoRoutes(files, new Set(files.keys()), max, stop, true);
}
const one = (body: string) => join({ 'pkg/urls.py': setup + body });

describe('unresolved Django route records', () => {
  it.each(['lambda request: value', 'build_view()', 'views.a.b', "'pkg.views.page'"])(
    'records an unreadable view expression without inventing a handler: %s', expression => {
      const result = one(`urlpatterns = [path('page/', ${expression})]\n`);
      expect(result.routes).toEqual([]);
      expect(result.unresolvedRoutes).toHaveLength(1);
      expect(result.unresolvedRoutes[0]).toMatchObject({ framework: 'django', kind: 'path', path: '/page/', prefix: 'unknown', reason: 'unreadable-view' });
      expect(result.unresolvedRoutes[0]).not.toHaveProperty('handler');
      expect(result.unresolvedRoutes[0]).not.toHaveProperty('method');
      expect(result.unresolvedRoutes[0]).not.toHaveProperty('routeIndex');
    });
  it.each([
    ['missing name', '', 'missing'],
    ['external import', 'from external_package import page\n', 'page'],
    ['unread module', 'from .views import page\n', 'page'],
    ['ambiguous declaration', 'def page(request): pass\ndef page(request): pass\n', 'page'],
  ])('keeps an unresolved handler reason for %s', (_, declaration, expression) => {
    const result = one(declaration + `urlpatterns = [path('page/', ${expression})]\n`);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.unresolvedRoutes[0].reason).toBe('unresolved-handler');
  });
  it.each([
    ['class without methods', 'class Page:\n    pass\n', 'Page.as_view()'],
    ['class used without as_view', 'class Page:\n    def get(self): pass\n', 'Page'],
    ['function used as class', 'def page(request): pass\n', 'page.as_view()'],
  ])('distinguishes a present but unsupported view: %s', (_, declaration, expression) => {
    const result = one(declaration + `urlpatterns = [path('page/', ${expression})]\n`);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes[0]).toMatchObject({ reason: 'unsupported-view' });
  });
  it.each(["re_path(r'^page/(?P<id>[0-9]+)/$', missing)", "re_path('page/', missing)"])(
    'retains the written regex without interpreting it as a literal URL: %s', call => {
      const result = one(`urlpatterns = [${call}]\n`);
      expect(result.unresolvedRoutes).toHaveLength(1);
      expect(result.unresolvedRoutes[0]).toMatchObject({ kind: 'regex', prefix: 'unknown', reason: 'unresolved-handler' });
      expect(result.unresolvedRoutes[0].path).toBe(call.includes('(?P') ? '^page/(?P<id>[0-9]+)/$' : 'page/');
    });
  it('keeps a dynamic path unreadable', () => {
    expect(one('urlpatterns = [path(dynamic, missing)]\n').unresolvedRoutes[0]).toMatchObject({ kind: 'path', path: null, prefix: 'unknown' });
  });
  it('composes ordinary include prefixes without changing the original call evidence', () => {
    const text = setup + "urlpatterns = [path('資料/<int:id>/', missing)]\n";
    const result = join({ 'manage.py': '', 'pkg/settings.py': "ROOT_URLCONF = 'pkg.urls'", 'pkg/urls.py': setup + "urlpatterns = [path('api/', include('pkg.child'))]", 'pkg/child.py': text });
    expect(result.unresolvedRoutes).toHaveLength(1);
    const record = result.unresolvedRoutes[0];
    expect(record).toMatchObject({ path: '/api/資料/<int:id>/', prefix: 'known', basis: { range: { fileId: 'pkg/child.py', fileHash: 'hash-pkg/child.py' } } });
    expect(text.slice(record.basis.range.startUtf16, record.basis.range.endUtf16)).toBe("path('資料/<int:id>/', missing)");
  });
  it('retains each distinct include prefix for the same unresolved entry', () => {
    const result = join({ 'manage.py': '', 'pkg/urls.py': setup + "urlpatterns = [path('one/', include('pkg.child')), path('two/', include('pkg.child'))]", 'pkg/child.py': setup + "urlpatterns = [path('x/', missing)]" });
    expect(result.unresolvedRoutes.map(record => record.path).sort()).toEqual(['/one/x/', '/two/x/']);
  });
  it.each([
    ["static('/media/')", '/media/', 'static-handler'],
    ["static('/media/', view=missing)", '/media/', 'unresolved-handler'],
    ['static(settings.MEDIA_URL)', null, 'static-handler'],
    ["static('')", '', 'static-handler'],
  ])('records conditional static serving: %s', (call, prefix, reason) => {
    const result = one(staticSetup + `urlpatterns = [] + ${call}\n`);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.unresolvedRoutes[0]).toMatchObject({ framework: 'django', kind: 'static', path: prefix, prefix: 'unknown', reason, conditional: true });
  });
  it('does not duplicate resolved ordinary, regex or explicit static handlers', () => {
    const result = one(staticSetup + "def page(request): pass\nurlpatterns = [path('page/', page), re_path('regex/', page)] + static('/media/', view=page)\n");
    expect(result.routes).toHaveLength(3);
    expect(result.unresolvedRoutes).toEqual([]);
  });
  it('does not recast a regex include as an unresolved handler', () => {
    const result = one("urlpatterns = [re_path('^api/', include('pkg.child'))]\n");
    expect(result.unfollowed).toBe(1);
    expect(result.unresolvedRoutes).toEqual([]);
  });
  it('preserves the valid-route budget when unresolved entries appear first', () => {
    const result = join({ 'pkg/urls.py': setup + "def page(request): pass\nurlpatterns = [path('missing/', missing), path('page/', page)]\n" }, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].handler.name).toBe('page');
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.cut).toBe(false);
  });
  it('caps unresolved output independently and still returns a later valid handler', () => {
    const entries = Array.from({ length: 1001 }, (_, i) => `path('${i}/', missing)`);
    const result = join({ 'pkg/urls.py': setup + `def page(request): pass\nurlpatterns = [${entries.join(',')}, path('page/', page)]\n` }, 1);
    expect(result.unresolvedRoutes).toHaveLength(1000);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].handler.name).toBe('page');
    expect(result.cut).toBe(true);
  });
  it('allows exactly the unresolved output limit without claiming a cut', () => {
    const result = one('urlpatterns = [' + Array.from({ length: 1000 }, (_, i) => `path('${i}/', missing)`).join(',') + ']\n');
    expect(result.unresolvedRoutes).toHaveLength(1000);
    expect(result.cut).toBe(false);
  });
  it('cancels default static records even though no handler is resolved', () => {
    expect(() => join({ 'pkg/urls.py': staticSetup + "urlpatterns = [] + static('/media/')" }, 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function prepare(text: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-unresolved-routes-')));
  roots.push(root);
  await mkdir(path.join(root, 'pkg'));
  await writeFile(path.join(root, 'pkg/__init__.py'), '');
  await writeFile(path.join(root, 'pkg/urls.py'), text);
  return { root, project: await scanProject(root, randomUUID()) };
}
describe('project unresolved route metadata', () => {
  it('returns exact original Unicode evidence and no fake route indices', async () => {
    const text = '# 🐍\n' + setup + "urlpatterns = [path('資料/', missing)]\n";
    const { root, project } = await prepare(text);
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.unresolvedRoutes).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/urls.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const record = result.unresolvedRoutes![0];
    expect(record.basis.range).toMatchObject({ fileId: file.id, fileHash: hash, startLine: 3, endLine: 3 });
    expect(text.slice(record.basis.range.startUtf16, record.basis.range.endUtf16)).toBe("path('資料/', missing)");
    expect(Object.keys(record).sort()).toEqual(['basis', 'framework', 'kind', 'path', 'prefix', 'reason']);
  });
  it('sets the project limitation flag when only unresolved output is cut', async () => {
    const { root, project } = await prepare(setup + 'urlpatterns = [' + Array.from({ length: 1001 }, (_, i) => `path('${i}/', missing)`).join(',') + ']\n');
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.unresolvedRoutes).toHaveLength(1000);
    expect(result.limited).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
  });
  it('excludes unresolved addresses, basis text and secrets from AI material without renumbering valid routes', async () => {
    const secret = 'NEVER_SEND_UNRESOLVED_SECRET';
    const { root, project } = await prepare(setup + `def page(request): pass\nurlpatterns = [path('${secret}/', missing), path('page/', page)]\n`);
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.unresolvedRoutes).toHaveLength(1);
    const withRecords = featureGuideMaterial(project, result);
    const { unresolvedRoutes: _omitted, ...withoutRecords } = result;
    expect(withRecords).toEqual(featureGuideMaterial(project, withoutRecords));
    expect(withRecords.material.routes).toHaveLength(1);
    expect(withRecords.material.routes[0].index).toBe(0);
    expect(JSON.stringify(withRecords)).not.toContain(secret);
  });
});

describe('unresolved route ordering and bounded display', () => {
  it('keeps ordinary, default static and explicit static records in source order', () => {
    const result = one(staticSetup + "urlpatterns = [path('first/', missing)] + static('/second/') + [re_path('third/', missing)] + static('/fourth/', view=missing)\n");
    expect(result.unresolvedRoutes.map(record => record.path)).toEqual(['/first/', '/second/', 'third/', '/fourth/']);
    const positions = result.unresolvedRoutes.map(record => record.basis.range.startUtf16);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  it('caps prefix products without consuming the independent valid-route output', () => {
    const includes = Array.from({ length: 30 }, (_, i) => `path('p${i}/', include('pkg.child'))`);
    const missing = Array.from({ length: 40 }, (_, i) => `path('x${i}/', missing)`);
    const result = join({
      'manage.py': '',
      'pkg/urls.py': setup + `def page(request): pass\nurlpatterns = [path('page/', page), ${includes.join(',')}]\n`,
      'pkg/child.py': setup + `urlpatterns = [${missing.join(',')}]\n`,
    }, 1);
    expect(result.unresolvedRoutes).toHaveLength(1000);
    expect(new Set(result.unresolvedRoutes.map(record => record.path)).size).toBe(1000);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/page/', handler: { name: 'page' } });
    expect(result.cut).toBe(true);
  });
  it.each([
    ['length boundary', 'x'.repeat(300), 'x'.repeat(300)],
    ['excess length', 'x'.repeat(301), null],
    ['segment boundary', 'x/'.repeat(30), 'x/'.repeat(30)],
    ['excess segments', 'x/'.repeat(31), null],
  ])('bounds raw regex display at %s without trimming', (_, regex, expected) => {
    const result = one(`urlpatterns = [re_path(r'${regex}', missing)]\n`);
    expect(result.unresolvedRoutes).toHaveLength(1);
    expect(result.unresolvedRoutes[0]).toMatchObject({ kind: 'regex', path: expected, prefix: 'unknown' });
    expect(result.routes).toEqual([]);
  });
  it('does not change resolved raw regex paths while adding unresolved display', () => {
    const result = one("def page(request): pass\nurlpatterns = [re_path(r'^x/\\d+/$', page), re_path(r'^x/\\d+/$', missing)]\n");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: null, unmatched: true });
    expect(result.unresolvedRoutes[0]).toMatchObject({ path: '^x/\\d+/$', kind: 'regex', prefix: 'unknown' });
  });
  it('displays an incomplete regex expression as written without interpreting or executing it', () => {
    const result = one("urlpatterns = [re_path(r'^(unfinished[', missing)]\n");
    expect(result.unresolvedRoutes[0]).toMatchObject({ path: '^(unfinished[', kind: 'regex', prefix: 'unknown' });
    expect(result.routes).toEqual([]);
  });
  it('observes cancellation while expanding a large unresolved prefix product', () => {
    const includes = Array.from({ length: 30 }, (_, i) => `path('p${i}/', include('pkg.child'))`);
    const entries = Array.from({ length: 40 }, (_, i) => `path('x${i}/', missing)`);
    let checks = 0;
    expect(() => join({ 'manage.py': '',
      'pkg/urls.py': setup + `urlpatterns = [${includes.join(',')}]`,
      'pkg/child.py': setup + `urlpatterns = [${entries.join(',')}]`,
    }, 1000, () => ++checks >= 200)).toThrow('주소 찾기를 취소했어요.');
    expect(checks).toBe(200);
  });
  it.each(['lambda request: value', 'build_view()'])(
    'labels explicit unreadable static view as unresolved-handler: %s', expression => {
      const result = one(staticSetup + `urlpatterns = [] + static('/media/', view=${expression})\n`);
      expect(result.unresolvedRoutes).toHaveLength(1);
      expect(result.unresolvedRoutes[0]).toMatchObject({ kind: 'static', reason: 'unresolved-handler', conditional: true });
    });
  it('counts repeated unresolved evidence toward the result payload bound', () => {
    const result = one("urlpatterns = [path('page/', missing)]\n");
    expect(() => assertResultSize(result)).not.toThrow();
    const basis = { ...result.unresolvedRoutes[0].basis, text: '한'.repeat(2000) };
    const large = { ...result, unresolvedRoutes: Array.from({ length: 1000 }, () => ({ ...result.unresolvedRoutes[0], basis })) };
    expect(() => assertResultSize(large)).toThrow('결과가 너무 커서 보여 주지 않았어요.');
    expect(() => assertResultSize({ ...large, unresolvedRoutes: [] })).not.toThrow();
  });
  it('does not fabricate Django records when a helper was shadowed', () => {
    const result = one("path = other\nurlpatterns = [path('page/', missing)]\n");
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toEqual([]);
  });
  it('does not fabricate basis records for declarations beyond the traversal budget', () => {
    const text = setup + "urlpatterns = [path('page/', missing)]\n";
    const file = { id: 'urls', relativePath: 'pkg/urls.py', size: 0 };
    const data = djangoFile(file, walkPython(text, file.relativePath, 1), 'hash', { entries: 1000, views: 1000 });
    const files = new Map([[file.relativePath, data]]);
    const result = djangoRoutes(files, new Set(files.keys()), 1000, () => false, false);
    expect(result.routes).toEqual([]);
    expect(result.unresolvedRoutes).toEqual([]);
  });
});
