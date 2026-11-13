import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const setup = 'from flask import Flask\napp = Flask(__name__)\n';
const handler = 'def users():\n    return 1\n';
const direct = '@app.route("/existing")\ndef existing():\n    pass\n';
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
function noInvented(text: string) {
  expect(find(text).routes.some(route => route.path === '/users')).toBe(false);
}

describe('Python Flask direct add_url_rule declarations', () => {
  it('does not revisit a callee whose attribute chain exceeded the walk depth', () => {
    const walk = walkPython(setup + 'app' + '.child'.repeat(200) + '.add_url_rule("/users", view_func=users)\n', file.relativePath, 200_000);
    expect(walk.complete).toBe(false);
    const entry = walk.nodes.find(({ node, type }) => type === 'call' && node.startIndex >= setup.length)!;
    let calleeReads = 0;
    entry.node = new Proxy(entry.node, { get(target, property) {
      if (property === 'childForFieldName') return (field: string) => {
        if (field === 'function') calleeReads++;
        return target.childForFieldName(field);
      };
      return Reflect.get(target, property, target);
    } });
    const result = pythonRoutes(file, walk, hash, 1000);
    expect(result.complete).toBe(false);
    // Only the initial builtin-mutation check may inspect this call.
    expect(calleeReads).toBe(1);
  });

  it.each(['app', 'Flask'])('withholds registration after the active app or constructor escapes: %s', name => {
    const result = find(setup + handler + direct + `consume(${name})\napp.add_url_rule("/users", view_func=users)\n`);
    expect(result.routes.some(route => route.path === '/users')).toBe(false);
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it.each(['@app.route(config)', '@app.route("/other", methods=verbs)'])('includes unresolved existing decorators in the active app uncertainty: %s', decorator => {
    const result = find(setup + handler + direct + decorator + '\ndef other():\n    pass\napp.add_url_rule("/users", view_func=users)\n');
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });
  it.each([
    'app.add_url_rule("/users", view_func=users)',
    'app.add_url_rule("/users", "users_endpoint", users)',
    'app.add_url_rule(rule="/users", endpoint=None, view_func=users)',
  ])('maps the signature and original handler evidence for %s', statement => {
    const text = '# 😀\n' + setup + handler + statement + '\n';
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    const route = result.routes[0];
    expect(route).toMatchObject({ path: '/users', method: 'GET', prefix: 'unknown', framework: 'flask' });
    const symbol = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols[0];
    expect(route.handler).toMatchObject({ fileId: file.id, fileHash: hash, name: 'users', startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    expect(route.basis.range).toMatchObject({ fileId: file.id, fileHash: hash });
    expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe(statement);
    expect(route.basis.text).toBe(statement);
  });

  it('emits only the five supported explicit HTTP methods', () => {
    const result = find(setup + handler + 'app.add_url_rule("/users", view_func=users, methods=["GET", "POST", "PUT", "PATCH", "DELETE"])\n');
    expect(result.routes.map(route => route.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });

  it.each(['HEAD', 'OPTIONS'])('does not promote unsupported %s to GET or ALL', method => {
    const result = find(setup + handler + `app.add_url_rule("/users", view_func=users, methods=["${method}"])\n`);
    expect(result.routes).toEqual([]);
  });

  it('allows the same effective endpoint and same function under multiple rules', () => {
    const result = find(setup + handler + 'app.add_url_rule("/one", view_func=users)\napp.add_url_rule("/two", "users", users)\n');
    expect(result.routes.map(route => [route.path, route.handler.name])).toEqual([['/one', 'users'], ['/two', 'users']]);
  });

  it.each([
    'app.add_url_rule("/one", "shared", users)\napp.add_url_rule("/two", "shared", other)\n',
    '@app.route("/one", endpoint="shared")\ndef decorated():\n    pass\napp.add_url_rule("/two", "shared", users)\n',
  ])('downgrades existing owner routes when an endpoint maps to conflicting functions: %j', registration => {
    const result = find(setup + handler + 'def other():\n    pass\n' + direct + registration);
    const existing = result.routes.find(route => route.handler.name === 'existing')!;
    expect(existing).toBeDefined();
    expect(existing.prefix === 'unknown' || existing.unmatched).toBeTruthy();
  });

  it('does not spread one app endpoint conflict to an unrelated app', () => {
    const text = setup + 'other_app = Flask(__name__)\n' + handler + 'def other():\n    pass\n'
      + '@other_app.route("/safe")\ndef safe():\n    pass\n'
      + 'app.add_url_rule("/one", "shared", users)\napp.add_url_rule("/two", "shared", other)\n';
    expect(find(text).routes.find(route => route.path === '/safe')).toMatchObject({ prefix: 'known' });
  });

  it.each([
    ['endpoint-only call', 'app.add_url_rule("/users", "users")'],
    ['function in endpoint position', 'app.add_url_rule("/users", users)'],
    ['dynamic path', 'app.add_url_rule(dynamic, view_func=users)'],
    ['dynamic methods', 'app.add_url_rule("/users", view_func=users, methods=verbs)'],
    ['duplicate handler', 'app.add_url_rule("/users", None, users, view_func=users)'],
    ['duplicate rule', 'app.add_url_rule("/users", view_func=users, rule="/other")'],
    ['splat', 'app.add_url_rule("/users", view_func=users, **options)'],
    ['unknown option', 'app.add_url_rule("/users", view_func=users, custom=True)'],
    ['dynamic endpoint', 'app.add_url_rule("/users", endpoint=chosen, view_func=users)'],
  ])('does not fabricate a handler or fixed rule for unsupported %s', (_, registration) => {
    const text = setup + handler + direct + registration + '\n';
    noInvented(text);
    const existing = find(text).routes.find(route => route.handler.name === 'existing')!;
    expect(existing).toBeDefined();
    expect(existing.prefix === 'unknown' || existing.unmatched).toBeTruthy();
  });

  it('does not treat a deferred registration as a direct module declaration', () => {
    noInvented(setup + handler + 'def register():\n    app.add_url_rule("/users", view_func=users)\n');
  });

  it.each([
    ['decorated function', '@decorate\n' + handler],
    ['duplicate function', handler + handler],
    ['reassigned function', handler + 'users = other\n'],
  ])('requires a unique undecorated direct function: %s', (_, declaration) => {
    noInvented(setup + declaration + 'app.add_url_rule("/users", view_func=users)\n');
  });

  it.each(['methods', 'required_methods', 'provide_automatic_options'])('does not guess GET after the handler attribute %s is changed', attribute => {
    const result = find(setup + handler + `users.${attribute} = replacement\napp.add_url_rule("/users", view_func=users)\n`);
    expect(result.routes.some(route => route.path === '/users' && route.method === 'GET' && !route.unmatched)).toBe(false);
  });

  it('does not guess default methods after the function escapes to other code', () => {
    const result = find(setup + handler + 'consume(users)\napp.add_url_rule("/users", view_func=users)\n');
    expect(result.routes.some(route => route.path === '/users' && route.method === 'GET' && !route.unmatched)).toBe(false);
  });

  it('keeps Blueprint registration outside this stage', () => {
    noInvented('from flask import Blueprint\napp = Blueprint("b", __name__)\n' + handler + 'app.add_url_rule("/users", view_func=users)\n');
  });

  it('keeps factory-local app registration outside this stage', () => {
    noInvented('from flask import Flask\n' + handler + 'def create_app():\n    app = Flask(__name__)\n    app.add_url_rule("/users", view_func=users)\n    return app\n');
  });

  it('does not invent routes for imported app or handler names', () => {
    noInvented('from .application import app\n' + handler + 'app.add_url_rule("/users", view_func=users)\n');
    noInvented(setup + 'from .handlers import users\napp.add_url_rule("/users", view_func=users)\n');
  });

  it('caps emitted method routes and never treats truncated inspection as certain', () => {
    const result = find(setup + handler + 'app.add_url_rule("/users", view_func=users, methods=["GET", "POST", "PUT"])\n', 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    const incomplete = find(setup + handler + 'app.add_url_rule("/users", view_func=users)\n', 1000, 5);
    expect(incomplete.routes.every(route => route.unmatched || route.prefix === 'unknown')).toBe(true);
  });

  it('honors project cancellation even before there are readable files', async () => {
    await expect(findProjectRoutes('/not-read', 'project', [], MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('accepts a fourth positional automatic-options value with supported slash options', () => {
    const result = find(setup + handler + 'app.add_url_rule("/users", None, users, False, methods=None, strict_slashes=True, merge_slashes=None)\n');
    expect(result.routes).toMatchObject([{ path: '/users', method: 'GET', prefix: 'unknown' }]);
  });

  it.each([
    'app.add_url_rule("/users", None, users, False, provide_automatic_options=True)',
    'app.add_url_rule("/users", None, users, False, "extra")',
  ])('rejects duplicate or excessive positional automatic-options binding: %s', statement => {
    noInvented(setup + handler + statement + '\n');
  });

  it('accepts keyword automatic-options None and methods None as the default GET', () => {
    const result = find(setup + handler + 'app.add_url_rule("/users", view_func=users, provide_automatic_options=None, methods=None, strict_slashes=None, merge_slashes=False)\n');
    expect(result.routes).toMatchObject([{ method: 'GET', prefix: 'unknown' }]);
  });

  it('does not replace an explicitly empty method list with GET', () => {
    expect(find(setup + handler + 'app.add_url_rule("/users", view_func=users, methods=[])\n').routes).toEqual([]);
  });

  it('counts a HEAD-only decorator endpoint when checking conflicts with direct registration', () => {
    const text = setup + handler + direct + '@app.route("/head", methods=["HEAD"], endpoint="shared")\ndef head_only():\n    pass\napp.add_url_rule("/users", endpoint="shared", view_func=users)\n';
    expect(find(text).routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it('does not bind a handler that is defined only after the registration executes', () => {
    noInvented(setup + 'app.add_url_rule("/users", view_func=users)\n' + handler);
  });

  it('does not recover a registration when the handler is reassigned later in the file', () => {
    noInvented(setup + handler + 'app.add_url_rule("/users", view_func=users)\nusers = replacement\n');
  });

  it('normalizes Python function identifiers when deriving the default endpoint', () => {
    const text = setup + 'def ｕsers():\n    pass\n' + direct + '@app.route("/other", endpoint="users")\ndef other():\n    pass\napp.add_url_rule("/users", view_func=ｕsers)\n';
    expect(find(text).routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it('preserves literal endpoint case and Unicode instead of normalizing strings', () => {
    const text = setup + handler + direct + '@app.route("/other", endpoint="Ｕsers")\ndef other():\n    pass\napp.add_url_rule("/users", endpoint="users", view_func=users)\n';
    const result = find(text);
    expect(result.routes.find(route => route.path === '/users')).toMatchObject({ prefix: 'unknown' });
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'known' });
  });

  it.each(['/', '/<id>'])('does not leave existing app routes confirmed when an uncertain %s candidate is excluded from matching', rule => {
    const result = find(setup + handler + direct + `app.add_url_rule("${rule}", view_func=users)\n`);
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });

  it('bounds repeated validation work even without hitting the route output cap', () => {
    const statements = Array.from({ length: 600 }, (_, i) => `app.add_url_rule("/${i}${'x'.repeat(9000)}", view_func=users)\n`).join('');
    const result = find(setup + handler + direct + statements, 10_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(10_000);
    expect(result.routes.find(route => route.handler.name === 'existing')).toMatchObject({ prefix: 'unknown' });
  });
});
