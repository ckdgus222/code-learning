import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { scanProject } from '../src/core/project/files';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const fast = 'from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = APIRouter(prefix="/v1")\n@router.get("/users")\ndef users():\n    pass\n';
const flask = 'from flask import Flask, Blueprint\napp = Flask(__name__)\nbp = Blueprint("users", __name__, url_prefix="/v1")\n@bp.route("/users")\ndef users():\n    pass\n';
const find = (text: string, maxRoutes = 1000) => pythonRoutes(file, walkPython(text, file.relativePath, 200_000), hash, maxRoutes);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function projectOf(text: string, url: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-registration-')));
  roots.push(root);
  await writeFile(path.join(root, 'main.py'), text);
  await writeFile(path.join(root, 'client.ts'), `export function load() { fetch(${JSON.stringify(url)}); }`);
  const project = await scanProject(root, randomUUID());
  return { root, project, routes: await findProjectRoutes(root, project.id, project.files) };
}

describe('Python same-file direct router registration', () => {
  it.each([
    ['APIRouter()', 'app.include_router(router, prefix=config)'],
    ['APIRouter(prefix=config)', 'app.include_router(router)'],
  ])('does not skip unresolved registration settings when the child has no listed paths: %s', (constructor, registration) => {
    const text = `from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = ${constructor}\n@app.get("/direct")\ndef direct():\n    pass\n${registration}\n`;
    expect(find(text).routes.find(route => route.handler.name === 'direct')).toMatchObject({ prefix: 'unknown' });
  });
  it('combines FastAPI registration, constructor and route prefixes while retaining source evidence', () => {
    const text = fast + 'app.include_router(router, prefix="/api")\n';
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/api/v1/users', prefix: 'known', handler: { name: 'users', fileId: file.id, fileHash: hash } });
    const basis = result.routes[0].basis;
    expect(text.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
    expect(basis.text).toContain('@router.get');
  });
  it('preserves repeated slash spelling instead of silently normalizing it', () => {
    const text = fast.replace('/v1', '/v1/') + 'app.include_router(router, prefix="/api/")\n';
    expect(find(text).routes.map(route => route.path)).toEqual(['/api//v1//users']);
  });
  it('emits each FastAPI registration and replaces the unknown router template', () => {
    const result = find(fast + 'app.include_router(router, prefix="/one")\napp.include_router(router, prefix="/two")\n');
    expect(result.routes.map(route => [route.path, route.prefix])).toEqual([['/one/v1/users', 'known'], ['/two/v1/users', 'known']]);
  });
  it.each([
    ['', '/v1/users'], [', url_prefix=None', '/v1/users'], [', url_prefix=""', '/users'], [', url_prefix="/api"', '/api/users'],
  ])('applies Flask url_prefix override semantics for %s', (option, expected) => {
    const result = find(flask + `app.register_blueprint(bp${option})\n`);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: expected, prefix: 'known' });
  });
  it('withholds duplicate effective Flask blueprint names on the same app', () => {
    const result = find(flask + 'app.register_blueprint(bp, url_prefix="/one")\napp.register_blueprint(bp, url_prefix="/two")\n');
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });
  it('accepts distinct literal Flask registration names', () => {
    const result = find(flask + 'app.register_blueprint(bp, url_prefix="/one", name="first")\napp.register_blueprint(bp, url_prefix="/two", name="second")\n');
    expect(result.routes.map(route => [route.path, route.prefix])).toEqual([['/one/users', 'known'], ['/two/users', 'known']]);
  });
  it.each([
    ['conditional', 'if flag:\n    app.include_router(router, prefix="/api")\n'],
    ['nested', 'def install():\n    app.include_router(router, prefix="/api")\n'],
    ['dynamic prefix', 'app.include_router(router, prefix=config)\n'],
    ['None prefix', 'app.include_router(router, prefix=None)\n'],
    ['spread options', 'app.include_router(router, **options)\n'],
    ['unsupported options', 'app.include_router(router, custom=True)\n'],
    ['escaped router', 'consume(router)\napp.include_router(router, prefix="/api")\n'],
    ['rebound router', 'router = replacement\napp.include_router(router, prefix="/api")\n'],
    ['changed registration method', 'app.include_router = replacement\napp.include_router(router, prefix="/api")\n'],
  ])('does not confirm %s registration', (_, registration) => {
    const result = find(fast + registration);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });
  it('does not assume declarations made after registration are included in every framework version', () => {
    const text = fast.replace('@router.get', 'app.include_router(router, prefix="/api")\n@router.get');
    const result = find(text);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });
  it('preserves the raw Flask route suffix when the override prefix is unresolved', () => {
    const result = find(flask + 'app.register_blueprint(bp, url_prefix=config)\n');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users', prefix: 'unknown' });
  });
  it('makes direct app routes uncertain when an unresolved registration can compete with them', () => {
    const text = fast + '@app.get("/direct")\ndef direct():\n    pass\napp.include_router(router, prefix=config)\n';
    const result = find(text);
    expect(result.routes.find(route => route.handler.name === 'direct')).toMatchObject({ path: '/direct', prefix: 'unknown' });
  });
  it('makes parent routes uncertain when an included child path cannot be represented', () => {
    const text = fast.replace('@router.get("/users")', '@router.get(dynamic)') + '@app.get("/direct")\ndef direct():\n    pass\napp.include_router(router)\n';
    const result = find(text);
    expect(result.routes.find(route => route.handler.name === 'direct')).toMatchObject({ prefix: 'unknown' });
  });
  it('keeps separate parent apps independent when only one registration is unresolved', () => {
    const text = fast + 'other = FastAPI()\n@other.get("/safe")\ndef safe():\n    pass\n@app.get("/unsafe")\ndef unsafe():\n    pass\napp.include_router(router, prefix=config)\n';
    const result = find(text);
    expect(result.routes.find(route => route.handler.name === 'safe')).toMatchObject({ path: '/safe', prefix: 'known' });
    expect(result.routes.find(route => route.handler.name === 'unsafe')).toMatchObject({ prefix: 'unknown' });
  });
  it('caps combinations at maxRoutes without silently keeping every composed registration', () => {
    const result = find(fast + 'app.include_router(router, prefix="/one")\napp.include_router(router, prefix="/two")\n', 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });
  it('does not confirm an overlong combined path by truncating its prefix', () => {
    const result = find(fast + `app.include_router(router, prefix="/${'x'.repeat(400)}")\n`);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
    expect(result.routes.every(route => route.path === null || route.path.length <= 300)).toBe(true);
  });
  it('does not promote registration inside an application factory to a known deployment prefix', () => {
    const text = 'from fastapi import FastAPI, APIRouter\ndef create_app():\n    app = FastAPI()\n    router = APIRouter()\n    @router.get("/users")\n    def users():\n        pass\n    app.include_router(router, prefix="/api")\n    return app\n';
    expect(find(text).routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });
  it('links a fully composed project route while keeping cancellation effective', async () => {
    const { root, project, routes } = await projectOf(fast + 'app.include_router(router, prefix="/api")\n', '/api/v1/users');
    expect(routes.routes).toHaveLength(1);
    expect(routes.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('remembers a child declaration after registration even when its template exceeds the output cap', () => {
    const text = fast + 'app.include_router(router, prefix="/api")\n@router.get("/late")\ndef late():\n    pass\n';
    const result = find(text, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('does not promote unsupported nested-router registrations into known parent routes', () => {
    const text = fast + 'parent = APIRouter()\nparent.include_router(router)\n@app.get("/direct")\ndef direct():\n    pass\napp.include_router(parent)\n';
    const result = find(text);
    expect(result.routes.find(route => route.handler.name === 'direct')).toMatchObject({ prefix: 'unknown' });
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it.each([
    ['conditional child', 'if flag:\n    @router.get("/hidden")\n    def hidden():\n        pass\n'],
    ['deferred child', 'def install():\n    @router.get("/hidden")\n    def hidden():\n        pass\n'],
    ['unsupported router registration method', 'router.add_api_route("/hidden", other)\n'],
    ['unsupported app mount', 'app.mount("/hidden", other)\n'],
    ['parenthesized method mutation', '(router).get = replacement\n'],
    ['deferred field mutation', 'def mutate():\n    router.get = replacement\n'],
  ])('does not confirm a related app with an unrepresented competing route: %s', (_, extra) => {
    const text = fast + extra + '@app.get("/direct")\ndef direct():\n    pass\napp.include_router(router, prefix="/api")\n';
    const result = find(text);
    const direct = result.routes.find(route => route.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });

  it('does not claim all child routes were inspected when the constructor supplies routes', () => {
    const text = fast.replace('APIRouter(prefix="/v1")', 'APIRouter(prefix="/v1", routes=existing)')
      + '@app.get("/direct")\ndef direct():\n    pass\napp.include_router(router)\n';
    const direct = find(text).routes.find(route => route.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });

  it('detects duplicate effective names across two different Flask blueprints', () => {
    const text = flask + 'other = Blueprint("users", __name__)\n@other.route("/other")\ndef other_handler():\n    pass\n'
      + 'app.register_blueprint(bp)\napp.register_blueprint(other)\n';
    const result = find(text);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('accepts a missing Flask constructor prefix with an explicit None registration prefix', () => {
    const result = find(flask.replace(', url_prefix="/v1"', '') + 'app.register_blueprint(bp, url_prefix=None)\n');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users', prefix: 'known' });
  });

  it('keeps repeated long registration options bounded without truncating them into known paths', () => {
    const prefix = '/' + 'x'.repeat(2000);
    const registrations = Array.from({ length: 20 }, (_, i) => `app.register_blueprint(bp, name="${'n'.repeat(1000)}${i}", url_prefix="${prefix}")`).join('\n');
    const result = find(flask + registrations, 3);
    expect(result.routes.length).toBeLessThanOrEqual(3);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
    expect(result.routes.every(route => route.path === null || route.path.length <= 300)).toBe(true);
  });

  it.each([
    ['parenthesized argument', '    consume((router))'],
    ['keyword argument', '    consume(value=(router))'],
    ['container argument', '    consume([router])'],
    ['parenthesized alias', '    alias = (router)\n    consume(alias)'],
    ['returned router', '    return (router)'],
  ])('rejects hidden router escape through %s', (_, operation) => {
    const text = fast + `def mutate():\n${operation}\nmutate()\napp.include_router(router, prefix="/api")\n`;
    const result = find(text);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it.each([
    'Blueprint("users", __name__, name="other")',
    'Blueprint("users", __name__, import_name="other")',
    'Blueprint("users")',
  ])('does not accept an invalid Blueprint required-argument binding: %s', constructor => {
    const text = flask.replace('Blueprint("users", __name__, url_prefix="/v1")', constructor) + 'app.register_blueprint(bp)\n';
    expect(find(text).routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('accepts exactly one keyword supply of each required Blueprint argument', () => {
    const text = flask.replace('Blueprint("users", __name__, url_prefix="/v1")', 'Blueprint(import_name=__name__, name="users", url_prefix="/v1")')
      + 'app.register_blueprint(bp)\n';
    expect(find(text).routes).toMatchObject([{ path: '/v1/users', prefix: 'known' }]);
    expect(find(text).routes).toHaveLength(1);
  });

  it('limits distinct registration combinations even when the output cap permits the entire product', () => {
    const declarations = Array.from({ length: 800 }, (_, i) => `@router.get("/route${i}")\ndef route${i}():\n    pass\n`).join('');
    const registrations = Array.from({ length: 100 }, (_, i) => `app.include_router(router, prefix="/prefix${i}${'x'.repeat(100)}")\n`).join('');
    const text = 'from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = APIRouter()\n' + declarations + registrations;
    const result = find(text, 100_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(80_000);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });
});
