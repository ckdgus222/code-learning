import { describe, expect, it } from 'vitest';
import { fastapiRoutes } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { matchFunction } from '../src/renderer/map-layout';
import type { SourceView } from '../src/shared/contracts';

const file = { id: 'python', relativePath: 'server/main.py', size: 0 };
const setup = 'from fastapi import FastAPI, APIRouter\nimport fastapi as f\napp = FastAPI()\n';
const handler = '@app.get("/users/{user_id}")\nasync def read_user(user_id: int):\n    return find_user(user_id)\n';
const find = (text = setup + handler, nodes = 100_000, routes = 1000) => fastapiRoutes(file, text, 'hash', nodes, routes);

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
    expect(result).toMatchObject({ complete: true, cut: false, odd: false, usesRouter: false });
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
  it.each(['from flask import Flask as FastAPI', 'from starlette.routing import Router as FastAPI', 'from other import FastAPI',
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
    expect(result.usesRouter).toBe(true);
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
  it.each(['', '/users/{id:int}', '/users/{id:uuid}', '/v{n}', '/{a}-{b}', '/files/{p:path}/meta', '/files/{p:path}/',
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
