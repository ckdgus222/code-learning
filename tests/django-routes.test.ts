import { describe, expect, it, vi } from 'vitest';
import { djangoFile, djangoRoutes, type DjangoFile } from '../src/core/analysis/django-routes';
import * as pythonImports from '../src/core/analysis/python-imports';
import { walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { matchFunction } from '../src/renderer/map-layout';
import type { SourceView } from '../src/shared/contracts';

const file = { id: 'urls', relativePath: 'polls/urls.py', size: 0 };
const setup = 'from django.urls import path, re_path, include\nfrom . import views\n';
const find = (text: string, room = { entries: 5000, views: 20000 }, nodes = 100000, source = file) =>
  djangoFile(source, walkPython(text, source.relativePath, nodes), 'hash', room);
const entry = (view = 'views.results', path = "'polls/<int:question_id>/results/'") => `urlpatterns = [path(${path}, ${view})]\n`;

describe('Django urlconf entries', () => {
  it.each([
    "other = [path('x/', views.x)]", "urlpatterns -= [path('x/', views.x)]", "urlpatterns = [path('x/', views.x)] * 2",
    "patterns = []\npatterns += [path('x/', views.x)]",
  ])('reads only lists added to urlpatterns with = or +=: %s', code => {
    expect(find(setup + code).entries).toEqual([]);
  });
  it('treats an overwritten include as an unreadable view, not as an include', () => {
    const result = find(setup + "include = other\nurlpatterns = [path('x/', include('y'))]");
    expect(result.includes).toEqual([]);
    expect(result.unfollowed).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].view).toBeNull();
  });
  it('accepts only as_view as a call on a view', () => {
    expect(find(setup + entry('views.Detail.build()')).entries[0].view).toBeNull();
    expect(find(setup + entry('views.Detail.as_view()')).entries[0].view).toEqual({ local: 'views', attribute: 'Detail', asView: true });
  });
  it('never gives a re_path a matchable shape, even when its pattern looks like plain text', () => {
    const result = find(setup + "urlpatterns = [re_path('users/', views.x)]");
    expect(result.entries[0]).toMatchObject({ path: 'users/', shape: { unmatched: true } });
    expect(result.entries[0].shape.segments).toBeUndefined();
  });
  it('drops a handler method that the class body assigns or deletes after writing it', () => {
    const cls = (extra: string) => find(`class Detail:\n    def get(self): pass\n    def post(self): pass\n${extra}`).views.get('Detail');
    expect(cls('')).toMatchObject({ methods: [{ method: 'GET' }, { method: 'POST' }] });
    expect(cls('    get = replacement')).toMatchObject({ kind: 'class', methods: [{ method: 'POST' }] });
    expect(cls('    del post')).toMatchObject({ kind: 'class', methods: [{ method: 'GET' }] });
    expect(cls('    get, post = a, b')).toMatchObject({ kind: 'class', methods: [] });
    expect(find('class Detail:\n    put = other\n    def put(self): pass').views.get('Detail')).toMatchObject({ methods: [] });
    expect(cls('    def helper(self):\n        get = 1')).toMatchObject({ methods: [{ method: 'GET' }, { method: 'POST' }] });
    // An attribute or keyword called `get` belongs to another object.
    expect(cls('    queryset = Model.objects.get(pk=1)\n    extra = build(post=1)')).toMatchObject({ methods: [{ method: 'GET' }, { method: 'POST' }] });
  });
  it('stays fast and confirms nothing when a class body nests its targets far deeper than real code', () => {
    // 20,000 names inside 190 nested lists took 40 s before the walk stopped at a fixed depth.
    const text = 'class Detail:\n    def get(self): pass\n    ' + '['.repeat(190) + 'get, '.repeat(20_000) + ']'.repeat(190) + ' = value\n';
    const started = performance.now();
    const result = find(text, { entries: 5000, views: 20000 }, 200_000);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ plain: false, odd: false });
    expect(result.views.size).toBe(0);
  });
  it('leaves out a class whose body statements mention more names than the budget', () => {
    const cls = (count: number) => find(`class Detail:\n    def get(self): pass\n    values = [${'1, '.repeat(count)}]\nclass Other:\n    def post(self): pass`).views;
    expect([...cls(100).keys()]).toEqual(['Detail', 'Other']);
    expect([...cls(3000).keys()]).toEqual(['Other']);
  });
  it('follows a module attribute only a few levels up', () => {
    const chain = (attributes: string) => find(setup + `urlpatterns = [path('a/', ${attributes}), path('x/', views.x)]`).imports.has('views');
    expect(chain('views.a.b')).toBe(true);
    expect(chain('views.a.b.c.d.e')).toBe(false);
  });
  it('does not trust an imported name whose attributes are set by name', () => {
    expect(find(setup + "setattr(views, 'results', other)\n" + entry()).imports.has('views')).toBe(false);
    expect(find(setup + "delattr(views.Detail, 'get')\n" + entry()).imports.has('views')).toBe(false);
    expect(find(setup + "setattr(other, 'results', x)\n" + entry()).imports.has('views')).toBe(true);
  });
  it('does not keep an import path deeper than any real module, and stops resolving on cancel', () => {
    // 70,000 parts shared by 5,000 names took 17 s to resolve before the depth limit. A smaller path of the same
    // shape is enough here: what matters is that no import deeper than the limit is kept to be resolved.
    const names = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const text = `from django.urls import path\nfrom ${Array.from({ length: 2000 }, () => 'a').join('.')} import ${names.join(', ')}\n`
      + `urlpatterns = [${names.map(name => `path('${name}/', ${name})`).join(', ')}]\n`;
    const data = find(text);
    expect(data.entries).toHaveLength(200);
    expect(data.imports.size).toBe(0);
    const files = new Map([[file.relativePath, data]]);
    expect(djangoRoutes(files, new Set(files.keys()), 1000, () => false)).toMatchObject({ routes: [], skipped: 200 });
    const kept = find(setup + entry());
    // A cancel is seen before an import is resolved, not only when the entries are walked afterwards.
    const resolve = vi.spyOn(pythonImports, 'resolvePythonImport');
    expect(() => djangoRoutes(new Map([[file.relativePath, kept]]), new Set([file.relativePath]), 1000, () => true)).toThrow('주소 찾기를 취소했어요.');
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
    expect(find('from django.urls import path\nfrom ' + Array.from({ length: 31 }, () => 'a').join('.') + ' import v\n' + entry('v')).imports.has('v')).toBe(false);
    expect(find('from django.urls import path\nfrom ' + Array.from({ length: 30 }, () => 'a').join('.') + ' import v\n' + entry('v')).imports.has('v')).toBe(true);
  });
  it('reads lowercase handler methods only, charges each class and ignores other decorators', () => {
    const classes = find('class A:\n    def GET(self): pass\n    def Post(self): pass\n    def get(self): pass\nclass B:\n    def post(self): pass', { entries: 5000, views: 1 });
    expect([...classes.views.keys()]).toEqual(['A']);
    expect(classes.views.get('A')).toMatchObject({ kind: 'class', methods: [{ method: 'GET', handler: { name: 'A.get' } }] });
    const decorated = find('@login_required\n@require_POST\ndef x(request): pass\n@csrf_exempt\ndef y(request): pass');
    expect(decorated.views.get('x')).toMatchObject({ methods: ['POST'] });
    expect(decorated.views.get('y')).toMatchObject({ methods: ['ALL'] });
  });
  it('keeps the literal path, view import and call evidence', () => {
    const text = setup + entry();
    const result = find(text);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: '/polls/<int:question_id>/results/', shape: {
      segments: [{ text: 'polls' }, { param: 'question_id' }, { text: 'results' }], typed: true },
      view: { local: 'views', attribute: 'results', asView: false }, basis: { text: "path('polls/<int:question_id>/results/', views.results)" } });
    const basis = result.entries[0].basis;
    expect(text.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
    expect(basis.range).toMatchObject({ fileId: file.id, fileHash: 'hash', startLine: 3, endLine: 3 });
    expect(result.imports.get('views')).toEqual({ level: 1, module: [], names: ['views'] });
  });
  it.each([
    ['results', 'results', null, false], ['views.results', 'views', 'results', false],
    ['Detail.as_view()', 'Detail', null, true], ["views.Detail.as_view(template_name='x')", 'views', 'Detail', true],
  ])('reads view %s', (view, local, attribute, asView) => {
    expect(find(setup + entry(view)).entries[0].view).toEqual({ local, attribute, asView });
  });
  it.each(['lambda r: x', 'views.a.b', '"polls.views.detail"', 'some()(x)', 'Detail.as_view(dispatch=actual)',
    'Detail.as_view(setup=x)', "Detail.as_view(http_method_names=['get'])", 'Detail.as_view(**options)',
    'Detail.as_view(*args)', 'Detail.as_view(x)'])('rejects view %s', view => {
    expect(find(setup + entry(view)).entries[0].view).toBeNull();
  });
  it('reads only direct list entries of top-level assignments and additions', () => {
    const text = setup + `
urlpatterns = [path('a', views.results)] + static('x')
urlpatterns += [path('b', views.results)] + [path('c', views.results)]
urlpatterns = make()
urlpatterns = [path('d', views.results) for x in xs]
urlpatterns.append(path('e', views.results))
urlpatterns = [[path('f', views.results)], *router.urls]
def make():
    urlpatterns = [path('g', views.results)]
class Other:
    urlpatterns = [path('h', views.results)]
if True:
    urlpatterns = [path('i', views.results)]
`;
    expect(find(text).entries.map(entry => entry.path)).toEqual(['/a', '/b', '/c']);
  });
  it('counts include calls separately and ignores the old url function', () => {
    const result = find(setup + "urlpatterns = [path('polls/', include('polls.urls')), path('', include(router.urls)), url('x', views.x)]");
    expect(result.entries).toEqual([]);
    expect(result.includes).toEqual([{ written: 'polls/', module: ['polls', 'urls'] }]);
    expect(result.unfollowed).toBe(1);
  });
  it('recognizes aliases, keywords and normalized identifiers', () => {
    const result = find("from django.urls import path as p, re_path as r\nurlpatterns = [p(route='x/', view=views.x), r('^x/$', views.x)]");
    expect(result.entries.map(entry => entry.path)).toEqual(['/x/', '^x/$']);
    expect(result.entries[1].shape).toEqual({ unmatched: true });
    expect(find(setup + "urlpatterns = [ｐａｔｈ('x/', views.x)]").entries).toHaveLength(1);
  });
  it.each(['from pathlib import path', 'from other import path', 'if True:\n    from django.urls import path'])('ignores wrong import %s', imports => {
    expect(find(imports + '\n' + entry()).entries).toEqual([]);
  });
  it.each(['path = other', 'def path(): pass', 'def f():\n    global path', 'p = path', 'from other import path'])('invalidates Django name: %s', change => {
    expect(find(setup + entry() + change).entries).toEqual([]);
  });
  it.each(["f'x'", "r'x'", 'VALUE', "'x'.upper()", `'${'a'.repeat(301)}'`, `'${'a/'.repeat(31)}'`])('leaves unreadable path unknown: %s', path => {
    expect(find(setup + entry('views.results', path)).entries[0].path).toBeNull();
  });
  it.each([
    ['', []], ['users/', [{ text: 'users' }]], ['users', [{ text: 'users' }]],
    ['<id>/', [{ param: 'id' }]], ['<str:id>/', [{ param: 'id' }]],
    ['files/<path:p>', [{ text: 'files' }, { catchAll: 'p', optional: false }]],
  ])('reads path %s', (path, segments) => {
    expect(find(setup + entry('views.x', `'${path}'`)).entries[0]).toMatchObject({ path: '/' + path, shape: { segments } });
    expect(find(setup + entry('views.x', `'${path}'`)).entries[0].shape.typed).toBeUndefined();
  });
  it.each(['int:id', 'slug:s', 'uuid:u'])('marks converter %s typed', converter => {
    expect(find(setup + entry('views.x', `'<${converter}>/'`)).entries[0].shape).toEqual({ segments: [{ param: converter.split(':')[1] }], typed: true });
  });
  it.each(['/users/', 'users//x', 'v<int:n>/', '<a>-<b>/', 'files/<path:p>/meta', 'files/<path:p>/', '<regex:x>/', '<사용자>/', 'a b/'])('does not match path %s', path => {
    expect(find(setup + entry('views.x', `'${path}'`)).entries[0].shape).toEqual({ unmatched: true });
  });
  it.each(['*args', '**kwargs'])('does not match spread %s', spread => {
    expect(find(setup + `urlpatterns = [path('x', views.x, ${spread})]`).entries[0].shape).toEqual({ unmatched: true });
  });
});

