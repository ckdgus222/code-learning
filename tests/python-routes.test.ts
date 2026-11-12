import { describe, expect, it } from 'vitest';
import { pythonRoutes } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { matchFunction } from '../src/renderer/map-layout';
import type { SourceView } from '../src/shared/contracts';

const file = { id: 'python', relativePath: 'server/main.py', size: 0 };
const setup = 'from fastapi import FastAPI, APIRouter\nimport fastapi as f\napp = FastAPI()\n';
const handler = '@app.get("/users/{user_id}")\nasync def read_user(user_id: int):\n    return find_user(user_id)\n';
const find = (text = setup + handler, nodes = 100_000, routes = 1000) => pythonRoutes(file, text, 'hash', nodes, routes);

describe('FastAPI declarations', () => {
  it.each(['', '@app.post("/users/{user_id}")\n'])('uses the analyzer function range, including every decorator: %s', extra => {
    const text = setup + extra + handler;
    const result = find(text);
    const analysis = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: 'hash' });
    const symbol = analysis.symbols.find(symbol => symbol.name === 'read_user')!;
    for (const route of result.routes) {
      expect(route.handler).toMatchObject({ name: symbol.name, startUtf16: symbol.evidence.startUtf16,
        endUtf16: symbol.evidence.endUtf16, startLine: symbol.evidence.startLine });
      const found = matchFunction({ fileId: file.id, hash: 'hash', analysis } as SourceView, route.handler);
      expect(found.status).toBe('found');
      if (found.status === 'found') expect(found.symbol.name).toBe('read_user');
      expect(route).toMatchObject({ path: '/users/{user_id}', prefix: 'known', framework: 'fastapi', segments: [{ text: 'users' }, { param: 'user_id' }] });
      expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe(route.basis.text);
      expect(route.basis.range.startLine).toBe(route.basis.range.endLine);
    }
    expect(result.routes.map(route => route.method)).toEqual(extra ? ['POST', 'GET'] : ['GET']);
    expect(result).toMatchObject({ complete: true, cut: false, odd: false, routers: [] });
  });
  it.each(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'websocket', 'on_event', 'GET'])('reads only supported lowercase methods: %s', method => {
    const result = find(setup + `@app.${method}("/x")\ndef read_user(): pass`);
    expect(result.routes.map(route => route.method)).toEqual(['get', 'post', 'put', 'patch', 'delete'].includes(method) ? [method.toUpperCase()] : []);
  });
  it.each([
    ['from fastapi import FastAPI as F', 'F()'], ['import fastapi', 'fastapi.FastAPI()'],
    ['import fastapi as f', 'f.FastAPI()'], ['from ｆａｓｔａｐｉ import ＦａｓｔＡＰＩ as F', 'F()'],
  ])('recognizes imported factories: %s', (imports, create) => {
    expect(find(`${imports}\napp = ${create}\n${handler}`).routes).toHaveLength(1);
  });
  it.each(['from starlette.routing import Router as FastAPI', 'from other import FastAPI',
    'from .fastapi import FastAPI', 'from fastapi.applications import FastAPI'])('ignores other libraries: %s', imports => {
    expect(find(`${imports}\napp = FastAPI()\n${handler}`).routes).toEqual([]);
  });
  it.each([
    ['import other as f', 'f.FastAPI()'], ['import fastapi', 'fastapi.Depends()'],
    ['if ready:\n    from fastapi import FastAPI', 'FastAPI()'], ['if ready:\n    import fastapi', 'fastapi.FastAPI()'],
  ])('ignores other modules, other attributes and imports inside a block: %s', (imports, create) => {
    expect(find(`${imports}\napp = ${create}\n${handler}`).routes).toEqual([]);
  });
  it('ignores an app made inside a block even when its decorator is at the top', () => {
    expect(find('from fastapi import FastAPI\nif ready:\n    app = FastAPI()\n' + handler).routes).toEqual([]);
  });
  it('accepts annotations but ignores nested assignments and handlers', () => {
    const typed = find(setup.replace('app = FastAPI()', 'app: f.FastAPI = f.FastAPI()') + handler);
    expect(typed.routes).toHaveLength(1);
    expect(typed).toMatchObject({ odd: false, routes: [{ segments: [{ text: 'users' }, { param: 'user_id' }] }] });
    for (const block of ['if ready:', 'class C:', 'def outer():']) {
      const nested = 'app = FastAPI()\n' + handler;
      expect(find(`from fastapi import FastAPI\n${block}\n${nested.split('\n').filter(Boolean).map(line => '    ' + line).join('\n')}`).routes).toEqual([]);
      expect(find(setup + `${block}\n${handler.split('\n').filter(Boolean).map(line => '    ' + line).join('\n')}`).routes).toEqual([]);
    }
  });
  it.each([
    'app = other', 'FastAPI = other_factory', 'from other import Factory as FastAPI', 'def FastAPI(): pass',
    'if ready:\n    app = other', 'for app in things: pass', 'with resource as app: pass',
    'try: pass\nexcept E as app: pass', 'match other:\n    case app: pass', 'match other:\n    case {"k": 1} as app: pass',
    'app, other = things', 'app += other', '(app := other)', 'del app', 'other = app',
    'def mutate():\n    global app', 'def f(value=(app := other)): pass', 'class C((app := other)): pass', 'ａｐｐ = other', 'def mutate():\n    global ａｐｐ',
  ])('rejects overwritten or unsupported name uses: %s', overwrite => {
    const result = find(setup + handler + '\n' + overwrite + '\nsafe = APIRouter()\n@safe.get("/safe")\ndef safe_handler(): pass');
    expect(result.routes.map(route => route.path)).toEqual(['/safe']);
  });
  it.each([
    ['from fastapi import FastAPI as F\nfrom other import Factory as F', 'F()'],
    ['import fastapi as f\nf = other', 'f.FastAPI()'],
    ['from fastapi import APIRouter\nclass APIRouter: pass', 'APIRouter()'],
  ])('rejects overwritten aliases and constructors: %s', (imports, create) => {
    expect(find(`${imports}\napp = ${create}\n${handler}`).routes).toEqual([]);
  });
  it('rejects module star imports, including imports in a block', () => {
    for (const star of ['from other import *', 'if ready:\n    from other import *']) expect(find(setup + handler + star).routes).toEqual([]);
  });
  it.each([
    'uvicorn.run(app)', 'router = APIRouter()\napp.include_router(router)', 'handler = Mangum(app)',
    'app.add_middleware(X)', 'isinstance(x, FastAPI)', 'def local(app):\n    app = other',
    'def local():\n    from other import *', 'def local(app: FastAPI = None, *args, **kwargs): pass',
    'def local(value=Mangum(app)): pass', 'f = lambda app: app',
  ])('keeps permitted reads and local names: %s', read => {
    expect(find(setup + handler + read).routes).toHaveLength(1);
  });
  it('normalizes decorator names', () => {
    expect(find(setup + handler.replace('@app.get', '@ａｐｐ.ｇｅｔ')).routes).toHaveLength(1);
  });
});

