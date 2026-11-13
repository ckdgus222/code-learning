import { describe, expect, it, vi } from 'vitest';
import { djangoFile, djangoRoutes } from '../src/core/analysis/django-routes';
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
    expect(result.includes).toBe(0);
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
    // 70,000 parts shared by 5,000 names took 17 s to resolve before the depth limit.
    const names = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    const text = `from django.urls import path\nfrom ${Array.from({ length: 70_000 }, () => 'a').join('.')} import ${names.join(', ')}\n`
      + `urlpatterns = [${names.map(name => `path('${name}/', ${name})`).join(', ')}]\n`;
    const started = performance.now();
    const data = find(text, { entries: 5000, views: 20000 }, 200_000);
    expect(data.imports.size).toBe(0);
    const files = new Map([[file.relativePath, data]]);
    expect(djangoRoutes(files, new Set(files.keys()), 1000, () => false)).toMatchObject({ routes: [], skipped: data.entries.length });
    expect(performance.now() - started).toBeLessThan(4000);
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
    expect(result.includes).toBe(2);
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
    expect(result.entries).toHaveLength(2); expect(result.includes).toBe(0);
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
