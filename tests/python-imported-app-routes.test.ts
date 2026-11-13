import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readAllowed, scanProject } from '../src/core/project/files';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import type { ProjectFiles } from '../src/shared/contracts';
let root: string;
let project: ProjectFiles;
const appSource = 'from fastapi import FastAPI\napp = FastAPI()\n';
const caller = 'from .application import app as api\n@api.get("/users")\ndef users():\n    return 1\n';
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-imported-app-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', 'pkg/application.py': appSource, 'pkg/routes.py': caller, ...extra })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
const search = (limits = MAP_LIMITS) => findProjectRoutes(root, project.id, project.files, limits);
async function noImported(limits = MAP_LIMITS) {
  const result = await search(limits);
  const local = project.files.find(file => file.relativePath === 'pkg/routes.py')!;
  expect(result.routes.filter(route => route.handler.fileId === local.id)).toEqual([]);
  return result;
}

describe('Python imported module-level app decorators', () => {
  it('finds a relative imported app while preserving the decorator file evidence', async () => {
    await prepare();
    const result = await search();
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users', prefix: 'unknown', framework: 'fastapi' });
    const file = project.files.find(file => file.relativePath === 'pkg/routes.py')!;
    const { text, hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols[0];
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    expect(result.routes[0].basis.range).toMatchObject({ fileId: file.id, fileHash: hash });
    expect(text.slice(result.routes[0].basis.range.startUtf16, result.routes[0].basis.range.endUtf16)).toBe('@api.get("/users")');
  });

  it.each([
    ['from .application import app', 'app.get', appSource, 'fastapi'],
    ['from . import application', 'application.app.get', appSource, 'fastapi'],
    ['from . import application as module', 'module.app.get', appSource, 'fastapi'],
    ['from .application import app as api', 'api.route', 'from flask import Flask\napp = Flask(__name__)\n', 'flask'],
    ['from . import application', 'application.app.route', 'from flask import Flask\napp = Flask(__name__)\n', 'flask'],
  ])('finds the imported decorator %s / %s', async (declaration, decorator, origin, framework) => {
    await prepare({ 'pkg/application.py': origin, 'pkg/routes.py': `${declaration}\n@${decorator}("/users")\ndef users():\n    pass\n` });
    const result = await search();
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users', prefix: 'unknown', framework });
  });

  it.each([
    ['rebound app', appSource + 'app = other\n'],
    ['conditional app', 'from fastapi import FastAPI\nif flag:\n    app = FastAPI()\n'],
    ['factory return', 'from fastapi import FastAPI\ndef create_app():\n    return FastAPI()\napp = create_app()\n'],
    ['reexport', 'from .original import app\n'],
    ['duplicate app', appSource + 'app = FastAPI()\n'],
    ['dynamic module', appSource + 'exec(code)\n'],
    ['incomplete source', appSource + ')\n'],
  ])('does not infer an imported app from %s', async (_, origin) => {
    await prepare({ 'pkg/application.py': origin, 'pkg/original.py': appSource });
    await noImported();
  });

  it.each([
    ['alias rebound', caller.replace('@api.get', 'api = other\n@api.get')],
    ['conditional import', caller.replace('from .application import app as api', 'if flag:\n    from .application import app as api')],
    ['duplicate import', 'from .application import app as api\n' + caller],
    ['late import', '@api.get("/users")\ndef users():\n    pass\nfrom .application import app as api\n'],
    ['bare execution-root import', caller.replace('from .application', 'from application')],
    ['string-like dynamic decorator receiver', 'from .application import app as api\n@getattr(api, "get")("/users")\ndef users():\n    pass\n'],
  ])('does not settle the caller binding after %s', async (_, text) => {
    await prepare({ 'pkg/routes.py': text });
    await noImported();
  });

  it.each([
    ['method overwrite', 'from . import application\napplication.app.get = other\n'],
    ['module dictionary mutation', 'from . import application\napplication.__dict__.update(app=other)\n'],
    ['parenthesized app escape', 'from . import application\nconsume((application.app))\n'],
    ['routing collection method', 'from .application import app\napp.router.routes.clear()\n'],
    ['mount method', 'from .application import app\napp.mount("/", ExternalASGI())\n'],
    ['route addition method', 'from .application import app\napp.router.add_api_route("/users", other)\n'],
    ['module routing collection', 'from . import application\napplication.app.router.routes.clear()\n'],
    ['deferred decorator', 'from .application import app\ndef configure():\n    @app.get("/origin")\n    def replacement():\n        pass\n'],
    ['nested decorator call', 'from .application import app\n@app.get("/origin")(other)\ndef replacement():\n    pass\n'],
    ['dynamic decorator path', 'from .application import app\n@app.get(config)\ndef replacement():\n    pass\n'],
    ['deep decorator receiver', 'from .application import app\n@app.router.get("/origin")\ndef replacement():\n    pass\n'],
    ['unsupported framework decorator', 'from .application import app\n@app.route("/origin")\ndef replacement():\n    pass\n'],
    ['parameter-only decorator path', 'from .application import app\n@app.get("/{name}")\ndef replacement():\n    pass\n'],
    ['root-only decorator path', 'from .application import app\n@app.get("/")\ndef replacement():\n    pass\n'],
  ])('applies a later file %s before emitting earlier imported or origin routes', async (_, mutation) => {
    await prepare({ 'pkg/application.py': appSource + '@app.get("/origin")\ndef origin():\n    pass\n', 'pkg/z_mutate.py': mutation });
    const result = await noImported();
    expect(result.routes.filter(route => route.path === '/origin').every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it('does not revisit deep receiver chains when route metadata is incomplete', () => {
    const text = '@api' + '.a'.repeat(20_000) + '.get("/users")\ndef users():\n    pass\n';
    const file = { id: 'deep', relativePath: 'deep.py', size: Buffer.byteLength(text) };
    const walk = walkPython(text, file.relativePath, 200_000);
    expect(walk.complete).toBe(false);
    const found = pythonRoutes(file, walk, 'a'.repeat(64), 1000, { owners: 1000, drafts: 1000, work: 5_000_000, cut: false });
    expect(found.imports?.drafts ?? []).toHaveLength(0);
  });

  it.each([
    ['dynamic initializer', { 'pkg/__init__.py': 'exec(code)\n' }],
    ['initializer name conflict', { 'pkg/__init__.py': 'application = other\n' }],
    ['module/package collision', { 'pkg/application/__init__.py': appSource }],
    ['framework project shadow', { 'fastapi.py': 'class FastAPI:\n    pass\n' }],
  ] as const)('does not trust app provenance through %s', async (_, extra) => {
    await prepare(extra);
    const result = await search();
    const local = project.files.find(file => file.relativePath === 'pkg/routes.py')!;
    expect(result.routes.filter(route => route.handler.fileId === local.id).every(route => route.unmatched)).toBe(true);
  });

  it('keeps normal origin-local and unrelated local app routes while adding imported candidates', async () => {
    await prepare({ 'pkg/application.py': appSource + '@app.get("/origin")\ndef origin():\n    pass\n',
      'other.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/other")\ndef other():\n    pass\n' });
    const result = await search();
    expect(result.routes.find(route => route.path === '/users')).toMatchObject({ prefix: 'unknown' });
    expect(result.routes.find(route => route.path === '/origin')).toMatchObject({ prefix: 'known' });
    expect(result.routes.find(route => route.path === '/other')).toMatchObject({ prefix: 'known' });
  });

  it('matches requests only as uncertain candidates even when the literal address matches', async () => {
    await prepare({ 'client.ts': 'export function load() { fetch("/users"); }' });
    const result = await search();
    expect(result.routes).toHaveLength(1);
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links.every(link => !link.sure)).toBe(true);
  });

  it.each(['file', 'byte', 'node'] as const)('withholds imported candidates when the %s read budget is incomplete', async budget => {
    await prepare();
    const limits = { ...MAP_LIMITS, ...(budget === 'file' ? { files: 2 } : budget === 'byte' ? { bytes: 1 } : { nodesPerFile: 5 }) };
    const result = await noImported(limits);
    expect(result.limited).toBe(true);
  });

  it('withholds imported candidates when a registered initializer cannot be read', async () => {
    await prepare();
    await rm(path.join(root, 'pkg/__init__.py'));
    const result = await noImported();
    expect(result.limited).toBe(true);
  });

  it('does not reuse successful origin facts across separate analyses after a source change', async () => {
    await prepare();
    expect((await search()).routes).toHaveLength(1);
    await writeFile(path.join(root, 'pkg/application.py'), appSource + 'app = other\n');
    await noImported();
  });

  it('honors cancellation before following imports', async () => {
    await prepare();
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