describe('unusual Python files', () => {
  it.each([
    'f.FastAPI = other_factory', 'app.get = other', 'del app.post', 'handler = app.get', 'for app.get in things: pass',
    'def mutate():\n    f.APIRouter = x', "setattr(app, 'get', x)", "setattr(app.router, 'redirect_slashes', False)",
    "delattr(app, 'get')", "vars(app)['get'] = x", "app.__dict__['get'] = x", 'app.__class__ = Other',
    "globals()['app'] = other", 'exec(code)', 'eval(code)', 'locals()', "__import__('x')", '__builtins__', 'ａｐｐ.get = other',
  ])('lists but never links routes when machinery appears: %s', code => {
    const result = find(setup + handler + code);
    expect(result.odd).toBe(true);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].unmatched).toBe(true);
    expect(result.routes[0].segments).toBeUndefined();
  });
  it.each([
    'app.openapi = custom_openapi', 'app.state.db = make()', 'app.dependency_overrides[get_db] = fake',
    'setattr(db_obj, key, value)', 'max(counts, key=counts.get)', 'user.__dict__', 'other.get = x', 'app.get("/x")(handler)',
    'model.eval()', 'frame.eval("a + b")', 'run(eval=True)',
  ])('does not reject ordinary attributes: %s', code => {
    const result = find(setup + handler + code);
    expect(result.odd).toBe(false);
    expect(result.routes[0].unmatched).toBeUndefined();
    expect(result.routes[0].segments).toHaveLength(2);
  });
  it('never confirms a partially inspected file, even if mutation appears after the budget', () => {
    const text = setup + handler + '\n' + 'x = 1\n'.repeat(100) + 'app.get = other';
    const result = find(text, 120);
    expect(result).toMatchObject({ complete: false, odd: false });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].unmatched).toBe(true);
    expect(result.routes[0].segments).toBeUndefined();
  });
  it('reports a partially inspected file as partial, not as unusual, even when the mutation was seen', () => {
    const result = find(setup + 'app.get = other\n' + handler + '\n' + 'x = 1\n'.repeat(100), 120);
    expect(result).toMatchObject({ complete: false, odd: false, routes: [{ unmatched: true }] });
  });
});

