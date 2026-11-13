import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { buildFeatureFlow } from '../src/core/analysis/feature-flow';
import { scanProject } from '../src/core/project/files';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
const file = { id: 'python', relativePath: 'server/main.py', size: 0 };
const hash = 'a'.repeat(64);
const imports = 'from fastapi import FastAPI\n';
const body = '    app = FastAPI()\n    @app.get("/users/{id}")\n    def handle(id):\n        return id\n    return app\n';
const source = imports + 'def create_app():\n' + body;
const find = (text: string, nodes = 200_000, routes = 1000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, routes);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function projectOf(text: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-factory-')));
  roots.push(root);
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'server/main.py'), text);
  await writeFile(path.join(root, 'client.ts'), 'export function load() { return fetch("/users/1"); }');
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  return { root, project, routes };
}

describe('Python simple application factory routes', () => {
  it.each([
    ['from fastapi import FastAPI', 'FastAPI()', 'get', '/users/{id}', 'fastapi'],
    ['from fastapi import FastAPI as F', 'F()', 'get', '/users/{id}', 'fastapi'],
    ['import fastapi as f', 'f.FastAPI()', 'get', '/users/{id}', 'fastapi'],
    ['from flask import Flask', 'Flask(__name__)', 'route', '/users/<id>', 'flask'],
    ['from flask import Flask as F', 'F(__name__)', 'route', '/users/<id>', 'flask'],
    ['import flask as f', 'f.Flask(__name__)', 'route', '/users/<id>', 'flask'],
  ])('reads a returned app from module framework import %s', (declaration, constructor, method, routePath, framework) => {
    const text = `${declaration}\ndef assemble():\n    app = ${constructor}\n    @app.${method}("${routePath}")\n    def handle(id):\n        return id\n    return app\n`;
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ framework, path: routePath, prefix: 'unknown', method: 'GET' });
    const analysis = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash });
    const symbol = analysis.symbols.find(symbol => symbol.name.endsWith('handle'))!;
    expect(symbol).toBeDefined();
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const basis = result.routes[0].basis;
    expect(text.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
    expect(text.slice(symbol.evidence.startUtf16, symbol.evidence.endUtf16)).toContain('@app.');
  });

  it('keeps identical app variable names in independent factory scopes separate', () => {
    const result = find(imports + 'def one():\n' + body + 'def two():\n' + body.replace('/users/{id}', '/other/{id}'));
    expect(result.routes.map(route => route.path)).toEqual(['/users/{id}', '/other/{id}']);
    expect(new Set(result.routes.map(route => route.handler.startUtf16)).size).toBe(2);
  });

  it('preserves ordinary module app routes alongside factory candidates', () => {
    const text = source + 'app = FastAPI()\n@app.get("/health")\ndef health():\n    return 1\n';
    const result = find(text);
    expect(result.routes.find(route => route.path === '/health')).toMatchObject({ prefix: 'known' });
    expect(result.routes.find(route => route.path === '/users/{id}')).toMatchObject({ prefix: 'unknown' });
  });

  it.each([
    ['no returned app', 'def create_app():\n' + body.replace('    return app\n', '')],
    ['alias return', 'def create_app():\n' + body.replace('    return app\n', '    other = app\n    return other\n')],
    ['different app return', 'def create_app():\n' + body.replace('    return app\n', '    other = FastAPI()\n    return other\n')],
    ['multiple returns', 'def create_app():\n' + body.replace('    return app\n', '    if flag:\n        return app\n    return app\n')],
    ['reassigned app', 'def create_app():\n' + body.replace('    return app\n', '    app = replacement\n    return app\n')],
    ['conditional creation', 'def create_app():\n' + body.replace('    app = FastAPI()', '    if flag:\n        app = FastAPI()')],
    ['async factory', 'async def create_app():\n' + body],
    ['generator factory', 'def create_app():\n' + body.replace('    return app\n', '    yield app\n    return app\n')],
    ['decorated factory', '@decorate\ndef create_app():\n' + body],
    ['nested factory', 'def outer():\n    def create_app():\n' + body.split('\n').filter(Boolean).map(line => '    ' + line).join('\n') + '\n'],
    ['class factory', 'class C:\n    def create_app():\n' + body.split('\n').filter(Boolean).map(line => '    ' + line).join('\n') + '\n'],
    ['duplicate factory', 'def create_app():\n' + body + 'def create_app():\n    pass\n'],
  ])('does not infer the intended application for %s', (_, factory) => {
    expect(find(imports + factory).routes).toEqual([]);
  });

  it.each([
    ['parameter', 'def create_app(FastAPI):\n' + body],
    ['assignment', 'def create_app():\n' + body.replace('    app =', '    FastAPI = replacement\n    app =')],
    ['local import', 'def create_app():\n    from other import FastAPI\n' + body],
    ['local framework import', 'def create_app():\n    from fastapi import FastAPI\n' + body],
  ])('does not confuse a locally bound constructor with the module import: %s', (_, factory) => {
    expect(find(imports + factory).routes).toEqual([]);
  });

  it('rejects a module alias shadowed by a factory parameter', () => {
    expect(find('import fastapi as f\ndef assemble(f):\n' + body.replace('FastAPI()', 'f.FastAPI()')).routes).toEqual([]);
  });

  it('does not trust an overwritten module-level framework import', () => {
    expect(find(imports + 'FastAPI = replacement\ndef assemble():\n' + body).routes).toEqual([]);
  });

  it.each([
    ['nested nonlocal app reassignment', '    def mutate():\n        nonlocal app\n        app = other\n    mutate()\n'],
    ['parenthesized dictionary update', '    def mutate():\n        (app).__dict__.update(get=other)\n    mutate()\n'],
    ['parenthesized setattr root', '    setattr((app), "get", other)\n'],
    ['parenthesized delattr root', '    delattr((app), "get")\n'],
    ['parenthesized vars root', '    vars((app))["get"] = other\n'],
    ['nested constructor mutation', '    def mutate():\n        global FastAPI\n        FastAPI = other\n    mutate()\n'],
  ])('does not expose a matchable factory route after %s', (_, effect) => {
    const text = imports + 'def assemble():\n' + body.replace('    @app.get', effect + '    @app.get');
    const result = find(text);
    expect(result.routes.every(route => route.unmatched)).toBe(true);
  });

  it('keeps an independent factory when another factory has a shadowed constructor and same app name', () => {
    const text = imports + 'def shadowed(FastAPI):\n' + body.replace('/users/{id}', '/unsafe/{id}')
      + 'def normal():\n' + body;
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/users/{id}', prefix: 'unknown' });
    expect(result.routes[0].unmatched).toBeFalsy();
  });

  it('limits route output while preserving the candidate uncertainty', () => {
    const text = source.replace('    return app\n', '    @app.get("/other")\n    def other():\n        return 1\n    return app\n');
    const result = find(text, 200_000, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(result.routes[0].prefix).toBe('unknown');
  });

  it('does not confirm candidates when the node walk or syntax is incomplete', () => {
    for (const result of [find(source, 10), find(source + 'x = ' + '['.repeat(150) + ']'.repeat(150)), find(source + ')\n')]) {
      expect(result.routes.every(route => route.unmatched)).toBe(true);
    }
  });

  it('reports factory uncertainty through project routes and preserves inner handler flow evidence', async () => {
    const text = imports + 'def helper(value):\n    return value\n' + 'def assemble():\n' + body.replace('return id', 'return helper(id)');
    const { root, project, routes } = await projectOf(text);
    expect(routes.routes).toHaveLength(1);
    expect(routes.routes[0].prefix).toBe('unknown');
    expect(routes.notes.some(note => /실행|배포/.test(note))).toBe(true);
    expect(routes.links.every(link => !link.sure)).toBe(true);
    const flow = await buildFeatureFlow(root, project.id, project.files, routes, 0);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toContain('helper');
    const entry = flow.nodes.find(node => node.side === 'back' && node.depth === 0)!;
    expect(entry.range.startUtf16).toBe(routes.routes[0].handler.startUtf16);
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
