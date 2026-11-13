import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { djangoFile, djangoRoutes, type DjangoFile, type DjangoRoom } from '../src/core/analysis/django-routes';
import { walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { readAllowed, scanProject } from '../src/core/project/files';
import { MAP_LIMITS } from '../src/core/analysis/project-map';

const source = { id: 'urls', relativePath: 'pkg/urls.py', size: 0 };
const staticImport = 'from django.conf.urls.static import static as assets\n';
const find = (text: string, room: DjangoRoom = { entries: 5000, views: 20000 }, nodes = 100000) =>
  djangoFile(source, walkPython(text, source.relativePath, nodes), 'hash', room);
const join = (sources: Record<string, string>, max = 1000, stop = () => false) => {
  const files = new Map<string, DjangoFile>(Object.entries(sources).map(([relativePath, text]) => [relativePath,
    djangoFile({ id: relativePath, relativePath, size: 0 }, walkPython(text, relativePath, 100000), 'hash', { entries: 5000, views: 20000 })]));
  return djangoRoutes(files, new Set(files.keys()), max, stop, true);
};

describe('Django legacy url and static list additions', () => {
  it.each(['url(view=page)', 'url("page/")', 'url()'])('requires both legacy regex and view arguments: %s', call => {
    const text = 'from django.conf.urls import url\ndef page(request): pass\nurlpatterns = [' + call + ']\n';
    expect(find(text).entries).toEqual([]);
    expect(join({ 'pkg/urls.py': text }).routes).toEqual([]);
  });

  it.each(['consume(assets)', 'assets.__code__ = other', 'setattr((assets), "__code__", other)'])(
    'withholds a static helper changed or passed inside a function: %s', effect => {
      const text = staticImport + `def mutate():\n    ${effect}\nmutate()\ndef serve(request): pass\nurlpatterns = [] + assets('/media/', view=serve)\n`;
      expect(find(text).staticAdditions).toEqual([]);
      expect(join({ 'pkg/urls.py': text }).routes).toEqual([]);
    });
  it.each([
    ["urlpatterns = [] + assets('/media/', view=serve)\n", staticImport],
    ["urlpatterns = [old('media/', serve)]\n", 'from django.conf.urls import url as old\n'],
  ])('does not resolve a registration before its helper import', (statement, imported) => {
    const text = 'def serve(request): pass\n' + statement + imported;
    expect(join({ 'pkg/urls.py': text }).routes).toEqual([]);
    expect(find(text).staticAdditions).toEqual([]);
  });

  it.each([
    "url(r'^users/(?P<id>[0-9]+)/$', view)",
    "url(regex='users/', view=view)",
    "old(regex=r'^users/$', view=view)",
  ])('keeps legacy regex calls unmatched: %s', call => {
    const result = find('from django.conf.urls import url, url as old\ndef view(request): pass\nurlpatterns = [' + call + ']\n');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ shape: { unmatched: true }, view: { local: 'view', attribute: null, asView: false } });
    expect(result.entries[0].shape.segments).toBeUndefined();
    expect(result.entries[0].basis.text).toBe(call);
  });
  it('counts legacy regex include without pretending it is a literal prefix', () => {
    const result = find("from django.conf.urls import url as old, include as nest\nurlpatterns = [old(r'^api/', nest('pkg.child'))]\n");
    expect(result).toMatchObject({ entries: [], includes: [], unfollowed: 1 });
  });
  it.each([
    "urlpatterns = []\nurlpatterns += assets('/media/')",
    "urlpatterns = [] + assets('/media/')",
    "urlpatterns = []\nurlpatterns += [] + assets('/media/')",
  ])('reads only a static addition leaf: %s', statement => {
    const result = find(staticImport + statement);
    expect(result.staticAdditions).toHaveLength(1);
    expect(result.staticAdditions[0]).toMatchObject({ prefix: '/media/', defaultView: true, view: null });
    expect(result.entries).toEqual([]);
  });
  it('keeps default and explicit views distinct and preserves Unicode call evidence', () => {
    const text = '# 🐍\n' + staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/자료/', view=serve, document_root='자료')\n";
    const addition = find(text).staticAdditions[0];
    expect(addition).toMatchObject({ prefix: '/자료/', defaultView: false, view: { local: 'serve', attribute: null, asView: false } });
    expect(addition.basis.range).toMatchObject({ fileId: source.id, fileHash: 'hash', startLine: 4, endLine: 4 });
    expect(text.slice(addition.basis.range.startUtf16, addition.basis.range.endUtf16)).toBe("assets('/자료/', view=serve, document_root='자료')");
  });
  it.each([
    "urlpatterns = [assets('/media/')]",
    "other = [] + assets('/media/')",
    "def configure():\n    urlpatterns = [] + assets('/media/')",
    "if enabled:\n    urlpatterns = [] + assets('/media/')",
  ])('does not turn unrelated or nested static calls into additions: %s', statement => {
    expect(find(staticImport + statement).staticAdditions).toEqual([]);
  });
  it.each([
    'assets = other\n',
    'assets.__call__ = other\n',
    'from elsewhere import static as assets\n',
  ])('does not trust changed helper identity: %s', change => {
    expect(find(staticImport + change + "urlpatterns = [] + assets('/media/')").staticAdditions).toEqual([]);
  });
  it('does not trust a conditional helper import', () => {
    expect(find("if enabled:\n    from django.conf.urls.static import static as assets\nurlpatterns = [] + assets('/media/')").staticAdditions).toEqual([]);
  });
  it.each(["assets('/a/', prefix='/b/')", "assets(*args)", "assets('/a/', **options)"])(
    'does not invent a view for an unbound call: %s', call => {
      const result = join({ 'pkg/urls.py': staticImport + 'urlpatterns = [] + ' + call });
      expect(result.routes).toEqual([]);
    });
  it('does not promote urlpatterns certainty after a later overwrite', () => {
    const result = find(staticImport + "urlpatterns = [] + assets('/media/')\nurlpatterns = replacement\n");
    expect(result.listFinal).toBe(false);
  });
  it('charges static metadata and ordinary entries to the same entry budget', () => {
    const room: DjangoRoom = { entries: 1, views: 20000 };
    const result = find(staticImport + "from django.urls import path\ndef view(request): pass\nurlpatterns = [] + assets('/media/') + [path('x/', view)]\n", room);
    expect(result.staticAdditions.length + result.entries.length).toBe(1);
    expect(room).toMatchObject({ entries: 0, entriesCut: true });
  });
  it('never creates matchable static paths from dynamic, empty or external prefixes', () => {
    for (const prefix of ['settings.MEDIA_URL', "''", "'https://example.invalid/media/'"]) {
      const result = join({ 'pkg/urls.py': staticImport + `def serve(request): pass\nurlpatterns = [] + assets(${prefix}, view=serve)\n` });
      expect(result.routes.every(route => route.path === null && route.unmatched === true)).toBe(true);
    }
    expect(find(staticImport + 'urlpatterns = [] + assets(settings.MEDIA_URL)').staticAdditions[0].prefix).toBeNull();
  });
  it('does not trim an oversized prefix into a believable route', () => {
    const result = join({ 'pkg/urls.py': staticImport + `def serve(request): pass\nurlpatterns = [] + assets('${'a'.repeat(400)}', view=serve)\n` });
    expect(result.routes.every(route => route.path === null && route.unmatched === true)).toBe(true);
  });
  it('keeps explicit static views unmatched while retaining ordinary entries', () => {
    const result = join({ 'pkg/urls.py': staticImport + "from django.urls import path\ndef page(request): pass\ndef serve(request): pass\nurlpatterns = [path('page/', page)] + assets('/media/', view=serve)\n" });
    expect(result.routes.find(route => route.handler.name === 'page')).toMatchObject({ path: '/page/' });
    expect(result.routes.find(route => route.handler.name === 'serve')).toMatchObject({ path: null, unmatched: true });
  });
  it('honors the output cap when explicit static views would create additional routes', () => {
    const result = join({ 'pkg/urls.py': staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/a/', view=serve) + assets('/b/', view=serve)\n" }, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });
  it('accepts the explicit second positional view without inventing a default handler', () => {
    const result = find(staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/media/', serve)\n");
    expect(result.staticAdditions).toHaveLength(1);
    expect(result.staticAdditions[0]).toMatchObject({ defaultView: false, view: { local: 'serve', attribute: null, asView: false } });
  });
  it('counts recognized additions separately from default or unresolved serving', () => {
    const result = join({ 'pkg/urls.py': staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/a/') + assets('/b/', view=serve) + assets('/c/', view=missing)\n" });
    expect(result).toMatchObject({ staticAdditions: 3, staticUnresolved: 2 });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].handler.name).toBe('serve');
  });
  it('does not resolve views when the source traversal was incomplete', () => {
    const text = staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/media/', view=serve)\n";
    const data = find(text, { entries: 5000, views: 20000 }, 1);
    expect(data.plain).toBe(false);
    const files = new Map([[source.relativePath, data]]);
    expect(djangoRoutes(files, new Set(files.keys()), 1000, () => false, true).routes).toEqual([]);
  });
  it('cancels before resolving explicit static views', () => {
    expect(() => join({ 'pkg/urls.py': staticImport + "def serve(request): pass\nurlpatterns = [] + assets('/media/', view=serve)\n" }, 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function prepare(sources: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-django-static-')));
  roots.push(root);
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', ...sources })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return { root, project: await scanProject(root, randomUUID()) };
}
describe('Django additional registration project evidence', () => {
  it('reports default static serving without fabricating a project handler', async () => {
    const { root, project } = await prepare({ 'pkg/urls.py': staticImport + "urlpatterns = [] + assets('/media/', document_root='media')\n" });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });
  it.each([false, true])('uses the actual %s imported view source and original registration basis', async imported => {
    const view = '@csrf_exempt\ndef 자료(request):\n    return 1\n';
    const urls = staticImport + (imported ? 'from .views import 자료 as serve\n' : view) + `urlpatterns = [] + assets('/자료/', view=${imported ? 'serve' : '자료'})\n`;
    const { root, project } = await prepare({ 'pkg/urls.py': urls, ...(imported ? { 'pkg/views.py': view } : {}) });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ framework: 'django', path: null, unmatched: true, handler: { name: '자료' } });
    const origin = project.files.find(file => file.relativePath === (imported ? 'pkg/views.py' : 'pkg/urls.py'))!;
    const data = await readAllowed(root, origin.relativePath);
    const symbol = analyzeSource(data.text, origin.relativePath, { projectId: project.id, fileId: origin.id, fileHash: data.hash }).symbols.find(symbol => symbol.name === '자료')!;
    expect(result.routes[0].handler).toMatchObject({ fileId: origin.id, fileHash: data.hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const urlFile = project.files.find(file => file.relativePath === 'pkg/urls.py')!;
    const urlData = await readAllowed(root, urlFile.relativePath);
    expect(result.routes[0].basis.range).toMatchObject({ fileId: urlFile.id, fileHash: urlData.hash });
    expect(urlData.text.slice(result.routes[0].basis.range.startUtf16, result.routes[0].basis.range.endUtf16)).toContain('assets(');
    expect(data.text).toBe(imported ? view : urls);
  });
  it('keeps legacy regex handlers outside confirmed request matching', async () => {
    const { root, project } = await prepare({ 'pkg/urls.py': "from django.conf.urls import url\ndef page(request): pass\nurlpatterns = [url(regex='page/', view=page)]\n" });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ unmatched: true, handler: { name: 'page' } });
    expect(result.links.some(link => link.sure)).toBe(false);
  });
  it('does not expose a handler from an incomplete project read', async () => {
    const { root, project } = await prepare({ 'pkg/urls.py': staticImport + "from .views import serve\nurlpatterns = [] + assets('/media/', view=serve)\n", 'pkg/views.py': 'def serve(request): pass\n' });
    const result = await findProjectRoutes(root, project.id, project.files, { ...MAP_LIMITS, files: 0 });
    expect(result.routes).toEqual([]);
    expect(result.limited).toBe(true);
  });
});

describe('Django additional registration argument boundaries', () => {
  it.each([
    "url('x/', view, regex='y/')",
    "url('x/', view, view=view)",
    "url(regex='x/', regex='y/', view=view)",
    "url('x/', view, *extra)",
    "url('x/', view, **extra)",
    "url('x/', view, None, 'name', 'extra')",
    "url('x/', view, unexpected=True)",
  ])('does not invent a handler from an invalid legacy signature: %s', call => {
    const result = join({ 'pkg/urls.py': 'from django.conf.urls import url\ndef view(request): pass\nurlpatterns = [' + call + ']\n' });
    expect(result.routes).toEqual([]);
  });
  it('accepts ordinary legacy positional arguments followed by supported keywords', () => {
    const result = join({ 'pkg/urls.py': "from django.conf.urls import url\ndef view(request): pass\nurlpatterns = [url('x/', view=view, kwargs=None, name='page')]\n" });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: 'x/', unmatched: true, handler: { name: 'view' } });
  });
  it.each([
    'assets(view=serve)',
    "assets('/media/', serve, view=serve)",
    "assets('/media/', document_root='a', document_root='b')",
    "assets(view=serve, '/media/')",
  ])('omits metadata for an invalid static signature: %s', call => {
    expect(find(staticImport + 'def serve(request): pass\nurlpatterns = [] + ' + call + '\n').staticAdditions).toEqual([]);
  });
  it('preserves an exact 300-character prefix but never truncates a longer one', () => {
    const short = '/' + 'a'.repeat(299);
    const result = find(staticImport + `urlpatterns = [] + assets('${short}') + assets('${short}b')\n`);
    expect(result.staticAdditions.map(addition => addition.prefix)).toEqual([short, null]);
  });
  it('does not restore root certainty for a list containing default static additions', () => {
    const sources = {
      'manage.py': '', 'pkg/settings.py': "ROOT_URLCONF = 'pkg.urls'\n",
      'pkg/urls.py': "from django.urls import path\ndef page(request): pass\nurlpatterns = [path('page/', page)]\n",
      'separate/urls.py': staticImport + "urlpatterns = [] + assets('/other/')\n",
    };
    expect(join(sources).routes.find(route => route.handler.name === 'page')).toMatchObject({ prefix: 'known' });
    const changed = join({ ...sources, 'pkg/urls.py': staticImport + sources['pkg/urls.py'] + "urlpatterns += assets('/media/')\n" });
    expect(changed.routes.find(route => route.handler.name === 'page')).toMatchObject({ path: '/page/', prefix: 'unknown' });
  });
  it('cancels a default-static-only scan without resolving any fake handler', () => {
    expect(() => join({ 'pkg/urls.py': staticImport + "urlpatterns = [] + assets('/media/')\n" }, 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
  });
  it.each(['def patch():\n    assets.__call__ = other\npatch()\n', 'saved = assets\n'])('rejects helper mutation or escape outside the registration: %s', change => {
    expect(find(staticImport + change + "urlpatterns = [] + assets('/media/')\n").staticAdditions).toEqual([]);
  });
});
