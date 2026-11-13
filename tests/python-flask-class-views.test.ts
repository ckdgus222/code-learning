import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const setup = 'from flask import Flask\nfrom flask.views import View, MethodView\napp = Flask(__name__)\n';
const viewClass = 'class C(View):\n    def dispatch_request(self):\n        return "ok"\n';
const methodClass = 'class C(MethodView):\n    def get(self):\n        return "get"\n    def post(self):\n        return "post"\n';
const registration = 'app.add_url_rule("/users", view_func=C.as_view("users"))\n';
const existing = '@app.route("/existing")\ndef existing():\n    pass\n';
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
function blocked(text: string) {
  const result = find(text);
  expect(result.routes.some(route => route.path === '/users')).toBe(false);
  const previous = result.routes.find(route => route.path === '/existing');
  if (previous) expect(previous.prefix === 'unknown' || previous.unmatched).toBeTruthy();
}

describe('Python static Flask class-based views', () => {
  it('uses View dispatch_request source evidence for an inline as_view expression', () => {
    const text = '# 😀\n' + setup + viewClass + registration;
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    const symbol = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === 'C.dispatch_request')!;
    expect(result.routes[0]).toMatchObject({ path: '/users', method: 'GET', prefix: 'unknown', framework: 'flask',
      handler: { name: symbol.name, fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 } });
    const basis = result.routes[0].basis;
    expect(basis.range).toMatchObject({ fileId: file.id, fileHash: hash });
    expect(text.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(registration.trimEnd());
  });

  it.each([
    ['from flask.views import MethodView as Base', 'Base'],
    ['import flask.views as views', 'views.MethodView'],
    ['import flask.views', 'flask.views.MethodView'],
  ])('recognizes a safe official base import: %s', (declaration, base) => {
    const text = 'from flask import Flask\n' + declaration + '\napp = Flask(__name__)\n' + methodClass.replace('MethodView', base) + registration;
    expect(find(text).routes.map(route => [route.method, route.handler.name, route.prefix])).toEqual([
      ['GET', 'C.get', 'unknown'], ['POST', 'C.post', 'unknown'],
    ]);
  });

  it('maps each supported MethodView verb to its actual direct method', () => {
    const declaration = 'class C(MethodView):\n' + ['get', 'post', 'put', 'patch', 'delete'].map(name => `    def ${name}(self):\n        return "${name}"\n`).join('');
    expect(find(setup + declaration + registration).routes.map(route => [route.method, route.handler.name])).toEqual([
      ['GET', 'C.get'], ['POST', 'C.post'], ['PUT', 'C.put'], ['PATCH', 'C.patch'], ['DELETE', 'C.delete'],
    ]);
  });

  it('uses a literal class methods declaration rather than every method present', () => {
    const text = setup + methodClass.replace('class C(MethodView):', 'class C(MethodView):\n    methods = ["POST"]') + registration;
    expect(find(text).routes.map(route => [route.method, route.handler.name])).toEqual([['POST', 'C.post']]);
  });

  it('allows a registration literal methods override of the class declaration', () => {
    const text = setup + methodClass.replace('class C(MethodView):', 'class C(MethodView):\n    methods = ["GET"]')
      + registration.replace('view_func=C.as_view("users")', 'view_func=C.as_view("users"), methods=["POST"]');
    expect(find(text).routes.map(route => [route.method, route.handler.name])).toEqual([['POST', 'C.post']]);
  });

  it('maps explicit View methods to dispatch_request without inferring verb methods', () => {
    const text = setup + viewClass + registration.replace('view_func=C.as_view("users")', 'view_func=C.as_view("users"), methods=["GET", "DELETE"]');
    expect(find(text).routes.map(route => [route.method, route.handler.name])).toEqual([['GET', 'C.dispatch_request'], ['DELETE', 'C.dispatch_request']]);
  });

  it('ignores HEAD and OPTIONS without promoting them to ALL', () => {
    const declaration = 'class C(MethodView):\n    def head(self):\n        pass\n    def options(self):\n        pass\n';
    expect(find(setup + declaration + registration).routes).toEqual([]);
    expect(find(setup + methodClass + registration.replace('view_func=C.as_view("users")', 'view_func=C.as_view("users"), methods=["HEAD", "OPTIONS"]')).routes).toEqual([]);
  });

  it('allows the same unique generated view alias on multiple rules with its as_view endpoint', () => {
    const text = setup + viewClass + 'view = C.as_view("shared")\napp.add_url_rule("/one", view_func=view)\napp.add_url_rule("/two", "shared", view)\n';
    expect(find(text).routes.map(route => [route.path, route.handler.name])).toEqual([['/one', 'C.dispatch_request'], ['/two', 'C.dispatch_request']]);
  });

  it('detects different classes sharing the effective as_view endpoint and downgrades the owner', () => {
    const text = setup + viewClass + viewClass.replaceAll('C(', 'D(') + existing
      + 'app.add_url_rule("/one", view_func=C.as_view("shared"))\napp.add_url_rule("/two", view_func=D.as_view("shared"))\n';
    expect(find(text).routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it.each([
    ['custom base', viewClass.replace('View', 'CustomView')],
    ['mixin', viewClass.replace('(View)', '(Mixin, View)')],
    ['metaclass', viewClass.replace('(View)', '(View, metaclass=Meta)')],
    ['decorated class', '@decorate\n' + viewClass],
    ['decorated method', viewClass.replace('    def dispatch_request', '    @decorate\n    def dispatch_request')],
    ['inherited handler', viewClass + 'class D(C):\n    pass\nC = D\n'],
    ['duplicate class', viewClass + viewClass],
    ['duplicate dispatch', viewClass + '    def dispatch_request(self):\n        return "other"\n'],
    ['dynamic class methods', viewClass.replace('class C(View):', 'class C(View):\n    methods = verbs')],
  ])('does not invent a class-view route for %s', (_, declaration) => {
    blocked(setup + declaration + existing + registration);
  });

  it.each([
    ['as_view mutation', 'C.as_view = replacement\n'],
    ['dispatch mutation', 'C.dispatch_request = replacement\n'],
    ['constructor mutation', 'C.__new__ = replacement\n'],
    ['class escape', 'consume(C)\n'],
    ['method escape', 'consume(C.dispatch_request)\n'],
    ['base alias shadow', 'View = replacement\n'],
  ])('does not recover a class view after %s', (_, effect) => {
    blocked(setup + viewClass + effect + existing + registration);
  });

  it.each([
    ['generated function escape', 'view = C.as_view("users")\nconsume(view)\n'],
    ['generated function reassignment', 'view = C.as_view("users")\nview = other\n'],
    ['generated function methods mutation', 'view = C.as_view("users")\nview.methods = verbs\n'],
  ])('keeps generated function guards for %s', (_, definition) => {
    blocked(setup + viewClass + definition + existing + 'app.add_url_rule("/users", view_func=view)\n');
  });

  it.each(['C.as_view(dynamic)', 'C.as_view("users", **options)'])('does not assume a plain generated function for %s', expression => {
    blocked(setup + viewClass + existing + `app.add_url_rule("/users", view_func=${expression})\n`);
  });

  it('does not use a class or generated alias defined only after registration', () => {
    blocked(setup + existing + registration + viewClass);
    blocked(setup + viewClass + existing + 'app.add_url_rule("/users", view_func=view)\nview = C.as_view("users")\n');
  });

  it('honors explicit endpoint binding rather than treating the second positional argument as a view', () => {
    const text = setup + viewClass + 'view = C.as_view("generated")\napp.add_url_rule("/users", "explicit", view)\n';
    expect(find(text).routes).toMatchObject([{ path: '/users', method: 'GET', handler: { name: 'C.dispatch_request' } }]);
    blocked(setup + viewClass + existing + 'app.add_url_rule("/users", C.as_view("generated"))\n');
  });

  it('caps emitted MethodView routes without losing the original method evidence', () => {
    const result = find(setup + methodClass + registration, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(result.routes[0].handler.name).toBe('C.get');
  });

  it('treats two inline as_view calls on the same class as different generated functions', () => {
    const text = setup + viewClass + existing + 'app.add_url_rule("/one", view_func=C.as_view("shared"))\napp.add_url_rule("/two", view_func=C.as_view("shared"))\n';
    expect(find(text).routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it('does not create an endpoint conflict when one generated function alias is reused', () => {
    const text = setup + viewClass + existing + 'view = C.as_view("shared")\napp.add_url_rule("/one", view_func=view)\napp.add_url_rule("/two", view_func=view)\n';
    const result = find(text);
    expect(result.routes.filter(route => ['/one', '/two'].includes(route.path ?? ''))).toHaveLength(2);
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'known' });
  });

  it('uses class methods when registration methods is explicitly None', () => {
    const text = setup + methodClass.replace('class C(MethodView):', 'class C(MethodView):\n    methods = ["POST"]')
      + registration.replace('view_func=C.as_view("users")', 'view_func=C.as_view("users"), methods=None');
    expect(find(text).routes.map(route => [route.method, route.handler.name])).toEqual([['POST', 'C.post']]);
  });

  it('defaults View methods=None to GET dispatched to dispatch_request', () => {
    const text = setup + viewClass.replace('class C(View):', 'class C(View):\n    methods = None') + registration;
    expect(find(text).routes).toMatchObject([{ method: 'GET', handler: { name: 'C.dispatch_request' } }]);
  });

  it('does not guess a MethodView get handler when methods=None replaces inferred methods', () => {
    const text = setup + 'class C(MethodView):\n    methods = None\n    def post(self):\n        pass\n' + existing + registration;
    blocked(text);
  });

  it('does not map a selected method to a different available MethodView method', () => {
    const text = setup + 'class C(MethodView):\n    def get(self):\n        pass\n' + existing
      + registration.replace('view_func=C.as_view("users")', 'view_func=C.as_view("users"), methods=["POST"]');
    blocked(text);
  });

  it.each([
    'def plain():\n    pass\napp.add_url_rule("/plain", endpoint="users", view_func=plain)\n',
    '@app.route("/head", endpoint="users", methods=["HEAD"])\ndef head():\n    pass\n',
  ])('includes direct function and HEAD-only decorator endpoints in class-view collision checks: %j', other => {
    const text = setup + viewClass + existing + other + registration;
    expect(find(text).routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it.each(['methods', 'decorators', 'provide_automatic_options', 'init_every_request'])('does not interpret a function named %s as a supported class configuration value', name => {
    const text = setup + viewClass + `    def ${name}(self):\n        pass\n` + existing + registration;
    blocked(text);
  });

  it.each(['__init__', '__getattribute__'])('does not assume a custom class %s hook is harmless', hook => {
    const text = setup + viewClass + `    def ${hook}(self, *args):\n        pass\n` + existing + registration;
    blocked(text);
  });

  it('withholds generated aliases reassigned after registration', () => {
    blocked(setup + viewClass + existing + 'view = C.as_view("users")\napp.add_url_rule("/users", view_func=view)\nview = replacement\n');
  });

  it('does not recover a generated function that escapes through a parenthesized container', () => {
    blocked(setup + viewClass + existing + 'view = C.as_view("users")\nconsume([(view)])\napp.add_url_rule("/users", view_func=view)\n');
  });

  it('does not accept an imported base alias shadowed after class creation', () => {
    blocked(setup + viewClass + 'from other import View\n' + existing + registration);
  });

  it('does not return matchable class-view evidence after node or depth traversal is cut short', () => {
    const text = setup + viewClass + registration;
    const partial = find(text, 1000, 5);
    expect(partial.complete).toBe(false);
    expect(partial.routes.every(route => route.unmatched)).toBe(true);
    const deep = find(text + 'value = ' + '['.repeat(150) + ']'.repeat(150));
    expect(deep.complete).toBe(false);
    expect(deep.routes.every(route => route.unmatched)).toBe(true);
  });

  it('bounds class-view validation work before a generous output cap', () => {
    const calls = Array.from({ length: 600 }, (_, i) => `app.add_url_rule("/${i}${'x'.repeat(9000)}", view_func=C.as_view("name${i}"))\n`).join('');
    const result = find(setup + viewClass + existing + calls, 10_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(10_000);
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });
});
