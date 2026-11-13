import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const imports = 'from fastapi import FastAPI, APIRouter\n';
const setup = imports + 'app = FastAPI()\nouter = APIRouter(prefix="/v1")\ninner = APIRouter(prefix="/users")\n';
const declaration = '@inner.get("/detail")\ndef detail():\n    pass\n';
const registrations = 'outer.include_router(inner, prefix="/group")\napp.include_router(outer, prefix="/api")\n';
const source = setup + declaration + registrations;
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
const paths = (text: string) => find(text).routes.map(route => route.path);
function noConfirmed(text: string) {
  const result = find(text);
  expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
}

describe('Python nested FastAPI router registration', () => {
  it('combines each constructor and registration prefix exactly once with original handler evidence', () => {
    const result = find(source);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/api/v1/group/users/detail', prefix: 'known' });
    const symbol = analyzeSource(source, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols[0];
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const basis = result.routes[0].basis;
    expect(source.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
    expect(basis.text).toContain('@inner.get');
  });

  it('keeps outer direct routes alongside the nested child routes', () => {
    const text = setup + '@outer.get("/status")\ndef status():\n    pass\n' + declaration + registrations;
    expect(paths(text).sort()).toEqual(['/api/v1/group/users/detail', '/api/v1/status'].sort());
  });

  it('does not normalize repeated slashes while composing nested prefixes', () => {
    expect(paths(source.replace('prefix="/v1"', 'prefix="/v1/"').replace('prefix="/group"', 'prefix="/group/"')))
      .toEqual(['/api/v1//group//users/detail']);
  });

  it('emits both registrations of the same nested child', () => {
    const text = setup + declaration + 'outer.include_router(inner, prefix="/one")\nouter.include_router(inner, prefix="/two")\napp.include_router(outer, prefix="/api")\n';
    expect(paths(text)).toEqual(['/api/v1/one/users/detail', '/api/v1/two/users/detail']);
  });

  it('keeps both arms of a diamond through distinct parent routers', () => {
    const text = setup + 'other = APIRouter(prefix="/v2")\n' + declaration
      + 'outer.include_router(inner, prefix="/left")\nother.include_router(inner, prefix="/right")\napp.include_router(outer, prefix="/api")\napp.include_router(other, prefix="/api")\n';
    expect(paths(text).sort()).toEqual(['/api/v1/left/users/detail', '/api/v2/right/users/detail'].sort());
  });

  it('keeps a nested router registered on multiple apps independent', () => {
    const text = setup + 'second = FastAPI()\n' + declaration + registrations + 'second.include_router(outer, prefix="/second")\n';
    expect(paths(text)).toEqual(['/api/v1/group/users/detail', '/second/v1/group/users/detail']);
  });

  it('composes the same paths inside a simple factory but never claims a known deployment prefix', () => {
    const local = source.slice(imports.length).split('\n').filter(Boolean).map(line => '    ' + line).join('\n');
    const result = find(imports + `def create_app():\n${local}\n    return app\n`);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/api/v1/group/users/detail', prefix: 'unknown' });
  });

  it.each([
    ['child declaration after child include', setup + 'outer.include_router(inner, prefix="/group")\n' + declaration + 'app.include_router(outer, prefix="/api")\n'],
    ['child registration after parent include', setup + declaration + 'app.include_router(outer, prefix="/api")\nouter.include_router(inner, prefix="/group")\n'],
    ['extra parent declaration after app include', source + '@outer.get("/late")\ndef late():\n    pass\n'],
  ])('does not confirm a graph whose last setup is too late: %s', (_, text) => noConfirmed(text));

  it.each([
    ['dynamic descendant prefix', declaration, 'outer.include_router(inner, prefix=config)\n'],
    ['unrepresentable child path', declaration.replace('"/detail"', 'dynamic'), 'outer.include_router(inner, prefix="/group")\n'],
    ['conditional descendant include', declaration, 'if flag:\n    outer.include_router(inner, prefix="/group")\n'],
    ['unsupported descendant option', declaration, 'outer.include_router(inner, extra=True)\n'],
    ['descendant routes constructor', declaration, 'outer.include_router(inner)\n'],
  ])('downgrades ancestor direct routes for %s', async (label, child, registration) => {
    const base = label === 'descendant routes constructor' ? setup.replace('APIRouter(prefix="/users")', 'APIRouter(prefix="/users", routes=existing)') : setup;
    const text = base + child + '@app.get("/direct")\ndef direct():\n    pass\n' + registration + 'app.include_router(outer, prefix="/api")\n';
    const direct = find(text).routes.find(route => route.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });

  it.each([
    ['method mutation', 'inner.get = other\n'],
    ['dictionary mutation', '(inner).__dict__.update(get=other)\n'],
    ['escaped child', 'consume([inner])\n'],
    ['aliased parent', 'alias = outer\n'],
    ['rebound child', 'inner = other\n'],
  ])('does not confirm nested registration after %s', (_, effect) => noConfirmed(setup + declaration + effect + registrations));

  it.each([
    ['self cycle', 'outer.include_router(outer)\n'],
    ['indirect cycle', 'inner.include_router(outer)\n'],
  ])('terminates with uncertainty for %s', (_, cycle) => {
    const result = find(setup + declaration + 'outer.include_router(inner)\n' + cycle + 'app.include_router(outer, prefix="/api")\n');
    expect(result.routes.length).toBeLessThanOrEqual(1000);
    expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
  });

  it.each([8, 9])('bounds a chain with %s registration edges', count => {
    const owners = Array.from({ length: count }, (_, i) => `r${i} = APIRouter(prefix="/r${i}")\n`).join('');
    const child = `@r${count - 1}.get("/end")\ndef end():\n    pass\n`;
    const links = Array.from({ length: count - 1 }, (_, i) => count - 2 - i).map(i => `r${i}.include_router(r${i + 1})\n`).join('');
    const result = find(imports + 'app = FastAPI()\n' + owners + child + links + 'app.include_router(r0)\n');
    if (count === 8) {
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0]).toMatchObject({ path: Array.from({ length: count }, (_, i) => `/r${i}`).join('') + '/end', prefix: 'known' });
    } else {
      expect(result.cut).toBe(true);
      expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
    }
  });

  it('enforces maxRoutes after expansion into multiple nested paths', () => {
    const text = setup + declaration + 'outer.include_router(inner, prefix="/one")\nouter.include_router(inner, prefix="/two")\napp.include_router(outer)\n';
    const result = find(text, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });

  it('downgrades earlier app output when nested templates are omitted during collection', () => {
    const text = setup + '@app.get("/direct")\ndef direct():\n    pass\n' + declaration + registrations;
    const result = find(text, 1);
    expect(result.cut).toBe(true);
    expect(result.routes).toMatchObject([{ path: '/direct', prefix: 'unknown' }]);
    expect(result.registrationUncertain).toBe(true);
  });

  it('shares validation work across multiple factory-local nested graphs', () => {
    const factories = Array.from({ length: 4 }, (_, f) => {
      const children = Array.from({ length: 200 }, (_, i) => `    @inner.get("/route${i}")\n    def route${i}():\n        pass\n`).join('');
      const links = Array.from({ length: 100 }, (_, i) => `    outer.include_router(inner, prefix="/f${f}p${i}${'x'.repeat(100)}")\n`).join('');
      return `def factory${f}():\n    app = FastAPI()\n    outer = APIRouter()\n    inner = APIRouter()\n${children}${links}    app.include_router(outer)\n    return app\n`;
    }).join('');
    const result = find(imports + factories, 100_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes.length).toBeLessThan(80_000);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
  });

  it('keeps nested Flask blueprints unresolved while preserving direct registration', () => {
    const base = 'from flask import Flask, Blueprint\napp = Flask(__name__)\nouter = Blueprint("outer", __name__)\ninner = Blueprint("inner", __name__)\n@inner.route("/detail")\ndef detail():\n    pass\n';
    expect(find(base + 'app.register_blueprint(inner, url_prefix="/direct")\n').routes).toMatchObject([{ path: '/direct/detail', prefix: 'known' }]);
    noConfirmed(base + 'outer.register_blueprint(inner, url_prefix="/nested")\napp.register_blueprint(outer, url_prefix="/api")\n');
  });
});
