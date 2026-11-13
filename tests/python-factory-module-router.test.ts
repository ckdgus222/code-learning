import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readAllowed, scanProject } from '../src/core/project/files';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { analyzeSource } from '../src/core/analysis/syntax';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { ProjectFiles } from '../src/shared/contracts';
let root: string;
let project: ProjectFiles;
const router = 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/v1")\n@router.get("/users")\ndef users():\n    return 1\n';
const blueprint = 'from flask import Blueprint\nrouter = Blueprint("users", __name__, url_prefix="/v1")\n@router.route("/users")\ndef users():\n    return 1\n';
const fastImport = 'from fastapi import FastAPI\nfrom .router import router as api\n';
const fastBody = '    app = FastAPI()\n    app.include_router(api, prefix="/api")\n    return app\n';
const fastFactory = fastImport + 'def create_app():\n' + fastBody;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-factory-module-router-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', 'pkg/router.py': router, 'pkg/main.py': fastFactory, ...extra })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
const search = (limits = MAP_LIMITS) => findProjectRoutes(root, project.id, project.files, limits);
async function noComposed(text: string) {
  await prepare({ 'pkg/main.py': text });
  expect((await search()).routes.some(route => route.path?.startsWith('/api/'))).toBe(false);
}

describe('Python factory registration of module-owned routers', () => {
  it.each([
    '    @api.get("/extra")\n    def extra():\n        pass\n',
    '    api.get("/extra")(other)\n',
  ])('does not recover a module router with an unsupported deferred route registration: %s', async extra => {
    await noComposed('from fastapi import FastAPI\n' + router.replaceAll('router', 'api')
      + 'def create_app():\n    app = FastAPI()\n' + extra + '    app.include_router(api, prefix="/api")\n    return app\n');
  });
  it.each([
    ['FastAPI', false], ['FastAPI', true], ['Flask', false], ['Flask', true],
  ] as const)('composes %s %s imported module routers with exact original handler evidence', async (framework, imported) => {
    const origin = framework === 'FastAPI' ? router : blueprint;
    const frameworkImport = framework === 'FastAPI' ? 'from fastapi import FastAPI\n' : 'from flask import Flask\n';
    const create = framework === 'FastAPI' ? 'FastAPI()' : 'Flask(__name__)';
    const registration = framework === 'FastAPI' ? 'app.include_router(api, prefix="/api")' : 'app.register_blueprint(api, url_prefix="/api")';
    const text = frameworkImport + (imported ? 'from .router import router as api\n' : origin.replaceAll('router', 'api'))
      + `def assemble():\n    app = ${create}\n    ${registration}\n    return app\n`;
    await prepare({ 'pkg/router.py': origin, 'pkg/main.py': text });
    const expected = framework === 'FastAPI' ? '/api/v1/users' : '/api/users';
    const composed = (await search()).routes.filter(route => route.path === expected);
    expect(composed).toHaveLength(1);
    const relative = imported ? 'pkg/router.py' : 'pkg/main.py';
    const file = project.files.find(file => file.relativePath === relative)!;
    const source = await readAllowed(root, relative);
    const symbol = analyzeSource(source.text, relative, { projectId: project.id, fileId: file.id, fileHash: source.hash }).symbols.find(symbol => symbol.name === 'users')!;
    expect(composed[0]).toMatchObject({ prefix: 'unknown', handler: { fileId: file.id, fileHash: source.hash,
      startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, basis: { range: { fileId: file.id, fileHash: source.hash } } });
  });

  it.each([
    ['from . import router as module', 'module.router'],
    ['from .router import router as api', '(api)'],
    ['from .router import router as api', 'router=api'],
  ])('supports the imported registration form %s / %s', async (declaration, argument) => {
    await prepare({ 'pkg/main.py': `from fastapi import FastAPI\n${declaration}\ndef assemble():\n    app = FastAPI()\n    app.include_router(${argument}, prefix="/api")\n    return app\n` });
    expect((await search()).routes.filter(route => route.path === '/api/v1/users')).toMatchObject([{ prefix: 'unknown' }]);
  });

  it.each([['None', '/v1/users'], ['""', '/users']] as const)('preserves Flask prefix override %s in a factory', async (option, expected) => {
    await prepare({ 'pkg/router.py': blueprint,
      'pkg/main.py': `from flask import Flask\nfrom .router import router as api\ndef assemble():\n    app = Flask(__name__)\n    app.register_blueprint(api, url_prefix=${option})\n    return app\n` });
    const result = await search();
    expect(result.routes.some(route => route.path === expected && route.prefix === 'unknown')).toBe(true);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('keeps same-named apps in sibling factories separate', async () => {
    await prepare({ 'pkg/main.py': fastImport + 'def one():\n' + fastBody + 'def two():\n' + fastBody.replace('/api', '/other') });
    expect((await search()).routes.filter(route => ['/api/v1/users', '/other/v1/users'].includes(route.path ?? '')).map(route => route.path).sort())
      .toEqual(['/api/v1/users', '/other/v1/users'].sort());
  });

  it.each([
    ['router parameter', fastImport + 'def create_app(api):\n' + fastBody],
    ['constructor parameter', fastImport + 'def create_app(FastAPI):\n' + fastBody],
    ['earlier local assignment', fastImport + 'def create_app():\n    api = other\n' + fastBody],
    ['constructor escape', fastImport + 'def create_app():\n    consume(FastAPI)\n' + fastBody],
    ['later local assignment', fastFactory.replace('    return app', '    api = other\n    return app')],
    ['local import', fastImport + 'def create_app():\n    from .router import router as api\n' + fastBody],
    ['nested nonlocal app mutation', fastFactory.replace('    app.include_router', '    def mutate():\n        nonlocal app\n        app = other\n    mutate()\n    app.include_router')],
    ['app escape', fastFactory.replace('    return app', '    consume(app)\n    return app')],
    ['method changed before return', fastFactory.replace('    return app', '    app.include_router = other\n    return app')],
    ['router separately consumed', fastFactory.replace('    app.include_router', '    consume(api)\n    app.include_router')],
    ['nested registration', fastFactory.replace('    app.include_router(api, prefix="/api")', '    def register():\n        app.include_router(api, prefix="/api")\n    register()')],
    ['conditional registration', fastFactory.replace('    app.include_router', '    if flag:\n        app.include_router')],
    ['async factory', fastFactory.replace('def create_app', 'async def create_app')],
    ['different return', fastFactory.replace('    return app', '    return other')],
  ])('does not compose an unsafe factory registration: %s', async (_, text) => noComposed(text));

  it.each([false, true])('blocks imported Blueprint composition when a local or module Blueprint name conflicts (local=%s)', async local => {
    const declaration = 'local = Blueprint("users", __name__)\n';
    const text = 'from flask import Flask, Blueprint\nfrom .router import router as api\n' + (local ? '' : declaration)
      + 'def assemble():\n    app = Flask(__name__)\n' + (local ? '    ' + declaration : '')
      + '    app.register_blueprint(local, url_prefix="/local")\n    app.register_blueprint(api, url_prefix="/api")\n    return app\n';
    await prepare({ 'pkg/router.py': blueprint, 'pkg/main.py': text });
    const result = await search();
    expect(result.routes.some(route => route.path === '/api/users')).toBe(false);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('retains ordinary function-call escape guards despite allowed factory registration', async () => {
    const text = router + 'def helper():\n    pass\ndef run():\n    helper()\n';
    await prepare({ 'pkg/router.py': text });
    const file = project.files.find(file => file.relativePath === 'pkg/router.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === 'run')!;
    const result = await findFunctionCalls(root, project.id, project.files,
      { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS);
    expect(result.calls[0]).toMatchObject({ status: 'unknown', reason: 'unclear-file' });
  });

  it.each(['file', 'byte', 'node'] as const)('does not compose a router when the %s budget is incomplete', async budget => {
    await prepare();
    const result = await search({ ...MAP_LIMITS, ...(budget === 'file' ? { files: 2 } : budget === 'byte' ? { bytes: 1 } : { nodesPerFile: 5 }) });
    expect(result.limited).toBe(true);
    expect(result.routes.some(route => route.path?.startsWith('/api/'))).toBe(false);
  });

  it('honors cancellation before reading factory registration origins', async () => {
    await prepare();
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('preserves imported module app registration and factory-local registration', async () => {
    const local = 'from fastapi import FastAPI, APIRouter\ndef create_local():\n    app = FastAPI()\n    r = APIRouter(prefix="/local")\n    @r.get("/x")\n    def x():\n        pass\n    app.include_router(r)\n    return app\n';
    await prepare({ 'pkg/main.py': fastImport + 'app = FastAPI()\napp.include_router(api, prefix="/module")\n', 'pkg/local.py': local });
    const result = await search();
    expect(result.routes.find(route => route.path === '/module/v1/users')).toMatchObject({ prefix: 'unknown' });
    expect(result.routes.find(route => route.path === '/local/x')).toMatchObject({ prefix: 'unknown' });
  });

  it.each(['consume(api)\n', 'def leak():\n    consume(api)\n'])('does not recover a same-file module router separately consumed outside the factory: %j', async escape => {
    const text = 'from fastapi import FastAPI\n' + router.replaceAll('router', 'api') + escape
      + 'def create_app():\n' + fastBody;
    await noComposed(text);
  });

  it('does not restore a shared imported router through another factory after an unsafe parent registration', async () => {
    await prepare({ 'pkg/main.py': fastImport + 'def unsafe():\n' + fastBody.replace('prefix="/api"', 'prefix=config')
      + 'def normal():\n' + fastBody });
    expect((await search()).routes.some(route => route.path === '/api/v1/users')).toBe(false);
  });

  it('does not restore a shared Blueprint through a second factory after duplicate effective names', async () => {
    const text = 'from flask import Flask, Blueprint\nfrom .router import router as api\n'
      + 'def unsafe():\n    app = Flask(__name__)\n    local = Blueprint("users", __name__)\n    app.register_blueprint(local)\n    app.register_blueprint(api, url_prefix="/unsafe")\n    return app\n'
      + 'def normal():\n    app = Flask(__name__)\n    app.register_blueprint(api, url_prefix="/api")\n    return app\n';
    await prepare({ 'pkg/router.py': blueprint, 'pkg/main.py': text });
    expect((await search()).routes.some(route => route.path === '/api/users')).toBe(false);
  });

  it.each([false, true])('compares leading-dot effective names between factory-local and module-owned Blueprints (imported=%s)', async imported => {
    const text = 'from flask import Flask, Blueprint\n' + (imported ? 'from .router import router as api\n' : blueprint.replaceAll('router', 'api'))
      + 'def create_app():\n    app = Flask(__name__)\n    local = Blueprint("local", __name__)\n    app.register_blueprint(local, name="same")\n    app.register_blueprint(api, name="..same", url_prefix="/api")\n    return app\n';
    await prepare({ 'pkg/router.py': blueprint, 'pkg/main.py': text });
    const result = await search();
    expect(result.routes.some(route => route.path === '/api/users')).toBe(false);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it.each([
    'from . import main\nmain.api.get = other\n',
    'from . import main\nconsume(main)\n',
  ])('retains file-closure blocking after a third file changes or exposes the parent module: %j', async mutation => {
    await prepare({ 'pkg/z_mutate.py': mutation });
    expect((await search()).routes.some(route => route.path === '/api/v1/users')).toBe(false);
  });

  it('bounds repeated factory composition at the shared project output limit', async () => {
    const declarations = Array.from({ length: 30 }, (_, i) => `@router.get("/route${i}")\ndef route${i}():\n    pass\n`).join('');
    const factories = Array.from({ length: 50 }, (_, i) => `def create${i}():\n    app = FastAPI()\n    app.include_router(api, prefix="/factory${i}")\n    return app\n`).join('');
    await prepare({ 'pkg/router.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n' + declarations, 'pkg/main.py': fastImport + factories });
    const result = await search();
    expect(result.limited).toBe(true);
    expect(result.routes.length).toBeLessThanOrEqual(1000);
    expect(result.routes.some(route => route.path?.startsWith('/factory0/'))).toBe(true);
  });
});