describe('Django view definitions', () => {
  it('uses analyzer ranges for decorated functions and class methods', () => {
    const text = '@login_required\nasync def results(request): return 1\nclass Detail(View):\n    @decorate\n    def get(self, request): return 2\n    def post(self, request): return 3\n    def head(self): pass\n    def options(self): pass\n';
    const result = find(text);
    const analysis = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: 'hash' });
    const fn = result.views.get('results')!, cls = result.views.get('Detail')!;
    expect(fn.kind).toBe('function'); expect(cls.kind).toBe('class');
    const handlers = [...(fn.kind === 'function' ? [fn.handler] : []), ...(cls.kind === 'class' ? cls.methods.map(method => method.handler) : [])];
    expect(handlers.map(handler => handler.name)).toEqual(['results', 'Detail.get', 'Detail.post']);
    for (const handler of handlers) {
      const symbol = analysis.symbols.find(symbol => symbol.name === handler.name)!;
      expect(handler).toMatchObject({ startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
      expect(matchFunction({ fileId: file.id, hash: 'hash', analysis } as SourceView, handler).status).toBe('found');
    }
  });
  it.each([
    ['', ['ALL']], ['@require_GET', ['GET']], ['@require_POST', ['POST']], ['@require_safe', ['GET']],
    ['@require_http_methods(["GET", "POST", "GET"])', ['GET', 'POST']], ['@http.require_http_methods(("put",))', ['PUT']],
    ["@api_view(['GET', 'DELETE'])", ['GET', 'DELETE']], ['@api_view()', ['GET']],
    ['@require_http_methods(METHODS)', ['ALL']], ['@require_GET\n@require_POST', ['ALL']],
    ['@require_GET\n@require_http_methods', ['GET']], ['@require_POST\n@api_view', ['POST']],
    ['@login_required\n@csrf_exempt', ['ALL']], ['@require_http_methods(["HEAD"])', []],
    ['@require_http_methods(["GET", unknown])', ['ALL']], ['@require_http_methods({"PATCH"})', ['PATCH']],
    [`@require_http_methods(['GET', '${'UNKNOWN'.repeat(100)}'])`, ['GET']],
  ])('reads method restrictions: %s', (decorators, methods) => {
    expect(find(`${decorators}\ndef results(request): pass`).views.get('results')).toMatchObject({ kind: 'function', methods });
  });
  it.each(['results = wrap(results)', 'del results', 'other = results', 'def results(): pass', 'from x import results',
    'def other():\n    global results', "setattr(results, 'x', 1)", "delattr(results, 'x')", 'vars(results)'])('rejects changed function: %s', change => {
    const result = find(`def results(): pass\ndef retained(): pass\n${change}`);
    expect(result.views.has('results')).toBe(false);
    expect(result.views.has('retained')).toBe(true);
  });
  it.each(['Detail.get = other', 'handler = Detail.get', "setattr(Detail, 'get', other)", "delattr(Detail, 'get')", 'vars(Detail.get)'])('rejects changed class: %s', change => {
    expect(find(`class Detail(View):\n    def get(self): pass\n${change}`).views.has('Detail')).toBe(false);
  });
  it('permits view reads, type positions and independent local variables', () => {
    const result = find(setup + `def results(): pass
class Detail(View):
    def get(self): pass
urlpatterns = [path('x/', results), path('y/', Detail.as_view())]
login_required(results)
results()
value: Detail
value: results
def other(results):
    results = 2
    Detail = 3
`);
    expect([...result.views.keys()]).toEqual(['results', 'Detail', 'other']);
  });
  it('ignores non-module definitions and long names', () => {
    const result = find(`if True:\n    def hidden(): pass\ndef outer():\n    def nested(): pass\ndef ${'a'.repeat(201)}(): pass`);
    expect([...result.views.keys()]).toEqual(['outer']);
  });
  it.each(['def as_view(cls): pass', 'as_view = other', 'def dispatch(self): pass', "http_method_names = ['get']", 'def setup(self): pass', 'as_view: object', 'as_view, other = pair'])('rejects dispatch override: %s', change => {
    expect(find(`class Detail(View):\n    def get(self): pass\n    ${change}`).views.has('Detail')).toBe(false);
  });
  it('keeps ordinary class properties and excludes duplicate methods', () => {
    expect(find("class Detail(View):\n    template_name = 'x'\n    def get_queryset(self): pass\n    def get(self): pass\n    def get(self): pass\n    def post(self): pass").views.get('Detail')).toMatchObject({ kind: 'class', methods: [{ method: 'POST', handler: { name: 'Detail.post' } }] });
  });
});