describe('FastAPI paths and methods', () => {
  it.each(['f"/x/{id}"', 'r"/x"', 'b"/x"', '"/x" "/y"', '"/x\\n"', 'path_value', '"/x" + "/y"'])('keeps unreadable paths null: %s', value => {
    const route = find(setup + `@app.get(${value})\ndef h(): pass`).routes[0];
    expect(route.path).toBeNull();
    expect(route.segments).toBeUndefined();
  });
  it.each(['"/x"', 'path="/x"', 'path="""/x"""', 'ｐａｔｈ="/x"'])('reads plain paths: %s', args => {
    expect(find(setup + `@app.get(${args})\ndef h(): pass`).routes[0].path).toBe('/x');
  });
  it.each([
    ['', ['GET']], [', methods=["get", "POST", "get", "HEAD"]', ['GET', 'POST']],
    [', methods=("patch", "delete")', ['PATCH', 'DELETE']], [', methods={"put", "POST"}', ['PUT', 'POST']],
    [', methods=[]', []], [', methods=["HEAD", "OPTIONS"]', []], [', methods=unknown', ['ALL']],
    [', methods=["GET", method]', ['ALL']], [', methods="GET"', ['ALL']],
  ])('reads api_route methods: %s', (args, expected) => {
    const routes = find(setup + `@app.api_route("/x"${args})\ndef h(): pass`).routes;
    expect(routes.map(route => route.method)).toEqual(expected);
    if (expected.includes('ALL')) { expect(routes[0].unmatched).toBe(true); expect(routes[0].segments).toBeUndefined(); }
  });
  it.each(['*args', '"/x", **extra', '"/x", *args'])('does not link spread decorators: %s', args => {
    expect(find(setup + `@app.get(${args})\ndef h(): pass`).routes[0].unmatched).toBe(true);
  });
  it('does not mistake spread options for GET certainty', () => {
    expect(find(setup + 'options = {"methods": ["POST"]}\n@app.api_route("/users", **options)\ndef h(): pass').routes[0].unmatched).toBe(true);
  });
  it.each([
    ['APIRouter(prefix="/users")', '"/{id}"', '/users/{id}'],
    ['APIRouter(prefix=unknown)', '"/{id}"', '/{id}'], ['APIRouter(prefix="/users", **opts)', '"/{id}"', '/{id}'],
    ['APIRouter(prefix="/users")', '""', '/users'], ['APIRouter()', '""', ''],
  ])('retains router prefixes without following include_router: %s', (create, arg, path) => {
    const result = find(`from fastapi import APIRouter\nrouter = ${create}\n@router.get(${arg})\ndef h(): pass`);
    expect(result.routers).toEqual(['fastapi']);
    expect(result.routes[0]).toMatchObject({ path, prefix: 'unknown' });
    expect(result.routes[0].unmatched).toBe(path ? undefined : true);
  });
  it.each(['FastAPI(root_path="/api")', 'FastAPI(**opts)', 'FastAPI(*args)'])('keeps app prefixes unknown: %s', create => {
    expect(find(setup.replace('FastAPI()', create) + handler).routes[0].prefix).toBe('unknown');
  });
  it.each(['redirect_slashes=False', '**opts', '*args'])('avoids slash redirect assumptions: %s', args => {
    for (const address of ['/users/', '/files/{p:path}', '/']) {
      expect(find(setup.replace('FastAPI()', `FastAPI(${args})`) + `@app.get("${address}")\ndef h(): pass`).routes[0].unmatched).toBe(true);
    }
    expect(find(setup.replace('FastAPI()', `FastAPI(${args})`) + '@app.get("/users")\ndef h(): pass').routes[0].unmatched).toBeUndefined();
  });
  it('sees root_path and redirect_slashes names anywhere, but not string contents', () => {
    for (const address of ['/users/', '/files/{p:path}']) {
      expect(find(setup + `@app.get("${address}")\ndef h(): pass\napp.router.redirect_slashes = False`).routes[0].unmatched).toBe(true);
      expect(find(setup + `@app.get("${address}")\ndef h(): pass\ns = "redirect_slashes"`).routes[0].unmatched).toBeUndefined();
    }
    expect(find(setup + handler + '\napp.root_path = "/api"').routes[0].prefix).toBe('unknown');
    expect(find(setup + handler + '\nscope["root_path"]').routes[0].prefix).toBe('known');
  });
  it.each([
    ['/users/{id}', [{ text: 'users' }, { param: 'id' }]], ['/a._~-09', [{ text: 'a._~-09' }]],
    ['/files/{p:path}', [{ text: 'files' }, { catchAll: 'p', optional: true }]], ['/users/', [{ text: 'users' }]], ['/', []],
  ])('expresses supported segments: %s', (path, segments) => {
    const route = find(setup + `@app.get("${path}")\ndef h(): pass`).routes[0];
    expect(route.path).toBe(path);
    expect(route.segments).toEqual(segments);
    expect(route.unmatched).toBeUndefined();
  });
  it.each(['', '/v{n}', '/{a}-{b}', '/files/{p:path}/meta', '/files/{p:path}/',
    '/files/{', '/files/:name', '/files/report*', '/users//me', '/users/{사용자}', '/사용자', '/a%20b', 'users', '//'])('keeps unsupported paths without matchable segments: %s', path => {
    const route = find(setup + `@app.get("${path}")\ndef h(): pass`).routes[0];
    expect(route.path).toBe(path);
    expect(route.unmatched).toBe(true);
    expect(route.segments).toBeUndefined();
  });
  it('does not collapse slashes between a prefix and path or treat no argument as root', () => {
    expect(find('from fastapi import APIRouter\napp = APIRouter(prefix="/api/")\n@app.get("/users")\ndef h(): pass').routes[0])
      .toMatchObject({ path: '/api//users', unmatched: true });
    expect(find(setup + '@app.get()\ndef h(): pass').routes[0]).toMatchObject({ path: '', unmatched: true });
  });
  it('caps routes and names, rejects overlong paths and skips malformed functions', () => {
    expect(find(setup + '@app.get("/x")\n@app.post("/x")\ndef h(): pass', 1000, 1)).toMatchObject({ cut: true, routes: [{ method: 'GET' }] });
    expect(find(setup + '@app.api_route("/x", methods=["GET", "POST"])\ndef h(): pass', 1000, 1)).toMatchObject({ cut: true, routes: [{ method: 'GET' }] });
    expect(find(setup + handler, 1000, 1)).toMatchObject({ cut: false, routes: [{ method: 'GET' }] });
    expect(find(setup + handler, 0)).toMatchObject({ routes: [], complete: false });
    const long = 'x'.repeat(400);
    expect(find(setup + `@app.get("/${long}")\ndef ${long}(): pass`).routes[0]).toMatchObject({ path: null, handler: { name: 'x'.repeat(200) + '…' } });
    expect(find(setup + `@app.get("/${'a/'.repeat(31)}")\ndef h(): pass`).routes[0].path).toBeNull();
    expect(find(setup + '@app.get("/broken")\ndef broken(: pass\n' + handler).routes.map(route => route.path)).toEqual(['/users/{user_id}']);
  });
});

