import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
const file = { id: 'python', relativePath: 'server/main.py', size: 0 };
const hash = 'a'.repeat(64);
const imports = 'from fastapi import FastAPI, APIRouter\n';
const fastBody = '    app = FastAPI()\n    router = APIRouter(prefix="/v1")\n    @router.get("/users")\n    def users():\n        pass\n    app.include_router(router, prefix="/api")\n    return app\n';
const fast = imports + 'def create_app():\n' + fastBody;
const flaskImports = 'from flask import Flask, Blueprint\n';
const flaskBody = '    app = Flask(__name__)\n    bp = Blueprint("users", __name__, url_prefix="/v1")\n    @bp.route("/users")\n    def users():\n        pass\n';
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
function noComposed(text: string) {
  const result = find(text);
  expect(result.routes.some(route => route.path?.startsWith('/api/'))).toBe(false);
  expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
}

describe('Python factory-local direct router registration', () => {
  it('combines FastAPI prefixes without claiming a deployed prefix and keeps exact original evidence', () => {
    const text = '# 😀\n' + fast;
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    const route = result.routes[0];
    expect(route).toMatchObject({ path: '/api/v1/users', prefix: 'unknown', framework: 'fastapi' });
    const symbol = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name.endsWith('users'))!;
    expect(symbol).toBeDefined();
    expect(route.handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    expect(text.slice(route.basis.range.startUtf16, route.basis.range.endUtf16)).toBe(route.basis.text);
    expect(route.basis.text).toContain('@router.get');
  });
  it.each([['', '/v1/users'], [', url_prefix=None', '/v1/users'], [', url_prefix=""', '/users'], [', url_prefix="/api"', '/api/users']])('uses Flask override semantics in a returned factory app: %s', (option, expected) => {
    const result = find(flaskImports + 'def assemble():\n' + flaskBody + `    app.register_blueprint(bp${option})\n    return app\n`);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: expected, prefix: 'unknown' });
  });
  it('emits each FastAPI include and replaces the unresolved router template', () => {
    const text = fast.replace('    app.include_router(router, prefix="/api")', '    app.include_router(router, prefix="/one")\n    app.include_router(router, prefix="/two")');
    expect(find(text).routes.map(route => [route.path, route.prefix])).toEqual([['/one/v1/users', 'unknown'], ['/two/v1/users', 'unknown']]);
  });
  it('separates same-named owners across independent factory scopes', () => {
    const result = find(imports + 'def one():\n' + fastBody + 'def two():\n' + fastBody.replace('/api', '/other'));
    expect(result.routes.map(route => route.path)).toEqual(['/api/v1/users', '/other/v1/users']);
    expect(new Set(result.routes.map(route => route.handler.startUtf16)).size).toBe(2);
  });
  it.each([
    ['constructor parameter', 'def create_app(APIRouter):\n' + fastBody],
    ['constructor assigned before', 'def create_app():\n    APIRouter = replacement\n' + fastBody],
    ['constructor assigned after', 'def create_app():\n' + fastBody.replace('    return app', '    APIRouter = replacement\n    return app')],
    ['local constructor import', 'def create_app():\n    from fastapi import APIRouter\n' + fastBody],
    ['app constructor parameter', 'def create_app(FastAPI):\n' + fastBody],
  ])('does not resolve a shadowed factory constructor: %s', (_, factory) => noComposed(imports + factory));
  it('does not resolve a framework module alias shadowed by a factory parameter', () => {
    noComposed('import fastapi as f\ndef create_app(f):\n' + fastBody.replace('FastAPI()', 'f.FastAPI()').replace('APIRouter(', 'f.APIRouter('));
  });
  it.each([
    '    poison(APIRouter)\n',
    '    poison(FastAPI)\n',
    '    def mutate():\n        poison((APIRouter))\n    mutate()\n',
  ])('does not compose after a constructor is passed to other code: %s', effect => {
    noComposed(fast.replace('    app.include_router', effect + '    app.include_router'));
  });
  it.each(['    poison(f)\n', '    poison(f.APIRouter)\n'])('does not compose after framework constructor access escapes: %s', effect => {
    const text = 'import fastapi as f\ndef create_app():\n'
      + fastBody.replace('FastAPI()', 'f.FastAPI()').replace('APIRouter(', 'f.APIRouter(');
    noComposed(text.replace('    app.include_router', effect + '    app.include_router'));
  });
  it('still permits framework module constructor calls inside a factory', () => {
    const text = 'import fastapi as f\ndef create_app():\n'
      + fastBody.replace('FastAPI()', 'f.FastAPI()').replace('APIRouter(', 'f.APIRouter(');
    expect(find(text).routes).toMatchObject([{ path: '/api/v1/users', prefix: 'unknown' }]);
  });
  it.each([
    ['router reassignment', '    router = other\n'],
    ['app reassignment', '    app = other\n'],
    ['for binding', '    for router in items:\n        pass\n'],
    ['with binding', '    with manager() as router:\n        pass\n'],
    ['exception binding', '    try:\n        pass\n    except Error as router:\n        pass\n'],
  ])('does not compose a route after owner %s', (_, effect) => {
    noComposed(fast.replace('    app.include_router', effect + '    app.include_router'));
  });
  it.each([
    ['nested nonlocal mutation', '    def mutate():\n        nonlocal router\n        router = other\n    mutate()\n'],
    ['dictionary mutation', '    (router).__dict__.update(get=other)\n'],
    ['setattr mutation', '    setattr((router), "get", other)\n'],
    ['deferred method mutation', '    def mutate():\n        router.get = other\n    mutate()\n'],
  ])('does not compose a route after %s', (_, effect) => noComposed(fast.replace('    app.include_router', effect + '    app.include_router')));
  it.each([
    ['stash', '    stash(router)\n'],
    ['alias', '    alias = router\n'],
    ['container', '    stash([router])\n'],
    ['parenthesized keyword', '    stash(value=(router))\n'],
  ])('does not treat an escaped router as an isolated factory local: %s', (_, effect) => noComposed(fast.replace('    app.include_router', effect + '    app.include_router')));
  it.each([
    ['nested return only', '    def get_app():\n        return app\n'],
    ['alias return', '    alias = app\n    return alias\n'],
    ['multiple returns', '    if flag:\n        return app\n    return app\n'],
  ])('requires one final direct return of the app: %s', (_, ending) => noComposed(fast.replace('    return app\n', ending)));
  it.each([
    ['registration before declaration', fast.replace('    @router.get', '    app.include_router(router, prefix="/api")\n    @router.get').replace('    app.include_router(router, prefix="/api")\n    return app', '    return app')],
    ['conditional registration', fast.replace('    app.include_router', '    if flag:\n        app.include_router')],
    ['nested registration', fast.replace('    app.include_router(router, prefix="/api")', '    def install():\n        app.include_router(router, prefix="/api")\n    install()')],
  ])('does not compose uncertain registration order or execution: %s', (_, text) => noComposed(text));
  it('does not resolve a module router as a factory-local router', () => {
    const text = imports + 'router = APIRouter(prefix="/v1")\n@router.get("/users")\ndef users():\n    pass\ndef create_app():\n    app = FastAPI()\n    app.include_router(router, prefix="/api")\n    return app\n';
    noComposed(text);
  });
  it('does not compose duplicate Blueprint registrations with the same effective name', () => {
    const result = find(flaskImports + 'def assemble():\n' + flaskBody
      + '    app.register_blueprint(bp, url_prefix="/api")\n    app.register_blueprint(bp, url_prefix="/other")\n    return app\n');
    expect(result.routes.some(route => ['/api/users', '/other/users'].includes(route.path ?? '') && !route.unmatched)).toBe(false);
  });
  it('applies the route output cap to registration combinations', () => {
    const text = fast.replace('    app.include_router(router, prefix="/api")', '    app.include_router(router, prefix="/one")\n    app.include_router(router, prefix="/two")');
    const result = find(text, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });
  it('shares the registration validation budget across factory scopes rather than resetting it for each factory', () => {
    const factories = Array.from({ length: 4 }, (_, factory) => {
      const declarations = Array.from({ length: 200 }, (_, i) => `    @router.get("/route${i}")\n    def route${i}():\n        pass\n`).join('');
      const registrations = Array.from({ length: 100 }, (_, i) => `    app.include_router(router, prefix="/f${factory}p${i}${'x'.repeat(100)}")\n`).join('');
      return `def factory${factory}():\n    app = FastAPI()\n    router = APIRouter()\n${declarations}${registrations}    return app\n`;
    }).join('');
    const result = find(imports + factories, 100_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(80_000);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('preserves the earlier direct factory app route pattern', () => {
    const text = imports + 'def create_app():\n    app = FastAPI()\n    @app.get("/direct")\n    def direct():\n        pass\n    return app\n';
    expect(find(text).routes).toMatchObject([{ path: '/direct', prefix: 'unknown' }]);
    expect(find(text).routes).toHaveLength(1);
  });
});
