import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const imports = 'from fastapi import FastAPI, APIRouter\n';
const setup = imports + 'app = FastAPI()\nchild = FastAPI()\n';
const childRoute = '@child.get("/users")\ndef users():\n    pass\n';
const source = setup + childRoute + 'app.mount("/sub", child)\n';
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
function noComposed(text: string) {
  expect(find(text).routes.some(route => route.path?.startsWith('/sub/'))).toBe(false);
}

describe('Python one-step FastAPI app mount', () => {
  it('composes the mounted path once and retains original evidence without deployment certainty', () => {
    const result = find(source);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/sub/users', prefix: 'unknown' });
    const symbol = analyzeSource(source, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols[0];
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const basis = result.routes[0].basis;
    expect(source.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
  });
  it.each([
    'app.mount(path="/sub", app=child)',
    'app.mount("/sub", app=child)',
    'app.mount("/sub", child, "label")',
    'app.mount("/sub", child, name="label")',
    'app.mount("/sub/", child)',
  ])('matches supported mount arguments without duplicate slashes: %s', statement => {
    expect(find(setup + childRoute + statement + '\n').routes).toMatchObject([{ path: '/sub/users', prefix: 'unknown' }]);
  });
  it('keeps an internal double slash as written and unmatched', () => {
    expect(find(setup + childRoute + 'app.mount("/a//sub", child)\n').routes)
      .toMatchObject([{ path: '/a//sub/users', prefix: 'unknown', unmatched: true }]);
  });
  it('handles a root mount without claiming greater certainty', () => {
    expect(find(setup + childRoute + 'app.mount("/", child)\n').routes).toMatchObject([{ path: '/users', prefix: 'unknown' }]);
  });
  it.each([
    ['dynamic path', 'app.mount(config, child)'],
    ['parameter path', 'app.mount("/sub/{id}", child)'],
    ['duplicate path', 'app.mount("/sub", child, path="/other")'],
    ['duplicate child', 'app.mount("/sub", child, app=child)'],
    ['duplicate name', 'app.mount("/sub", child, "one", name="two")'],
    ['spread', 'app.mount("/sub", child, **options)'],
    ['unknown option', 'app.mount("/sub", child, extra=True)'],
  ])('retains raw uncertain child paths for unsupported %s', (_, statement) => {
    const result = find(setup + childRoute + statement + '\n');
    expect(result.routes).toMatchObject([{ path: '/users', prefix: 'unknown' }]);
    expect(result.routes).toHaveLength(1);
  });
  it('does not compose a fixed mount prefix when the child has root_path uncertainty', () => {
    const text = source.replace('child = FastAPI()', 'child = FastAPI(root_path="/proxy")');
    noComposed(text);
    expect(find(text).routes).toMatchObject([{ path: '/users', prefix: 'unknown' }]);
  });
  it('emits both mounts of the same child rather than its raw template', () => {
    const result = find(source + 'app.mount("/other", child)\n');
    expect(result.routes.map(route => [route.path, route.prefix])).toEqual([['/sub/users', 'unknown'], ['/other/users', 'unknown']]);
  });
  it.each(['', childRoute])('downgrades parent routes even when the mounted child has no endpoints: %j', child => {
    const text = setup + 'other = FastAPI()\n@app.get("/direct")\ndef direct():\n    pass\n@other.get("/safe")\ndef safe():\n    pass\n' + child + 'app.mount("/sub", child)\n';
    const result = find(text);
    expect(result.routes.find(route => route.handler.name === 'direct')).toMatchObject({ path: '/direct', prefix: 'unknown' });
    expect(result.routes.find(route => route.handler.name === 'safe')).toMatchObject({ path: '/safe', prefix: 'known' });
  });
  it('mounts child routes composed by a prior include_router', () => {
    const text = setup + 'router = APIRouter(prefix="/v1")\n@router.get("/x")\ndef x():\n    pass\nchild.include_router(router)\napp.mount("/sub", child)\n';
    expect(find(text).routes).toMatchObject([{ path: '/sub/v1/x', prefix: 'unknown' }]);
  });
  it.each([
    setup + 'app.mount("/sub", child)\n' + childRoute,
    setup + 'router = APIRouter(prefix="/v1")\n@router.get("/x")\ndef x():\n    pass\napp.mount("/sub", child)\nchild.include_router(router)\n',
  ])('does not assume child setup performed after mount was already installed %#', text => noComposed(text));
  it.each([
    'third = FastAPI()\nchild.mount("/deep", third)\n',
    'child.mount("/back", app)\n',
  ])('does not resolve unsupported nested or cyclic mounts: %j', extra => {
    noComposed(setup + childRoute + extra + 'app.mount("/sub", child)\n');
  });
  it('does not compose a factory-local mount', () => {
    const local = source.slice(imports.length).split('\n').filter(Boolean).map(line => '    ' + line).join('\n');
    noComposed(imports + `def create_app():\n${local}\n    return app\n`);
  });
  it('does not invent source endpoints for an external StaticFiles mount', () => {
    const text = imports + 'from fastapi.staticfiles import StaticFiles\napp = FastAPI()\n@app.get("/direct")\ndef direct():\n    pass\napp.mount("/static", StaticFiles(directory="static"))\n';
    const result = find(text);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/direct', prefix: 'unknown' });
  });
  it.each([
    ['method mutation', 'app.mount = replacement\napp.mount("/sub", child)'],
    ['escaped child', 'consume([child])\napp.mount("/sub", child)'],
    ['rebound child', 'child = replacement\napp.mount("/sub", child)'],
    ['conditional mount', 'if flag:\n    app.mount("/sub", child)'],
  ])('does not compose a path through %s', (_, registration) => noComposed(setup + childRoute + registration + '\n'));
  it('caps expanded mount routes at maxRoutes', () => {
    const result = find(source + 'app.mount("/other", child)\n', 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });
  it('bounds the total mount validation work without depending on wall-clock timing', () => {
    const declarations = Array.from({ length: 800 }, (_, i) => `@child.get("/route${i}")\ndef route${i}():\n    pass\n`).join('');
    const mounts = Array.from({ length: 100 }, (_, i) => `app.mount("/p${i}${'x'.repeat(100)}", child)\n`).join('');
    const result = find(setup + declarations + mounts, 100_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(80_000);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('also charges work for repeatedly unresolved mount candidates', () => {
    const declarations = Array.from({ length: 200 }, (_, i) => `@child.get("/route${i}")\ndef route${i}():\n    pass\n`).join('');
    const result = find(setup + declarations + 'app.mount(config, child)\n'.repeat(3000), 1000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });
  it('preserves direct FastAPI router and Flask Blueprint registrations', () => {
    const fast = imports + 'app = FastAPI()\nr = APIRouter(prefix="/v1")\n@r.get("/x")\ndef x():\n    pass\napp.include_router(r)\n';
    expect(find(fast).routes).toMatchObject([{ path: '/v1/x', prefix: 'known' }]);
    const flask = 'from flask import Flask, Blueprint\napp = Flask(__name__)\nb = Blueprint("b", __name__)\n@b.route("/x")\ndef x():\n    pass\napp.register_blueprint(b)\n';
    expect(find(flask).routes).toMatchObject([{ path: '/x', prefix: 'known' }]);
  });
});