const flaskSetup = 'from flask import Flask, Blueprint\nimport flask as f\napp = Flask(__name__)\n';
const flaskHandler = '@app.route("/users/<user_id>")\ndef read_user(user_id):\n    return find_user(user_id)\n';

describe('Flask declarations', () => {
  it('uses the analyzer handler range and the written decorator as evidence', () => {
    const text = flaskSetup + flaskHandler;
    const result = find(text);
    const analysis = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: 'hash' });
    const symbol = analysis.symbols.find(symbol => symbol.name === 'read_user')!;
    expect(result).toMatchObject({ complete: true, cut: false, odd: false, routers: [], routes: [{
      method: 'GET', path: '/users/<user_id>', prefix: 'known', framework: 'flask',
      segments: [{ text: 'users' }, { param: 'user_id' }],
      handler: { name: symbol.name, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16, startLine: symbol.evidence.startLine },
    }] });
    const route = result.routes[0];
    expect(matchFunction({ fileId: file.id, hash: 'hash', analysis } as SourceView, route.handler).status).toBe('found');
    expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe('@app.route("/users/<user_id>")');
    expect(route.basis.range.startLine).toBe(route.basis.range.endLine);
    expect(route.typed).toBeUndefined();
    expect(route.unmatched).toBeUndefined();
  });
  it.each([
    ['from flask import Flask as F', 'F(__name__)'], ['import flask', 'flask.Flask(__name__)'],
    ['import flask as f', 'f.Flask(__name__)'], ['from ｆｌａｓｋ import Ｆｌａｓｋ as F', 'F(__name__)'],
  ])('recognizes Flask imports: %s', (imports, create) => {
    expect(find(`${imports}\napp = ${create}\n${flaskHandler}`).routes[0]).toMatchObject({ framework: 'flask', prefix: 'known' });
  });
  it('does not confuse an aliased Flask constructor with FastAPI', () => {
    const result = find(`from flask import Flask as FastAPI\napp = FastAPI()\n${handler}`);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ framework: 'flask', path: '/users/{user_id}', unmatched: true });
  });
  it.each(['from other import Flask', 'from flask.app import Flask', 'from quart import Quart as Flask',
    'if ready:\n    from flask import Flask', 'from .flask import Flask'])('ignores other or nested imports: %s', imports => {
    expect(find(`${imports}\napp = Flask(__name__)\n${flaskHandler}`).routes).toEqual([]);
  });
  it('does not mix framework decorators or include nested apps and handlers', () => {
    expect(find(setup + flaskHandler).routes).toEqual([]);
    expect(find(flaskSetup + '@app.api_route("/x")\ndef h(): pass').routes).toEqual([]);
    for (const block of ['if ready:', 'class C:', 'def create_app():']) {
      const nested = 'app = Flask(__name__)\n' + flaskHandler;
      expect(find(`from flask import Flask\n${block}\n${nested.split('\n').filter(Boolean).map(line => '    ' + line).join('\n')}`).routes).toEqual([]);
      expect(find(flaskSetup + `${block}\n${flaskHandler.split('\n').filter(Boolean).map(line => '    ' + line).join('\n')}`).routes).toEqual([]);
    }
    expect(find('from flask import Flask\nif ready:\n    app = Flask(__name__)\n' + flaskHandler).routes).toEqual([]);
  });
  it.each(['get', 'post', 'put', 'patch', 'delete', 'websocket', 'errorhandler', 'before_request', 'head', 'options'])('reads supported Flask methods: %s', method => {
    const result = find(flaskSetup + `@app.${method}("/x")\ndef h(): pass`);
    expect(result.routes.map(route => route.method)).toEqual(['get', 'post', 'put', 'patch', 'delete'].includes(method) ? [method.toUpperCase()] : []);
  });
  it.each([
    ['', ['GET']], [', methods=["get", "POST", "get", "HEAD"]', ['GET', 'POST']],
    [', methods=("patch", "delete")', ['PATCH', 'DELETE']], [', methods={"put", "POST"}', ['PUT', 'POST']],
    [', methods=[]', []], [', methods=["HEAD", "OPTIONS"]', []], [', methods=unknown', ['ALL']],
    [', methods=["GET", method]', ['ALL']], [', methods="GET"', ['ALL']],
  ])('reads route methods in order: %s', (args, expected) => {
    const routes = find(flaskSetup + `@app.route("/x"${args})\ndef h(): pass`).routes;
    expect(routes.map(route => route.method)).toEqual(expected);
    for (const route of routes) {
      expect(route.unmatched).toBe(expected.includes('ALL') ? true : undefined);
      expect(route.segments).toEqual(expected.includes('ALL') ? undefined : [{ text: 'x' }]);
    }
  });
  it.each(['get', 'post', 'put', 'patch', 'delete'])('rejects methods on the shortcut %s', method => {
    expect(find(flaskSetup + `@app.${method}("/x", methods=["POST"])\ndef h(): pass`).routes[0]).toMatchObject({ unmatched: true });
  });
  it.each(['app = other', 'ａｐｐ = other', 'def Flask(): pass', 'def mutate():\n    global app',
    'Flask = other', 'from other import Factory as Flask', 'f = other', 'other = app'])('rejects overwritten Flask names: %s', code => {
    const text = code === 'f = other' ? flaskSetup.replace('app = Flask(__name__)', 'app = f.Flask(__name__)') : flaskSetup;
    expect(find(text + flaskHandler + code).routes).toEqual([]);
  });
  it.each([
    'app.route = other', 'handler = app.route', 'f.Flask = other', "setattr(app, 'route', x)", 'exec(code)',
    "app.url_map.converters['path'] = X", 'app.url_map.host_matching = True', "app.view_functions['read'] = other",
    'DispatcherMiddleware(app, {})', 'url_rule_class = X', 'url_map_class = X',
    'default_subdomain = "api"', 'run(subdomain_matching=True)', 'saved = app.get',
  ])('disables all matching information in unusual Flask files: %s', code => {
    const result = find(flaskSetup + flaskHandler.replace('<user_id>', '<int:user_id>') + code);
    expect(result.odd).toBe(true);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].unmatched).toBe(true);
    expect(result.routes[0].segments).toBeUndefined();
    expect(result.routes[0].typed).toBeUndefined();
  });
  it('gives up on an overlong prefix before joining it to every route', () => {
    // Trimming 40,000 slashes that do not end the text took 33 s for 50 routes before the length check.
    const prefix = '/'.repeat(40_000) + 'x';
    const routes = Array.from({ length: 50 }, (_, i) => `@bp.route("/r${i}")\ndef h${i}(): pass`).join('\n');
    const started = performance.now();
    const result = find(`from flask import Blueprint\nbp = Blueprint("b", __name__, url_prefix="${prefix}")\n${routes}`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.routes).toHaveLength(50);
    expect(result.routes.every(route => route.path === null)).toBe(true);
    const long = find(`from flask import Blueprint\nbp = Blueprint("b", __name__, url_prefix="/api")\n@bp.route("/${'x'.repeat(400)}")\ndef h(): pass`);
    expect(long.routes[0].path).toBeNull();
  });
  it('does not trust a constructor name that is also subclassed', () => {
    for (const setup of [flaskSetup, 'from fastapi import FastAPI\napp = FastAPI()\n']) {
      const base = setup === flaskSetup ? 'Flask' : 'FastAPI';
      expect(find(setup + `@app.get("/x")\ndef h(): pass\nclass App(${base}):\n    pass`).routes).toEqual([]);
    }
    expect(find(flaskSetup + flaskHandler + 'class App(Flask):\n    url_rule_class = X')).toMatchObject({ odd: true, routes: [] });
  });
  it.each([
    'app.url_map.strict_slashes = False', "app.config['X'] = 1", 'app.wsgi_app = ProxyFix(app.wsgi_app)',
    'bp = Blueprint("users", __name__)\napp.register_blueprint(bp)', 'app.secret_key = "fixture"', 's = "converters"',
    'saved = app.api_route',
  ])('keeps ordinary Flask attributes: %s', code => {
    const result = find(flaskSetup + flaskHandler + code);
    expect(result.odd).toBe(false);
    expect(result.routes[0].unmatched).toBeUndefined();
    expect(result.routes[0].segments).toHaveLength(2);
  });
  it.each(['saved = app.route', 'app.route = other', 'converters = X', 'host_matching = True'])('preserves FastAPI-only name rules: %s', code => {
    expect(find(setup + handler + code)).toMatchObject({ odd: false, routes: find().routes });
  });
  it('keeps watched reads framework-specific, but marks an unusual mixed file as a whole', () => {
    expect(find(setup + handler + 'saved = app.get').odd).toBe(true);
    const mixed = setup + handler + '\nfrom flask import Flask\nother = Flask(__name__, host_matching=True, static_host="example.com")';
    expect(find(mixed)).toMatchObject({ odd: true, routes: [{ framework: 'fastapi', unmatched: true }] });
    expect(find(mixed).routes[0].segments).toBeUndefined();
  });
});

