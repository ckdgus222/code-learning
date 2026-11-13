import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readAllowed, scanProject } from '../src/core/project/files';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { buildFeatureFlow, buildFeatureFlows } from '../src/core/analysis/feature-flow';
import { analyzeSource } from '../src/core/analysis/syntax';
import { storyOf } from '../src/core/analysis/flow-story';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { findFunctionCalls } from '../src/core/analysis/calls';
let root: string;
const header = 'from fastapi import FastAPI\napp = FastAPI()\n';
const handler = (body: string) => `@app.get("/users/{id}")\ndef handle(id):\n${body}\n`;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-flow-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(relative: string, text: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}
async function prepare(source: string, extra: Record<string, string> = {}) {
  await put('server/main.py', source);
  await put('web/client.ts', "export function load() { return fetch('/users/1'); }");
  for (const [relative, text] of Object.entries(extra)) await put(relative, text);
  const project = await scanProject(root, randomUUID());
  const routes = await findProjectRoutes(root, project.id, project.files);
  expect(routes.routes.length).toBeGreaterThan(0);
  const flow = await buildFeatureFlow(root, project.id, project.files, routes, 0);
  return { project, routes, flow };
}

describe('Python backend feature flow', () => {
  it('follows a same-file helper after the decorated FastAPI handler with exact evidence', async () => {
    const text = header + handler('    return helper(id)') + 'def helper(value):\n    return value\n';
    const { project, routes, flow } = await prepare(text);
    const file = project.files.find(file => file.relativePath === 'server/main.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const analysis = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash });
    const back = flow.nodes.filter(node => node.side === 'back');
    expect(back.map(node => node.name)).toEqual(['handle', 'helper']);
    for (const node of back) {
      const symbol = analysis.symbols.find(symbol => symbol.name === node.name)!;
      expect(node).toMatchObject({ fileId: file.id, fileHash: hash, range: { startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 } });
    }
    expect(flow.edges.find(edge => edge.kind === 'route')).toMatchObject({ sure: true });
    expect(flow.edges.find(edge => edge.kind === 'calls')).toMatchObject({ sure: true, from: back[0].id, to: back[1].id });
    expect(routes.links[0].sure).toBe(true);
  });

  it.each(['<id>', '<int:id>'])('expands a Flask handler without changing route certainty for %s', async token => {
    const { flow } = await prepare(`from flask import Flask\napp = Flask(__name__)\n@app.route("/users/${token}")\ndef handle(id):\n    return helper(id)\ndef helper(value):\n    return value\n`);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle', 'helper']);
    expect(flow.edges.find(edge => edge.kind === 'route')).toMatchObject({ sure: token === '<id>' });
    expect(flow.edges.find(edge => edge.kind === 'calls')).toMatchObject({ sure: true });
  });

  it('expands a Django view helper while retaining uncertain path matching', async () => {
    const { project, routes, flow } = await prepare('', { 'polls/__init__.py': '',
      'polls/views.py': 'def handle(request, id):\n    return helper(id)\ndef helper(value):\n    return value\n',
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle', 'helper']);
    expect(flow.edges.find(edge => edge.kind === 'route')).toMatchObject({ sure: false });
    const helper = flow.nodes.find(node => node.name === 'helper')!;
    const candidate = flow.edges.find(edge => edge.to === helper.id)!;
    expect(candidate).toMatchObject({ kind: 'calls', sure: false });
    expect(candidate.reasons.length).toBeGreaterThan(0);
    expect(storyOf(flow).filter(step => step.nodes.some(node => node.id === helper.id)).some(step => step.inferred)).toBe(true);
    const ordinary = await findFunctionCalls(root, project.id, project.files, routes.routes[0].handler, MAP_LIMITS);
    expect(ordinary.calls[0]).toMatchObject({ status: 'unknown', reason: 'unclear-file' });
    const incoming = await findFunctionCalls(root, project.id, project.files,
      { fileId: helper.fileId, fileHash: helper.fileHash, startUtf16: helper.range.startUtf16, endUtf16: helper.range.endUtf16 }, MAP_LIMITS);
    expect(incoming.callers).toEqual([]);
    expect(incoming.typedCallers).toEqual([]);
  });

  it.each([
    ['module attribute write', 'def helper(value):\n    return value\n', '    return helper(id)', 'from . import views\nviews.helper = replacement\n'],
    ['observed globals write', 'def helper(value):\n    return value\n', '    return helper(id)', 'from . import views\nviews.handle.__globals__["helper"] = replacement\n'],
    ['reassigned name', 'def helper(value):\n    return value\nhelper = replacement\n', '    return helper(id)', ''],
    ['local shadowing', 'def helper(value):\n    return value\n', '    helper = replacement\n    return helper(id)', ''],
    ['decorated helper', '@decorate\ndef helper(value):\n    return value\n', '    return helper(id)', ''],
    ['conditional helper', 'if flag:\n    def helper(value):\n        return value\n', '    return helper(id)', ''],
    ['ambiguous helper', 'def helper(value):\n    return value\ndef helper(value):\n    return value\n', '    return helper(id)', ''],
    ['member call', 'class C:\n    def helper(self, value):\n        return value\n', '    return C.helper(id)', ''],
  ])('does not add an escape-only flow candidate for %s', async (_, declaration, body, mutation) => {
    const { flow } = await prepare('', { 'polls/__init__.py': '',
      'polls/views.py': `${declaration}def handle(request, id):\n${body}\n`,
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'polls/helper.py': 'def helper(value):\n    return value\n', 'polls/mutator.py': mutation,
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle']);
    expect(flow.nodes.find(node => node.name === 'handle')!.outside.some(text => text.includes('helper(id)'))).toBe(true);
  });

  it('keeps a normal direct import confirmed instead of inventing an escape-only candidate', async () => {
    const { flow } = await prepare('', { 'polls/__init__.py': '',
      'polls/views.py': 'from .helper import helper\ndef handle(request, id):\n    return helper(id)\n',
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'polls/helper.py': 'def helper(value):\n    return value\n',
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    const helper = flow.nodes.find(node => node.name === 'helper')!;
    expect(helper).toBeDefined();
    expect(flow.edges.find(edge => edge.to === helper.id)).toMatchObject({ kind: 'calls', sure: true });
  });

  it.each([
    ['function globals update', 'views.handle.__globals__.update(helper=replacement)'],
    ['module dictionary clear', 'views.__dict__.clear()'],
    ['module dictionary pop', 'views.__dict__.pop("helper")'],
    ['namespace alias escape', 'namespace = views.handle.__globals__\nconsume(namespace)'],
    ['parenthesized namespace', '(views.handle).__globals__.update(helper=replacement)'],
    ['normalized root spelling', 'ｖiews.handle.__globals__.update(helper=replacement)'],
  ])('blocks an uncertain lexical candidate after %s', async (_, mutation) => {
    const { flow } = await prepare('', { 'polls/__init__.py': '',
      'polls/views.py': 'def helper(value):\n    return value\ndef handle(request, id):\n    return helper(id)\n',
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'polls/mutator.py': `from . import views\n${mutation}\n`,
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle']);
    expect(flow.nodes.find(node => node.name === 'handle')!.outside).toContain('helper(id)');
  });

  it('does not seed a flow from an incompletely parsed Django view', async () => {
    await put('polls/__init__.py', '');
    await put('polls/views.py', 'def helper(value):\n    return value\ndef handle(request, id):\n    return helper(id)\n)\n');
    await put('polls/urls.py', 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n');
    const project = await scanProject(root, randomUUID());
    const routes = await findProjectRoutes(root, project.id, project.files);
    expect(routes.routes).toEqual([]);
    expect(await buildFeatureFlows(root, project.id, project.files, routes)).toEqual([]);
  });

  it.each(['depth', 'breadth', 'arrows'] as const)('applies the %s cap to uncertain lexical candidates', async mode => {
    const helpers = mode === 'depth' ? 'def a():\n    b()\ndef b():\n    c()\ndef c():\n    d()\ndef d():\n    pass\n'
      : Array.from({ length: mode === 'breadth' ? 15 : 1 }, (_, i) => `def helper${i}():\n    pass\n`).join('');
    const body = mode === 'depth' ? '    a()' : Array.from({ length: mode === 'breadth' ? 15 : 210 }, (_, i) => `    helper${mode === 'breadth' ? i : 0}()`).join('\n');
    const { flow } = await prepare('', { 'polls/__init__.py': '',
      'polls/views.py': `${helpers}def handle(request, id):\n${body}\n`,
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    const back = flow.nodes.filter(node => node.side === 'back');
    expect(back).toHaveLength(mode === 'depth' ? 4 : mode === 'breadth' ? 10 : 2);
    expect(Math.max(...back.map(node => node.depth))).toBeLessThanOrEqual(3);
    const ids = new Set(back.map(node => node.id));
    const candidates = flow.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(edge => !edge.sure && edge.reasons.length > 0)).toBe(true);
    expect(flow.edges.length).toBeLessThanOrEqual(200);
    expect(flow.limited).toBe(true);
  });

  it('does not bypass result limits, cancellation or changed evidence for an uncertain candidate', async () => {
    const text = 'def helper():\n    pass\ndef handle(request, id):\n    helper()\n';
    const { project, routes, flow } = await prepare('', { 'polls/__init__.py': '', 'polls/views.py': text,
      'polls/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/<int:id>/", views.handle)]\n',
      'web/client.ts': 'export function load() { return fetch("/users/1/"); }' });
    expect(flow.nodes.some(node => node.name === 'helper')).toBe(true);
    const limited = await buildFeatureFlow(root, project.id, project.files, routes, 0, { ...MAP_LIMITS, results: 1 });
    expect(limited.limited).toBe(true);
    expect(limited.nodes.some(node => node.name === 'helper')).toBe(false);
    await expect(buildFeatureFlow(root, project.id, project.files, routes, 0, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    await put('polls/views.py', text + '# changed\n');
    await expect(buildFeatureFlow(root, project.id, project.files, routes, 0)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('follows a direct imported helper to original file evidence', async () => {
    const helper = '# 😀\ndef helper(value):\n    return value\n';
    const { project, flow } = await prepare(header + 'from .helper import helper as alias\n' + handler('    return alias(id)'),
      { 'server/__init__.py': '', 'server/helper.py': helper });
    const file = project.files.find(file => file.relativePath === 'server/helper.py')!;
    const { hash } = await readAllowed(root, file.relativePath);
    const symbol = analyzeSource(helper, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols[0];
    expect(flow.nodes.find(node => node.name === 'helper')).toMatchObject({ relativePath: file.relativePath, fileId: file.id, fileHash: hash,
      range: { startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 } });
    expect(flow.edges.some(edge => edge.kind === 'calls' && edge.sure)).toBe(true);
  });

  it.each([false, true])('keeps method candidates uncertain through edges and story (imported=%s)', async imported => {
    const model = 'class C:\n    def work(self):\n        return 1\n';
    const { flow } = await prepare(header + (imported ? 'from .model import C\n' : model) + handler('    return C.work()'),
      imported ? { 'server/__init__.py': '', 'server/model.py': model } : {});
    const candidate = flow.nodes.find(node => node.name === 'C.work');
    expect(candidate).toBeDefined();
    const edge = flow.edges.find(edge => edge.kind === 'typed');
    expect(edge).toMatchObject({ sure: false, to: candidate!.id });
    expect(edge!.reasons.length).toBeGreaterThan(0);
    expect(storyOf(flow).filter(step => step.nodes.some(node => node.name === 'C.work')).some(step => step.inferred)).toBe(true);
  });

  it.each([
    ['shadowing', 'def helper():\n    pass\n', '    helper = replacement\n    helper()'],
    ['patched name', 'def helper():\n    pass\nhelper = replacement\n', '    helper()'],
    ['decorated target', '@decorate\ndef helper():\n    pass\n', '    helper()'],
    ['reexport', 'from .bridge import helper\n', '    helper()'],
  ])('keeps %s calls outside the confirmed backend graph', async (_, declaration, body) => {
    const { flow } = await prepare(header + declaration + handler(body), {
      'server/__init__.py': '', 'server/bridge.py': 'from .helper import helper\n', 'server/helper.py': 'def helper():\n    pass\n',
    });
    const back = flow.nodes.filter(node => node.side === 'back');
    expect(back.map(node => node.name)).toEqual(['handle']);
    expect(back[0].outside.some(text => text.includes('helper()'))).toBe(true);
  });

  it('excludes nested functions, classes, lambda and header calls from handler body traversal', async () => {
    const source = header + 'def ignored():\n    pass\ndef helper():\n    pass\n@app.get("/users/{id}")\ndef handle(id=ignored()):\n    def inner():\n        ignored()\n    class Nested:\n        ignored()\n    callback = lambda: ignored()\n    helper()\n';
    const { flow } = await prepare(source);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle', 'helper']);
    expect(flow.nodes.find(node => node.name === 'handle')!.outside).toEqual([]);
  });

  it('does not infer Python raises or stores through TypeScript-specific patterns', async () => {
    const { flow } = await prepare(header + handler('    db.users.create(id)\n    raise ValueError("bad")'));
    const back = flow.nodes.filter(node => node.side === 'back');
    expect(back.every(node => node.stores.length === 0 && node.stops.length === 0)).toBe(true);
    expect(flow.notes.some(note => /Python/.test(note) && /오류|저장|raise|store/.test(note))).toBe(true);
  });

  it('caps Python backend depth and reports six outside calls plus omitted calls', async () => {
    const helpers = 'def b():\n    c()\ndef c():\n    d()\ndef d():\n    e()\ndef e():\n    pass\n';
    const { flow } = await prepare(header + helpers + handler('    b()\n' + Array.from({ length: 9 }, (_, i) => `    external${i}()`).join('\n')));
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.depth)).toEqual([0, 1, 2, 3]);
    const entry = flow.nodes.find(node => node.name === 'handle')!;
    expect(entry.outside).toHaveLength(6);
    expect(entry.outsideOmitted).toBe(3);
    expect(flow.limited).toBe(true);
  });

  it('caps breadth at ten backend nodes', async () => {
    const helpers = Array.from({ length: 15 }, (_, i) => `def helper${i}():\n    pass\n`).join('');
    const { flow } = await prepare(header + helpers + handler(Array.from({ length: 15 }, (_, i) => `    helper${i}()`).join('\n')));
    expect(flow.nodes.filter(node => node.side === 'back')).toHaveLength(10);
    expect(flow.limited).toBe(true);
  });

  it('keeps a recursive cycle as an edge without repeating nodes', async () => {
    const { flow } = await prepare(header + 'def a():\n    b()\ndef b():\n    a()\n' + handler('    a()'));
    const back = flow.nodes.filter(node => node.side === 'back');
    expect(back.map(node => node.name)).toEqual(['handle', 'a', 'b']);
    const backendIds = new Set(back.map(node => node.id));
    expect(flow.edges.filter(edge => edge.kind === 'calls' && backendIds.has(edge.from) && backendIds.has(edge.to))).toHaveLength(3);
    expect(back.every(node => Number.isFinite(node.depth))).toBe(true);
  });

  it('caps repeated backend call arrows at two hundred', async () => {
    const { flow } = await prepare(header + 'def helper():\n    pass\n' + handler(Array.from({ length: 210 }, () => '    helper()').join('\n')));
    expect(flow.edges.length).toBeLessThanOrEqual(200);
    expect(flow.limited).toBe(true);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['handle', 'helper']);
  });

  it('builds mixed JSX, Python helpers and TypeScript routes identically alone and in a shared batch', async () => {
    const { project, routes } = await prepare(header + 'from .helper import helper\n' + handler('    return helper(id)'), {
      'server/__init__.py': '', 'server/helper.py': 'def helper(value):\n    return value\n',
      'server/health.ts': "@Controller('health') class Health { @Get() read() { return 'ok'; } }",
      'web/client.ts': 'export function load() { fetch("/users/1"); } export function health() { fetch("/health"); }',
      'web/View.tsx': 'import {load} from "./client"; export function View() { return <button onClick={() => load()}>Load</button>; }',
    });
    const flows = await buildFeatureFlows(root, project.id, project.files, routes);
    expect(flows).toHaveLength(2);
    for (let i = 0; i < flows.length; i++) expect(flows[i]).toEqual(await buildFeatureFlow(root, project.id, project.files, routes, i));
    expect(flows.some(flow => flow.nodes.some(node => node.name === 'helper'))).toBe(true);
    expect(flows.some(flow => flow.nodes.some(node => node.name === 'Health.read'))).toBe(true);
    expect(flows.some(flow => flow.nodes.some(node => node.name === 'View'))).toBe(true);
  });

  it('retains file limits and rejects cancellation or changed handler evidence', async () => {
    const source = header + 'from .helper import helper\n' + handler('    helper()');
    const { project, routes } = await prepare(source, { 'server/__init__.py': '', 'server/helper.py': 'def helper():\n    pass\n' });
    const limited = await buildFeatureFlow(root, project.id, project.files, routes, 0, { ...MAP_LIMITS, files: 1 });
    expect(limited.limited).toBe(true);
    expect(limited.nodes.some(node => node.name === 'helper')).toBe(false);
    await expect(buildFeatureFlow(root, project.id, project.files, routes, 0, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    await put('server/main.py', source + '# changed\n');
    await expect(buildFeatureFlow(root, project.id, project.files, routes, 0)).rejects.toMatchObject({ code: 'CHANGED' });
  });
});