describe('Django safety and bounds', () => {
  it.each(['def broken(', '__getattr__ = f', "__import__('x')", '__builtins__', 'from .other import *', 'if True:\n    from .other import *'])('keeps entries but no views when not plain: %s', change => {
    const result = find(setup + entry() + 'def results(): pass\n' + change);
    expect(result.plain).toBe(false);
    expect(result.odd).toBe(false);
    expect(result.views.size).toBe(0);
    expect(result.entries).toHaveLength(1);
  });
  it('marks a truncated walk not plain and reads import-only initializers', () => {
    expect(find('def results(): pass', undefined, 2).plain).toBe(false);
    expect(find('value = 1\nfrom .views import results', undefined, undefined, { ...file, relativePath: 'polls/__init__.py' }).init).toEqual(new Set(['value', 'results']));
    expect(find('def local():\n    from x import *').plain).toBe(true);
  });
  it.each(['exec(code)', "globals()['x'] = y", 'eval(s)', 'locals()', "setattr(urlpatterns, 'x', y)", "delattr(path, 'x')", 'vars(path.x)', 'def f():\n    exec(code)'])('marks dynamic file odd: %s', change => {
    expect(find(setup + entry() + change)).toMatchObject({ plain: true, odd: true });
  });
  it.each(['model.eval()', 'run(eval=True)', 'setattr(obj, k, v)', '"exec"'])('ignores unrelated dynamic-looking text: %s', change => {
    expect(find(setup + entry() + change)).toMatchObject({ plain: true, odd: false });
  });
  it('spends only the available entry and view room, stopping include counting too', () => {
    const room = { entries: 2, views: 1 };
    const result = find(setup + "urlpatterns = [path('x', views.x), path('y', views.x), path('z', include('x')), path('w', views.x)]\ndef x(): pass\ndef y(): pass", room);
    expect(result.entries).toHaveLength(2); expect(result.includes).toEqual([]);
    expect(result.views.size).toBe(1); expect(room).toEqual({ entries: 0, views: 0, entriesCut: true, viewsCut: true });
    expect(find('def x(): pass', { entries: 0, views: 0 }).views.size).toBe(0);
    // Room that is used up exactly leaves nothing out, so nothing is reported as cut.
    const exact = { entries: 2, views: 1 };
    const all = find(setup + "urlpatterns = [path('x', views.x), path('y', views.x)]\ndef x(): pass", exact);
    expect(all.entries).toHaveLength(2);
    expect(exact).toEqual({ entries: 0, views: 0 });
  });
  it('cuts only when an actual extra route exists, and cancels skipped entries', () => {
    const data = find(setup + entry('results') + 'def results(): pass');
    const files = new Map([[file.relativePath, data]]), known = new Set(files.keys());
    expect(djangoRoutes(files, known, 1, () => false)).toMatchObject({ cut: false, skipped: 0, routes: [{ framework: 'django', prefix: 'unknown' }] });
    expect(djangoRoutes(files, known, 0, () => false)).toMatchObject({ cut: true, routes: [] });
    const skipped = find(setup + entry('lambda r: r'));
    let checks = 0;
    expect(() => djangoRoutes(new Map([[file.relativePath, { ...skipped, entries: [...skipped.entries, ...skipped.entries] }]]), known, 1, () => ++checks === 2)).toThrow('주소 찾기를 취소했어요.');
    expect(checks).toBe(2);
  });
});