describe('Flask paths, settings and limits', () => {
  it.each(['endpoint="name"', 'defaults={"page": 1}', 'strict_slashes=False', 'merge_slashes=False', 'provide_automatic_options=False'])('permits route keyword %s', arg => {
    const route = find(flaskSetup + `@app.route(rule="/x", ${arg})\ndef h(): pass`).routes[0];
    expect(route).toMatchObject({ path: '/x', segments: [{ text: 'x' }] });
    expect(route.unmatched).toBeUndefined();
  });
  it.each(['subdomain="api"', 'host="example.com"', 'redirect_to="/elsewhere"', 'build_only=True', 'websocket=True', 'alias=True', 'unknown=True', '*args', '**options'])('rejects route option %s', arg => {
    const route = find(flaskSetup + `@app.route("/x", ${arg})\ndef h(): pass`).routes[0];
    expect(route).toMatchObject({ path: '/x', unmatched: true });
    expect(route.segments).toBeUndefined();
    expect(route.typed).toBeUndefined();
  });
  it.each(['f"/x/{id}"', 'r"/x"', 'b"/x"', '"/x" "/y"', '"/x\\n"', 'path_value', '"/x" + "/y"'])('keeps unreadable Flask paths null: %s', value => {
    const route = find(flaskSetup + `@app.route(${value})\ndef h(): pass`).routes[0];
    expect(route.path).toBeNull();
    expect(route.segments).toBeUndefined();
    expect(route.typed).toBeUndefined();
  });
  it.each([
    ['/users/<id>', [{ text: 'users' }, { param: 'id' }], false],
    ['/users/<string:id>', [{ text: 'users' }, { param: 'id' }], false],
    ['/users/<int:id>', [{ text: 'users' }, { param: 'id' }], true],
    ['/<float:x>', [{ param: 'x' }], true], ['/<uuid:x>', [{ param: 'x' }], true],
    ['/<string(length=2):x>', [{ param: 'x' }], true], ['/<int(min=1):x>', [{ param: 'x' }], true],
    ['/<float(min=1):x>', [{ param: 'x' }], true], ['/<uuid():x>', [{ param: 'x' }], true],
    ['/files/<path:p>', [{ text: 'files' }, { catchAll: 'p', optional: false }], false],
    ['/users/', [{ text: 'users' }], false], ['/', [], false], ['/a._~-09', [{ text: 'a._~-09' }], false],
  ])('expresses Flask segments: %s', (path, segments, typed) => {
    const route = find(flaskSetup + `@app.route('${path}')\ndef h(): pass`).routes[0];
    expect(route.path).toBe(path);
    expect(route.segments).toEqual(segments);
    expect(route.typed).toBe(typed ? true : undefined);
    expect(route.unmatched).toBeUndefined();
  });
  it.each(['', 'users', '/users//me', '/<any(a,b):x>', '/<regex("[a-z]+"):x>', '/<default:x>', '/v<int:n>', '/<a>-<b>',
    '/files/<path:p>/meta', '/files/<path:p>/', '/files/<', '/files/<사용자>', '/사용자', '/a%20b', '/files/:name', '/files/{id}',
    '/<path():p>', '/<string(foo(bar)):x>', '/<string(a/b):x>', '/<int:1x>', '/<int:id>/bad!', '//'])('keeps unsupported Flask paths unmatchable: %s', path => {
    const route = find(flaskSetup + `@app.route('${path}')\ndef h(): pass`).routes[0];
    expect(route.path).toBe(path);
    expect(route.unmatched).toBe(true);
    expect(route.segments).toBeUndefined();
    expect(route.typed).toBeUndefined();
  });
  it.each([
    ['url_prefix="/users"', '/<id>', '/users/<id>'], ['url_prefix="/api/"', '/users', '/api/users'],
    ['url_prefix="/api"', '', '/api'], ['', '/x', '/x'], ['url_prefix=unknown', '/x', '/x'],
    ['url_prefix="/api", **opts', '/x', '/x'], ['url_prefix="api"', '/x', 'api/x'],
  ])('joins Blueprint boundaries, retaining unknown deployment prefixes: %s', (args, written, path) => {
    const result = find(`from flask import Blueprint\napp = Blueprint('users', __name__, ${args})\n@app.route('${written}')\ndef h(): pass`);
    expect(result.routers).toEqual(['flask']);
    expect(result.routes[0]).toMatchObject({ path, prefix: 'unknown', framework: 'flask' });
    expect(result.routes[0].unmatched).toBe(path.startsWith('/') ? undefined : true);
  });
  it('tracks both kinds of router only when they declare routes', () => {
    const result = find(setup + 'router = APIRouter()\n@router.get("/x")\ndef h(): pass\n' + flaskSetup
      + 'bp = Blueprint("users", __name__)\n@bp.route("/y")\ndef other(): pass');
    expect(result.routers).toEqual(['fastapi', 'flask']);
    expect(find(flaskSetup + 'bp = Blueprint("users", __name__)\n' + flaskHandler).routers).toEqual([]);
  });
  it.each(['Flask(__name__)', 'Flask(import_name=__name__)',
    'Flask(__name__, static_folder="s", template_folder="t", static_url_path="/s", instance_path="p", instance_relative_config=True, root_path="x")'])('permits address-neutral Flask constructor options: %s', create => {
    const result = find(flaskSetup.replace('Flask(__name__)', create) + flaskHandler);
    expect(result.odd).toBe(false);
    expect(result.routes[0]).toMatchObject({ prefix: 'known', segments: [{ text: 'users' }, { param: 'user_id' }] });
    expect(result.routes[0].unmatched).toBeUndefined();
  });
  it.each(['Flask(__name__, static_host="x")', 'Flask(__name__, **opts)', 'Flask(*args)', 'Flask(__name__, unknown=True)',
    'Flask(__name__, None, None, None, True)', 'Flask(__name__, "/s")'])('rejects only the app with unsupported Flask constructor options: %s', create => {
    const result = find(flaskSetup.replace('Flask(__name__)', create) + flaskHandler
      + '\nsafe = Flask(__name__)\n@safe.route("/safe")\ndef safe_handler(): pass');
    expect(result.odd).toBe(false);
    expect(result.routes[0]).toMatchObject({ unmatched: true, prefix: 'known' });
    expect(result.routes[0].segments).toBeUndefined();
    expect(result.routes[1].unmatched).toBeUndefined();
  });
  it.each(['Flask(__name__, host_matching=True, static_host="x")', 'Flask(__name__, subdomain_matching=True)'])('marks routing machinery as unusual: %s', create => {
    expect(find(flaskSetup.replace('Flask(__name__)', create) + flaskHandler)).toMatchObject({ odd: true, routes: [{ unmatched: true }] });
  });
  it('applies root_path and redirect_slashes only to FastAPI apps in a mixed file', () => {
    const result = find(setup + '@app.get("/users/")\ndef h(): pass\n' + flaskSetup.replaceAll('app =', 'other =')
      + '@other.route("/users/")\ndef other_h(): pass\nroot_path = "/api"\nredirect_slashes = False');
    expect(result.odd).toBe(false);
    expect(result.routes[0]).toMatchObject({ framework: 'fastapi', prefix: 'unknown', unmatched: true });
    expect(result.routes[1]).toMatchObject({ framework: 'flask', prefix: 'known', segments: [{ text: 'users' }] });
    expect(result.routes[1].unmatched).toBeUndefined();
  });
  it('respects route, node, name and path limits without retaining matching information', () => {
    expect(find(flaskSetup + '@app.route("/x", methods=["GET", "POST"])\ndef h(): pass', 1000, 1))
      .toMatchObject({ cut: true, routes: [{ method: 'GET' }] });
    expect(find(flaskSetup + flaskHandler, 1000, 1)).toMatchObject({ cut: false, routes: [{ method: 'GET' }] });
    expect(find(flaskSetup + flaskHandler, 0)).toMatchObject({ complete: false, routes: [] });
    const partial = find(flaskSetup + flaskHandler.replace('<user_id>', '<int:user_id>') + '\nx = 1\n'.repeat(100), 120);
    expect(partial).toMatchObject({ complete: false, odd: false, routes: [{ unmatched: true }] });
    expect(partial.routes[0].segments).toBeUndefined();
    expect(partial.routes[0].typed).toBeUndefined();
    expect(find(flaskSetup + '@app.route()\ndef h(): pass').routes[0]).toMatchObject({ path: '', unmatched: true });
    for (const path of ['/' + 'x'.repeat(400), '/' + 'a/'.repeat(31)]) {
      expect(find(flaskSetup + `@app.route('${path}')\ndef h(): pass`).routes[0].path).toBeNull();
    }
  });
});

describe('FastAPI typed path parameters', () => {
  it.each(['int', 'float', 'uuid', 'str'])('reads the single-segment converter %s', converter => {
    const route = find(setup + `@app.get('/users/{id:${converter}}')\ndef h(): pass`).routes[0];
    expect(route.segments).toEqual([{ text: 'users' }, { param: 'id' }]);
    expect(route.typed).toBe(converter === 'str' ? undefined : true);
    expect(route.unmatched).toBeUndefined();
  });
  it.each(['/{id:regex}', '/v{n}', '/{a}-{b}', '/{id:int}/bad!'])('does not keep typed or segments on unsupported paths: %s', path => {
    const route = find(setup + `@app.get('${path}')\ndef h(): pass`).routes[0];
    expect(route.unmatched).toBe(true);
    expect(route.segments).toBeUndefined();
    expect(route.typed).toBeUndefined();
  });
});
