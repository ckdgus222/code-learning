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
import { importedAppRoutes } from '../src/core/analysis/python-route-imports';
import { readPythonFacts, type PythonFileFacts } from '../src/core/analysis/python-names';
import { pythonRoutes, walkPython, type PythonRouteImportFacts } from '../src/core/analysis/python-routes';
import type { ProjectFiles } from '../src/shared/contracts';
let root: string;
let project: ProjectFiles;
const routerSource = 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/v1")\n@router.get("/users")\ndef users():\n    return 1\n';
const parent = 'from fastapi import FastAPI\nfrom .router import router as api\napp = FastAPI()\napp.include_router(api, prefix="/api")\n';
const blueprintSource = 'from flask import Blueprint\nrouter = Blueprint("users", __name__, url_prefix="/v1")\n@router.route("/users")\ndef users():\n    return 1\n';
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-imported-router-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', 'pkg/router.py': routerSource, 'pkg/main.py': parent, ...extra })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
const search = (limits = MAP_LIMITS) => findProjectRoutes(root, project.id, project.files, limits);
async function noComposed() {
  const result = await search();
  expect(result.routes.some(route => route.path?.startsWith('/api/'))).toBe(false);
  return result;
}

describe('Python imported router declarations and direct registration', () => {
  it.each([false, true])('revokes child read exemptions when the parent module escapes, including chains: %s', async chained => {
    const origin = 'from fastapi import FastAPI\norigin_app = FastAPI()\n@origin_app.get("/origin")\ndef origin():\n    pass\n';
    await prepare({
      'pkg/router.py': routerSource + (chained
        ? 'from fastapi import FastAPI\nfrom .leaf import router as leaf\napp = FastAPI()\napp.include_router(leaf, prefix="/leaf")\n'
        : origin),
      ...(chained ? { 'pkg/leaf.py': routerSource + origin } : {}),
      'pkg/extra.py': `from .${chained ? 'leaf' : 'router'} import router\n@router.get("/extra")\ndef extra():\n    pass\n`,
      'pkg/z_mutate.py': 'from . import main\nconsume(main)\n',
      'client.ts': 'export function load() { return fetch("/origin"); }',
    });
    const result = await search();
    expect(result.routes.some(route => route.path === '/v1/extra')).toBe(false);
    const originRoute = result.routes.find(route => route.handler.name === 'origin')!;
    expect(originRoute).toBeDefined();
    expect(originRoute.unmatched || originRoute.prefix === 'unknown').toBeTruthy();
    expect(result.links.some(link => link.sure)).toBe(false);
  });
  it('accepts a composed path exactly at the path length limit', async () => {
    const prefix = '/' + 'a'.repeat(293);
    await prepare({ 'pkg/router.py': routerSource.replace('"/v1"', JSON.stringify(prefix)).replace('"/users"', '"/x"') });
    expect((await search()).routes.some(route => route.path === '/api' + prefix + '/x' && !route.unmatched)).toBe(true);
  });
  it.each([
    ['from .router import router as api', 'api.get', 'from fastapi import APIRouter\nrouter = APIRouter()\n', 'fastapi'],
    ['from . import router as module', 'module.router.get', 'from fastapi import APIRouter\nrouter = APIRouter()\n', 'fastapi'],
    ['from .router import router as api', 'api.route', 'from flask import Blueprint\nrouter = Blueprint("r", __name__)\n', 'flask'],
    ['from . import router as module', 'module.router.route', 'from flask import Blueprint\nrouter = Blueprint("r", __name__)\n', 'flask'],
  ])('keeps imported direct decorator evidence in its own file: %s / %s', async (declaration, decorator, origin, framework) => {
    const text = `# 😀\n${declaration}\n@${decorator}("/users")\ndef users():\n    return 1\n`;
    await prepare({ 'pkg/router.py': origin, 'pkg/main.py': text });
    const result = await search();
    expect(result.routes).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols[0];
    expect(result.routes[0]).toMatchObject({ path: '/users', prefix: 'unknown', framework,
      handler: { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 } });
    expect(result.routes[0].basis.range).toMatchObject({ fileId: file.id, fileHash: hash });
    expect(text.slice(result.routes[0].basis.range.startUtf16, result.routes[0].basis.range.endUtf16)).toBe(`@${decorator}("/users")`);
  });

  it('composes FastAPI registration and source constructor prefixes with origin handler evidence', async () => {
    await prepare();
    const result = await search();
    const composed = result.routes.filter(route => route.path === '/api/v1/users');
    expect(composed).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/router.py')!;
    const { text, hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols[0];
    expect(composed[0]).toMatchObject({ prefix: 'unknown', handler: { fileId: file.id, fileHash: hash,
      startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 } });
    expect(composed[0].basis.range).toMatchObject({ fileId: file.id, fileHash: hash });
  });

  it.each([['', '/v1/users'], [', url_prefix=None', '/v1/users'], [', url_prefix=""', '/users'], [', url_prefix="/api"', '/api/users']])(
    'uses Flask imported Blueprint override semantics: %s', async (option, expected) => {
      await prepare({ 'pkg/router.py': blueprintSource,
        'pkg/main.py': `from flask import Flask\nfrom .router import router as api\napp = Flask(__name__)\napp.register_blueprint(api${option})\n` });
      const result = await search();
      expect(result.routes.some(route => route.path === expected && route.prefix === 'unknown')).toBe(true);
      // The source router template may remain; its presence must not make any route confirmed.
      expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
    });

  it.each([
    ['reexported router', 'from .original import router\n'],
    ['factory-created router', 'from fastapi import APIRouter\ndef create():\n    return APIRouter()\nrouter = create()\n'],
    ['reassigned router', routerSource + 'router = other\n'],
    ['malformed Blueprint constructor', 'from flask import Blueprint\nrouter = Blueprint("r", __name__, name="duplicate")\n@router.route("/users")\ndef users():\n    pass\n'],
    ['spread constructor', 'from fastapi import APIRouter\nrouter = APIRouter(**options)\n@router.get("/users")\ndef users():\n    pass\n'],
  ])('does not compose an unsupported source: %s', async (label, origin) => {
    await prepare({ 'pkg/router.py': origin, 'pkg/original.py': routerSource,
      ...(label === 'malformed Blueprint constructor' ? { 'pkg/main.py': 'from flask import Flask\nfrom .router import router as api\napp = Flask(__name__)\napp.register_blueprint(api, url_prefix="/api")\n' } : {}) });
    await noComposed();
  });

  it.each([
    ['alias reassignment', parent.replace('app.include_router', 'api = other\napp.include_router')],
    ['conditional import', parent.replace('from .router import router as api', 'if flag:\n    from .router import router as api')],
    ['late import', 'from fastapi import FastAPI\napp = FastAPI()\napp.include_router(api, prefix="/api")\nfrom .router import router as api\n'],
    ['separate escaped router', parent.replace('app.include_router', 'consume(api)\napp.include_router')],
  ])('does not let allowed registration hide unsafe caller use: %s', async (_, text) => {
    await prepare({ 'pkg/main.py': text });
    await noComposed();
  });

  it.each([
    'from .router import router\nrouter.routes.clear()\n',
    'from . import router\nrouter.__dict__.update(router=other)\n',
    'from .router import router\n(router).__dict__.update(get=other)\n',
  ])('checks later third-file mutations before composing imported routes: %j', async mutation => {
    await prepare({ 'pkg/z_mutate.py': mutation });
    await noComposed();
  });

  it('does not resolve registration on an imported parent app', async () => {
    await prepare({ 'pkg/application.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'pkg/main.py': 'from .application import app\nfrom .router import router\napp.include_router(router, prefix="/api")\n' });
    await noComposed();
  });

  it('does not follow a nested cross-file router graph', async () => {
    await prepare({ 'pkg/router.py': 'from fastapi import APIRouter\nfrom .original import router as child\nrouter = APIRouter(prefix="/v1")\nrouter.include_router(child)\n',
      'pkg/original.py': routerSource });
    await noComposed();
  });

  it('downgrades the parent when an imported child path is not statically representable', async () => {
    await prepare({ 'pkg/router.py': routerSource.replace('"/users"', 'dynamic'),
      'pkg/main.py': parent.replace('app.include_router', '@app.get("/direct")\ndef direct():\n    pass\napp.include_router') });
    const result = await search();
    const direct = result.routes.find(route => route.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });

  it('does not leave a local Flask parent confirmed when local and imported Blueprint names compete', async () => {
    await prepare({ 'pkg/router.py': blueprintSource,
      'pkg/main.py': 'from flask import Flask, Blueprint\nfrom .router import router as imported\napp = Flask(__name__)\nlocal = Blueprint("users", __name__)\n@app.route("/direct")\ndef direct():\n    pass\napp.register_blueprint(local)\napp.register_blueprint(imported, url_prefix="/api")\n' });
    const result = await search();
    const direct = result.routes.find(route => route.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
    const origin = project.files.find(file => file.relativePath === 'pkg/router.py')!;
    expect(result.routes.filter(route => route.handler.fileId === origin.id && route.path !== '/v1/users')).toEqual([]);
  });

  it.each(['file', 'byte', 'node'] as const)('does not compose from incomplete %s inspection', async budget => {
    await prepare();
    const limits = { ...MAP_LIMITS, ...(budget === 'file' ? { files: 2 } : budget === 'byte' ? { bytes: 1 } : { nodesPerFile: 5 }) };
    const result = await search(limits);
    expect(result.limited).toBe(true);
    expect(result.routes.some(route => route.path?.startsWith('/api/'))).toBe(false);
  });

  it('honors cancellation before imported registration analysis', async () => {
    await prepare();
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not relax ordinary function-call guards to recognize a router registration', async () => {
    const text = 'from fastapi import APIRouter\nrouter = APIRouter()\ndef helper():\n    pass\ndef run():\n    helper()\n';
    await prepare({ 'pkg/router.py': text,
      'pkg/z_mutate.py': 'from . import router as module\nconsume(module)\n' });
    const file = project.files.find(file => file.relativePath === 'pkg/router.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === 'run')!;
    const result = await findFunctionCalls(root, project.id, project.files,
      { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS);
    expect(result.calls[0]).toMatchObject({ status: 'unknown', reason: 'unclear-file' });
  });

  it.each([
    ['from . import router as module', 'module.router'],
    ['from .router import router as api', '(api)'],
    ['from .router import router as api', 'router=api'],
  ])('composes a supported imported registration argument: %s / %s', async (declaration, argument) => {
    await prepare({ 'pkg/main.py': `from fastapi import FastAPI\n${declaration}\napp = FastAPI()\napp.include_router(${argument}, prefix="/api")\n` });
    expect((await search()).routes.filter(route => route.path === '/api/v1/users')).toMatchObject([{ prefix: 'unknown' }]);
  });

  it('composes decorators written in a third file and preserves that file as the navigation target', async () => {
    const text = '# 😀\nfrom .router import router\n@router.get("/third")\ndef third():\n    pass\n';
    await prepare({ 'pkg/router.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/v1")\n', 'pkg/third.py': text });
    const result = await search();
    const routes = result.routes.filter(route => route.path === '/api/v1/third');
    expect(routes).toHaveLength(1);
    const file = project.files.find(file => file.relativePath === 'pkg/third.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols[0];
    expect(routes[0]).toMatchObject({ prefix: 'unknown', handler: { fileId: file.id, fileHash: hash,
      startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, basis: { range: { fileId: file.id, fileHash: hash } } });
  });

  it('emits separate imported compositions for each literal prefix', async () => {
    await prepare({ 'pkg/main.py': parent + 'app.include_router(api, prefix="/other")\n' });
    const result = await search();
    expect(result.routes.filter(route => ['/api/v1/users', '/other/v1/users'].includes(route.path ?? '')).map(route => route.path).sort())
      .toEqual(['/api/v1/users', '/other/v1/users'].sort());
  });

  it.each([
    'app.include_router(api, prefix="/api", **options)',
    'app.include_router(api, router=api, prefix="/api")',
    'app.include_router(api, prefix=config)',
    'app.include_router(api, prefix=None)',
  ])('does not compose a fixed prefix for invalid imported registration %s', async statement => {
    await prepare({ 'pkg/main.py': parent.replace('app.include_router(api, prefix="/api")', statement) });
    await noComposed();
  });

  it('does not exempt an allowed registration from ordinary call analysis escape guards', async () => {
    const text = 'from fastapi import APIRouter\nrouter = APIRouter()\ndef helper():\n    pass\ndef run():\n    helper()\n';
    await prepare({ 'pkg/router.py': text });
    const file = project.files.find(file => file.relativePath === 'pkg/router.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === 'run')!;
    const result = await findFunctionCalls(root, project.id, project.files,
      { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS);
    expect(result.calls[0]).toMatchObject({ status: 'unknown', reason: 'unclear-file' });
  });

  it('caps the project output after imported registration expansion', async () => {
    const declarations = Array.from({ length: 30 }, (_, i) => `@router.get("/r${i}")\ndef r${i}():\n    pass\n`).join('');
    const registrations = Array.from({ length: 50 }, (_, i) => `app.include_router(api, prefix="/p${i}")\n`).join('');
    await prepare({ 'pkg/router.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n' + declarations,
      'pkg/main.py': 'from fastapi import FastAPI\nfrom .router import router as api\napp = FastAPI()\n' + registrations });
    const result = await search();
    expect(result.limited).toBe(true);
    expect(result.routes.length).toBeLessThanOrEqual(1000);
    expect(result.routes.some(route => route.path?.startsWith('/p0/'))).toBe(true);
  });

  it('stops imported composition when its shared validation work is exhausted before the output limit', async () => {
    await prepare();
    const parsed = new Map<string, PythonFileFacts>();
    const sources = new Map<string, PythonRouteImportFacts>();
    const room = { owners: 1000, drafts: 1000, work: 5_000_000, cut: false };
    for (const file of project.files) {
      const { text, hash } = await readAllowed(root, file.relativePath);
      const walk = walkPython(text, file.relativePath, MAP_LIMITS.nodesPerFile);
      parsed.set(file.id, readPythonFacts(file, text, hash, MAP_LIMITS.nodesPerFile, false, true));
      const found = pythonRoutes(file, walk, hash, 1000, room);
      if (found.imports) sources.set(file.id, found.imports);
    }
    const complete = importedAppRoutes(project.files, parsed, sources, true, 1000, () => {});
    expect(complete.routes.some(route => route.path === '/api/v1/users')).toBe(true);
    const tiny = { owners: 1000, drafts: 1000, work: 1, cut: false };
    const limited = importedAppRoutes(project.files, parsed, sources, true, 1000, () => {}, tiny);
    expect(limited.cut).toBe(true);
    expect(tiny.cut).toBe(true);
    expect(limited.routes.some(route => route.path === '/api/v1/users')).toBe(false);
  });

  it('withholds the whole registration when the same file declares another child route after it', async () => {
    await prepare({ 'pkg/main.py': parent + '@api.get("/late")\ndef late():\n    pass\n' });
    const result = await search();
    expect(result.routes.some(route => route.path === '/api/v1/late')).toBe(false);
    expect(result.routes.some(route => route.path === '/api/v1/users')).toBe(false);
  });

  it('composes both source and same-file child routes when all declarations precede registration', async () => {
    const text = parent.replace('app.include_router(api, prefix="/api")', '@api.get("/early")\ndef early():\n    pass\napp.include_router(api, prefix="/api")');
    await prepare({ 'pkg/main.py': text });
    const result = await search();
    expect(result.routes.filter(route => route.path?.startsWith('/api/')).map(route => route.path).sort())
      .toEqual(['/api/v1/early', '/api/v1/users'].sort());
  });

  it.each([['..same', false], ['other', true]] as const)('compares final imported Flask names after stripping leading dots: %s', async (secondName, accepted) => {
    await prepare({ 'pkg/router.py': blueprintSource,
      'pkg/second.py': 'from flask import Blueprint\nrouter = Blueprint("second", __name__)\n@router.route("/second")\ndef second():\n    pass\n',
      'pkg/main.py': `from flask import Flask\nfrom .router import router as a\nfrom .second import router as b\napp = Flask(__name__)\napp.register_blueprint(a, name="same", url_prefix="/api/a")\napp.register_blueprint(b, name="${secondName}", url_prefix="/api/b")\n` });
    const composed = (await search()).routes.filter(route => route.path?.startsWith('/api/')).map(route => route.path).sort();
    expect(composed).toEqual(accepted ? ['/api/a/users', '/api/b/second'] : []);
  });

  it('detects leading-dot Flask name collisions between local and imported children', async () => {
    await prepare({ 'pkg/router.py': blueprintSource,
      'pkg/main.py': 'from flask import Flask, Blueprint\nfrom .router import router as imported\napp = Flask(__name__)\nlocal = Blueprint("local", __name__)\n@local.route("/local")\ndef local_handler():\n    pass\napp.register_blueprint(local, name="same", url_prefix="/api/local")\napp.register_blueprint(imported, name="..same", url_prefix="/api/imported")\n' });
    const result = await search();
    expect(result.routes.some(route => route.path === '/api/imported/v1/users' || route.path === '/api/imported/users')).toBe(false);
    expect(result.routes.filter(route => route.handler.name === 'local_handler'))
      .toEqual([expect.objectContaining({ path: '/api/local/local', prefix: 'unknown', basis: expect.objectContaining({ text: '@local.route("/local")' }) })]);
  });
});