it('reuses each resolved import and preserves file and entry order', () => {
  const source = { ...file, id: 'views', relativePath: 'polls/views.py' };
  const files = new Map([
    [source.relativePath, find('def results(): pass', undefined, undefined, source)],
    [file.relativePath, find(setup + "urlpatterns = [path('b/', views.results), path('a/', views.results)]")],
    ['polls/__init__.py', find('', undefined, undefined, { ...file, relativePath: 'polls/__init__.py' })],
  ]);
  const resolve = vi.spyOn(pythonImports, 'resolvePythonImport');
  try {
    const result = djangoRoutes(files, new Set(files.keys()), 2, () => false);
    expect(result.routes.map(route => route.path)).toEqual(['/b/', '/a/']);
    expect(result.cut).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally { resolve.mockRestore(); }
});

it('distinguishes a package value from a module and retains only used unique imports', () => {
  const data = find("from .views import results as r, index\nfrom .other import r\nurlpatterns = [path('x', r)]\nfrom django.urls import path");
  expect(data.imports.size).toBe(0);
  const source = { ...file, relativePath: 'polls/__init__.py' };
  const files = new Map([
    [file.relativePath, find(setup + entry('views.results'))],
    [source.relativePath, find('views = 1\ndef results(): pass', undefined, undefined, source)],
  ]);
  expect(djangoRoutes(files, new Set(files.keys()), 10, () => false)).toMatchObject({ routes: [], skipped: 1 });
});

it('keeps unsupported HTTP methods empty without counting their known handler as missing', () => {
  const data = find(setup + entry('results') + '@require_http_methods(["HEAD"])\ndef results(): pass');
  const files = new Map([[file.relativePath, data]]);
  expect(djangoRoutes(files, new Set(files.keys()), 10, () => false)).toMatchObject({ routes: [], skipped: 0, cut: false });
});

it('honors exact name and path boundaries before normalizing or splitting', () => {
  const name = 'a'.repeat(200);
  const result = find(setup + `def ${name}(): pass\nurlpatterns = [path('${'x'.repeat(299)}', ${name}), path('${'x'.repeat(300)}', ${name})]`);
  expect(result.views.has(name)).toBe(true);
  expect(result.entries.map(entry => entry.path?.length ?? null)).toEqual([300, null]);
  expect(find(setup + `urlpatterns = [path('x', ${name}a)]`).entries[0].view).toBeNull();
});

it('propagates cancellation even when no skipped entry could create a route', () => {
  const data = find(setup + entry('lambda r: r'));
  const files = new Map([[file.relativePath, data]]);
  expect(() => djangoRoutes(files, new Set(files.keys()), 0, () => true)).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
});

describe('literal Django includes', () => {
  it.each([
    "path('polls/', include('polls.urls'))",
    "path('polls/', include('polls.urls', namespace='polls'))",
    "path(route='polls/', view=include('polls.urls', namespace=name))",
  ])('keeps %s', call => {
    const room = { entries: 1, views: 0 };
    expect(find(setup + `urlpatterns = [${call}]`, room)).toMatchObject({
      entries: [], includes: [{ written: 'polls/', module: ['polls', 'urls'] }], unfollowed: 0,
    });
    expect(room).toEqual({ entries: 0, views: 0 });
  });
  it.each([
    "path('x/', include(router.urls))", "path('x/', include(imported))",
    "path('x/', include((patterns, 'app')))", "path('x/', include([path('x/', views.x)]))",
    "path('x/', include('a.b', 'extra'))", "path('x/', include('a.b', other=1))",
    "path('x/', include(*args))", "path('x/', include('a.b', **kwargs))",
    "re_path('^x/', include('a.b'))", "path(route, include('a.b'))",
    "path('x/', include('a.b'), *extra)", "path('x/', include('a.b'), **extra)",
    "path('x/', include('a..b'))", "path('x/', include('a.1b'))", "path('x/', include(''))",
    "path('x/', include(f'a.b'))", "path(f'x/', include('a.b'))",
    "path('x/', include('a-b'))", "path('x/', include('앱.urls'))",
  ])('counts an unfollowed include: %s', call => {
    const room = { entries: 1, views: 0 };
    expect(find(setup + `urlpatterns = [${call}]`, room)).toMatchObject({ entries: [], includes: [], unfollowed: 1 });
    expect(room.entries).toBe(0);
  });
  it.each([
    [Array(30).fill('a'.repeat(200)).join('.'), 'x'.repeat(300), true],
    [Array(31).fill('a').join('.'), 'x', false],
    ['a'.repeat(201), 'x', false], ['a', 'x'.repeat(301), false],
  ])('checks module and route boundaries %#', (module, route, accepted) => {
    const result = find(setup + `urlpatterns = [path('${route}', include('${module}'))]`);
    expect(result.includes).toHaveLength(accepted ? 1 : 0);
    expect(result.unfollowed).toBe(accepted ? 0 : 1);
  });
  it('bounds a million-character module before splitting it', () => {
    const result = find(setup + `urlpatterns = [path('', include('${'a.'.repeat(500_000)}'))]`);
    expect(result).toMatchObject({ includes: [], unfollowed: 1 });
  }, 30_000);
  it('charges includes against the entry limit, including unreadable includes', () => {
    const text = setup + "urlpatterns = [path('', include('app.urls')), path('', include(router.urls)), path('x', views.x)]";
    const none = { entries: 0, views: 0 };
    expect(find(text, none)).toMatchObject({ entries: [], includes: [], unfollowed: 0 });
    expect(none).toMatchObject({ entriesCut: true });
    const room = { entries: 2, views: 0 };
    expect(find(text, room)).toMatchObject({ entries: [], includes: [{ module: ['app', 'urls'] }], unfollowed: 1 });
    expect(room).toMatchObject({ entries: 0, entriesCut: true });
  });
});

describe('joining Django includes', () => {
  const urlconf = (items: string) => `from django.urls import path, re_path, include\ndef view(): pass\nurlpatterns = [${items}]\n`;
  const project = (sources: Record<string, string>): Map<string, DjangoFile> => new Map(Object.entries(sources).map(([relativePath, text]) =>
    [relativePath, find(text, undefined, undefined, { ...file, id: relativePath, relativePath })]));
  const join = (sources: Record<string, string>, max = 1000) => {
    const files = project(sources);
    return djangoRoutes(files, new Set(files.keys()), max, () => false);
  };
  it('joins an imported view and keeps the child entry as evidence', () => {
    const result = join({ 'manage.py': '', 'mysite/urls.py': urlconf("path('polls/', include('polls.urls'))"),
      'polls/urls.py': setup + "urlpatterns = [path('<int:id>/results/', views.results)]",
      'polls/views.py': 'def results(): pass' });
    expect(result).toMatchObject({ cut: false, skipped: 0, unfollowed: 0, routes: [{ path: '/polls/<int:id>/results/',
      typed: true, prefix: 'unknown', basis: { range: { fileId: 'polls/urls.py' } }, handler: { name: 'results' } }] });
    expect(result.routes).toHaveLength(1);
  });
  it.each([
    ['', 'users/', '/users/', false, false], ['api', 'users/', '/apiusers/', false, false],
    ['<slug:team>/', 'users/', '/<slug:team>/users/', false, true], ['a/', '/b', '/a//b', true, false],
    ['api/<str:', 'id>/', '/api/<str:id>/', true, false], ['x>/', 'y/', '/x>/y/', true, false],
    ['<int:a>/', '<int:', '/<int:a>/<int:', true, false],
    ['<int:a>/', '<int:b>/', '/<int:a>/<int:b>/', false, true], ['a<int:id>', 'b/', '/a<int:id>b/', true, false],
  ])('joins fragments %s and %s', (prefix, written, expected, unmatched, typed) => {
    const result = join({ 'manage.py': '', 'a.py': urlconf(`path('${prefix}', include('b'))`),
      'b.py': urlconf(`path('${written}', view)`) });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].path).toBe(expected);
    expect(!!result.routes[0].unmatched).toBe(unmatched);
    expect(!!result.routes[0].typed).toBe(typed);
    if (unmatched) expect(result.routes[0].segments).toBeUndefined();
    if (prefix === '<int:a>/' && written === '<int:b>/') expect(result.routes[0].segments).toEqual([{ param: 'a' }, { param: 'b' }]);
  });
  it.each([['v1/', 'api/', false], ['api/', '<int:', true]])('joins three levels and checks the middle fragment', (first, middle, broken) => {
    const last = broken ? 'a>/' : 'users/';
    const result = join({ 'manage.py': '', 'a.py': urlconf(`path('${first}', include('b'))`),
      'b.py': urlconf(`path('${middle}', include('c'))`), 'c.py': urlconf(`path('${last}', view)`) });
    expect(result.routes[0].path).toBe('/' + first + middle + last);
    expect(!!result.routes[0].unmatched).toBe(broken);
    if (broken) expect(result.routes[0].segments).toBeUndefined();
  });
  it('remembers a broken fragment through later whole fragments', () => {
    // '<int:' and 'a>/' look like one converter once joined, but Django reads each fragment by itself.
    const three = join({ 'manage.py': '', 'a.py': urlconf("path('<int:', include('b'))"),
      'b.py': urlconf("path('a>/', include('c'))"), 'c.py': urlconf("path('users/', view)") });
    expect(three.routes.map(route => [route.path, !!route.unmatched, route.segments])).toEqual([['/<int:a>/users/', true, undefined]]);
    const four = join({ 'manage.py': '', 'a.py': urlconf("path('<int:', include('b'))"), 'b.py': urlconf("path('a>/', include('c'))"),
      'c.py': urlconf("path('v/', include('d'))"), 'd.py': urlconf("path('users/', view)") });
    expect(four.routes.map(route => [route.path, !!route.unmatched, route.segments])).toEqual([['/<int:a>/v/users/', true, undefined]]);
  });
  it('keeps one route when two chains attach a file with the same text', () => {
    // Two starting urlconfs include the same file with the same prefix, as two hosts of one site do.
    const child = { 'manage.py': '', 'c.py': urlconf("path('x/', view)") };
    const same = join({ ...child, 'a.py': urlconf("path('', include('c'))"), 'b.py': urlconf("path('', include('c'))") });
    expect(same.routes.map(route => route.path)).toEqual(['/x/']);
    expect(same.cut).toBe(false);
    const different = join({ ...child, 'a.py': urlconf("path('', include('c'))"), 'b.py': urlconf("path('v/', include('c'))") });
    expect(different.routes.map(route => route.path)).toEqual(['/x/', '/v/x/']);
    // The same text through a broken fragment is a different route: it cannot be matched.
    const broken = join({ ...child, 'a.py': urlconf("path('<a>', include('c'))"), 'b.py': urlconf("path('<a', include('d'))"),
      'd.py': urlconf("path('>', include('c'))") });
    expect(broken.routes.map(route => [route.path, !!route.unmatched])).toEqual([['/<a>x/', true], ['/<a>x/', true]]);
  });
  it('keeps file, entry, prefix and handler order, including entries on a starting file', () => {
    const result = join({ 'manage.py': '',
      'z.py': urlconf("path('z/', include('b'))"),
      'b.py': urlconf("path('one/', view), path('two/', view)").replace('def view(): pass', '@require_http_methods(["POST", "GET"])\ndef view(): pass'),
      'a.py': urlconf("path('a/', include('b')), path('self/', view)") });
    expect(result.routes.map(route => [route.path, route.method])).toEqual([
      ['/self/', 'ALL'], ['/a/one/', 'POST'], ['/a/one/', 'GET'], ['/z/one/', 'POST'], ['/z/one/', 'GET'],
      ['/a/two/', 'POST'], ['/a/two/', 'GET'], ['/z/two/', 'POST'], ['/z/two/', 'GET'],
    ]);
  });
  it('counts exact prefix and route limits only when another combination exists', () => {
    const files = project({ 'manage.py': '', 'a.py': urlconf(''), 'b.py': urlconf("path('leaf/', view)") });
    files.get('a.py')!.includes = Array.from({ length: 5000 }, (_, i) => ({ written: `${i}/`, module: ['b'] }));
    const exact = djangoRoutes(files, new Set(files.keys()), 5000, () => false);
    expect(exact.cut).toBe(false);
    expect(exact.routes).toHaveLength(5000);
    expect(djangoRoutes(files, new Set(files.keys()), 4999, () => false)).toMatchObject({ cut: true });
  });
  it('preserves empty-prefix results even for unreadable paths and unsupported class methods', () => {
    const source = urlconf(`path('${'<'.repeat(300)}', view), path(VALUE, view), path('class/', Detail.as_view())`)
      + 'class Detail:\n    def head(self): pass';
    const alone = join({ 'child.py': source });
    const included = join({ 'manage.py': '', 'root.py': urlconf("path('', include('child'))"), 'child.py': source });
    expect(included.routes).toEqual(alone.routes);
    expect(included).toMatchObject({ cut: false, skipped: 1 });
    expect(included.routes.map(route => [route.path, route.unmatched])).toEqual([[null, undefined], [null, undefined]]);
  });
  it.each([false, true])('keeps only joined routes when another include uses re_path (joined: %s)', joined => {
    const result = join({ 'manage.py': '', 'root.py': urlconf(
      (joined ? "path('public/', include('app.urls')), " : '') + "re_path('^private/', include('app.urls'))"),
      'app/urls.py': urlconf("path('detail/', view)") });
    expect(result.routes.map(route => route.path)).toEqual([joined ? '/public/detail/' : '/detail/']);
    expect(result.unfollowed).toBe(1);
  });
  it.each([false, true])('keeps only joined routes when another parent is not plain (joined: %s)', joined => {
    const result = join({ 'manage.py': '', 'bad.py': urlconf("path('private/', include('app.urls'))") + 'from other import *',
      'root.py': urlconf(joined ? "path('public/', include('app.urls'))" : ''),
      'app/urls.py': urlconf("path('detail/', view)") });
    expect(result.routes.map(route => route.path)).toEqual([joined ? '/public/detail/' : '/detail/']);
    expect(result.unfollowed).toBe(1);
  });
  it('requires manage.py and chooses the nearest one for each parent', () => {
    const sources = { 'root.py': urlconf("path('outer/', include('app.urls'))"), 'app/urls.py': urlconf("path('outer/', view)"),
      'a/root.py': urlconf("path('a/', include('app.urls'))"), 'a/app/urls.py': urlconf("path('a/', view)"),
      'b/root.py': urlconf("path('b/', include('app.urls'))"), 'b/app/urls.py': urlconf("path('b/', view)") };
    const absent = join(sources);
    expect(absent.routes.map(route => route.path)).toEqual(['/a/', '/outer/', '/b/']);
    expect(absent.unfollowed).toBe(3);
    const present = join({ ...sources, 'manage.py': '', 'a/manage.py': '', 'b/manage.py': '' });
    expect(present.routes.map(route => route.path)).toEqual(['/a/a/', '/outer/outer/', '/b/b/']);
    expect(present.unfollowed).toBe(0);
  });
  it.each([
    ['missing', {}, 'django.contrib.auth.urls'],
    ['conflict', { 'app/urls/__init__.py': '' }, 'app.urls'],
    ['unsafe ancestor', { 'app/__init__.py': '__path__ = other' }, 'app.urls'],
    ['unsafe destination', { 'target/__init__.py': '__path__ = other' }, 'target'],
  ])('leaves child routes unchanged for an unfollowed %s', (_reason, extra, module) => {
    const result = join({ 'manage.py': '', 'root.py': urlconf(`path('prefix/', include('${module}'))`),
      'app/urls.py': urlconf("path('detail/', view)"), ...extra });
    expect(result.routes.map(route => route.path)).toEqual(['/detail/']);
    expect(result.unfollowed).toBe(1);
  });
  it('requires the target to be among the files actually read', () => {
    const files = project({ 'manage.py': '', 'root.py': urlconf("path('p/', include('unread'))") });
    expect(djangoRoutes(files, new Set([...files.keys(), 'unread.py']), 1000, () => false)).toMatchObject({ unfollowed: 1, routes: [] });
  });
  it('falls back for a cycle without a start and never revisits a file on a chain', () => {
    const sources = { 'manage.py': '', 'a.py': urlconf("path('a/', include('b')), path('one/', view)"),
      'b.py': urlconf("path('b/', include('a')), path('two/', view)") };
    expect(join(sources)).toMatchObject({ cut: false, routes: [{ path: '/one/' }, { path: '/two/' }] });
    expect(join({ ...sources, 'start.py': urlconf("path('s/', include('a'))") })).toMatchObject({
      cut: false, routes: [{ path: '/s/one/' }, { path: '/s/a/two/' }],
    });
  });
  it('stops after ten files in a chain and keeps unreachable entries without a prefix', () => {
    const sources: Record<string, string> = { 'manage.py': '' };
    for (let i = 0; i < 11; i++) sources[`a${i}.py`] = urlconf(i < 10
      ? `path('p/', include('a${i + 1}')), path('self${i}/', view)` : "path('last/', view)");
    const result = join(sources);
    expect(result.cut).toBe(true);
    expect(result.routes.find(route => route.basis.range.fileId === 'a9.py')?.path).toBe('/' + 'p/'.repeat(9) + 'self9/');
    expect(result.routes.find(route => route.basis.range.fileId === 'a10.py')?.path).toBe('/last/');
  });
  it('bounds prefix and final path length without dropping child entries', () => {
    const result = join({ 'manage.py': '', 'a.py': urlconf(`path('${'a'.repeat(300)}', include('b'))`),
      'b.py': urlconf("path('', view), path('x', include('c'))"), 'c.py': urlconf("path('leaf/', view)") });
    expect(result).toMatchObject({ cut: true, routes: [{ path: null }, { path: '/leaf/' }] });
    const exact = join({ 'manage.py': '', 'a.py': urlconf(`path('${'a'.repeat(298)}', include('b'))`),
      'b.py': urlconf("path('b', view)") });
    expect(exact.routes[0].path).toHaveLength(300);
    expect(exact.cut).toBe(false);
  });
  it('bounds generated prefixes and propagation attempts', () => {
    const files = project({ 'manage.py': '', 'a.py': urlconf(''), 'b.py': urlconf(''), 'c.py': urlconf("path('x', view)") });
    files.get('a.py')!.includes = Array.from({ length: 80 }, (_, i) => ({ written: `a${i}/`, module: ['b'] }));
    files.get('b.py')!.includes = Array.from({ length: 80 }, (_, i) => ({ written: `b${i}/`, module: ['c'] }));
    const capped = djangoRoutes(files, new Set(files.keys()), 7000, () => false);
    expect(capped.cut).toBe(true);
    expect(capped.routes).toHaveLength(4920);
    files.get('a.py')!.includes = Array.from({ length: 1000 }, (_, i) => ({ written: `${i}`.padStart(300, 'a'), module: ['b'] }));
    files.get('b.py')!.includes = Array.from({ length: 1000 }, () => ({ written: 'x', module: ['c'] }));
    const stop = vi.fn(() => false);
    const result = djangoRoutes(files, new Set(files.keys()), 6000, stop);
    expect(result.cut).toBe(true);
    expect(stop.mock.calls.length).toBeLessThanOrEqual(205_000);
    expect(result.routes.map(route => route.path)).toEqual(['/x']);
  }, 30_000);
  it.each([false, true])('resolves each entry once before expanding prefixes (empty handlers: %s)', empty => {
    const files = project({ 'manage.py': '', 'a.py': urlconf(''), 'b.py': urlconf(''),
      'c.py': urlconf("path('leaf/', view)") });
    files.get('a.py')!.includes = Array.from({ length: 70 }, (_, i) => ({ written: `a${i}/`, module: ['b'] }));
    files.get('b.py')!.includes = Array.from({ length: 70 }, (_, i) => ({ written: `b${i}/`, module: ['c'] }));
    const child = files.get('c.py')!, original = child.entries[0];
    const count = empty ? 4000 : 300;
    let reads = 0;
    child.entries = Array.from({ length: count }, (_, i) => ({ ...original, get view() {
      reads++;
      return !empty && i < 10 ? null : original.view;
    } }));
    const view = child.views.get('view')!;
    if (empty && view.kind === 'function') view.methods = [];
    const stop = vi.fn(() => false);
    const result = djangoRoutes(files, new Set(files.keys()), 1000, stop);
    expect(result.routes).toHaveLength(empty ? 0 : 1000);
    expect(result.skipped).toBe(empty ? 0 : 10);
    expect(result.cut).toBe(!empty);
    expect(reads).toBeLessThanOrEqual(count * 10);
    expect(stop.mock.calls.length).toBeLessThanOrEqual(300_000);
  }, 30_000);
  it('cancels during propagation and route expansion', () => {
    const files = project({ 'manage.py': '', 'a.py': urlconf("path('p/', include('b'))"), 'b.py': urlconf("path('x/', view)") });
    for (const at of [2, 4]) {
      let checks = 0;
      expect(() => djangoRoutes(files, new Set(files.keys()), 1000, () => ++checks === at))
        .toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    }
  });
  it('propagates odd files and keeps regex and spread entries unchanged', () => {
    const sources = { 'manage.py': '', 'a.py': urlconf("path('p/', include('b'))"),
      'b.py': urlconf("path('x/', view), re_path('^r/$', view), path('s/', view, *args)") };
    expect(join(sources).routes.map(route => [route.path, !!route.unmatched])).toEqual([
      ['/p/x/', false], ['^r/$', true], ['/s/', true],
    ]);
    const odd = join({ ...sources, 'a.py': sources['a.py'] + 'exec(code)' });
    expect(odd.routes.every(route => route.unmatched && route.segments === undefined)).toBe(true);
    expect(odd.oddFiles).toContain('a.py');
  });
  it('keeps an odd middle fragment on the chain even when its prefix is empty', () => {
    const result = join({ 'manage.py': '', 'a.py': urlconf("path('p/', include('b'))"),
      'b.py': urlconf("path('', include('c'))") + 'exec(code)', 'c.py': urlconf("path('leaf/', view)") });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/p/leaf/', unmatched: true });
    expect(result.routes[0].segments).toBeUndefined();
    expect(result.oddFiles).toEqual(['b.py']);
  });
});
