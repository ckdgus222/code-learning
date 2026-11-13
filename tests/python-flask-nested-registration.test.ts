import { describe, expect, it } from 'vitest';
import { pythonRoutes, walkPython } from '../src/core/analysis/python-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
const file = { id: 'python', relativePath: 'main.py', size: 0 };
const hash = 'a'.repeat(64);
const imports = 'from flask import Flask, Blueprint\n';
const setup = imports + 'app = Flask(__name__)\nparent = Blueprint("p", __name__, url_prefix="/api")\nchild = Blueprint("c", __name__, url_prefix="/users")\n';
const route = '@child.route("/detail")\ndef detail():\n    pass\n';
const links = 'parent.register_blueprint(child)\napp.register_blueprint(parent)\n';
const source = setup + route + links;
const find = (text: string, maxRoutes = 1000, nodes = 200_000) => pythonRoutes(file, walkPython(text, file.relativePath, nodes), hash, maxRoutes);
function uncertain(text: string) {
  const result = find(text);
  expect(result.routes.every(route => route.prefix === 'unknown' || route.unmatched)).toBe(true);
}

describe('Python nested Flask Blueprint registration', () => {
  it('joins parent and child prefixes with exact original handler and decorator evidence', () => {
    const result = find(source);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/api/users/detail', prefix: 'known', framework: 'flask' });
    const symbol = analyzeSource(source, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols[0];
    expect(result.routes[0].handler).toMatchObject({ fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 });
    const basis = result.routes[0].basis;
    expect(source.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe(basis.text);
  });

  it.each([
    ['missing registration prefix', '', '/api/users/detail'],
    ['None registration prefix', ', url_prefix=None', '/api/users/detail'],
    ['empty registration prefix', ', url_prefix=""', '/api/detail'],
    ['literal registration override', ', url_prefix="/override"', '/api/override/detail'],
  ])('selects the child prefix for %s', (_, option, expected) => {
    const text = setup + route + `parent.register_blueprint(child${option})\napp.register_blueprint(parent)\n`;
    expect(find(text).routes).toMatchObject([{ path: expected, prefix: 'known' }]);
  });

  it.each([
    ['missing child prefix', '', '/api'],
    ['None child prefix', ', url_prefix=None', '/api'],
    ['empty child prefix', ', url_prefix=""', '/api/'],
  ])('distinguishes %s when the raw route is empty', (_, option, expected) => {
    const text = setup.replace('child = Blueprint("c", __name__, url_prefix="/users")', `child = Blueprint("c", __name__${option})`)
      + route.replace('"/detail"', '""') + links;
    expect(find(text).routes).toMatchObject([{ path: expected, prefix: 'known' }]);
  });

  it('uses the child alone when the parent has no prefix', () => {
    expect(find(source.replace('parent = Blueprint("p", __name__, url_prefix="/api")', 'parent = Blueprint("p", __name__)')).routes)
      .toMatchObject([{ path: '/users/detail', prefix: 'known' }]);
  });
  it('strips only the joining boundary slashes for nested Blueprint prefixes', () => {
    expect(find(source.replace('"/api"', '"/api///"').replace('"/users"', '"///users"')).routes)
      .toMatchObject([{ path: '/api/users/detail', prefix: 'known' }]);
  });

  it.each([
    ['default qualified name', '', 'p.c'],
    ['renamed parent', ', name="new"', 'new.c'],
    ['dotted parent name', ', name="x.y"', 'x.y.c'],
    ['leading dots', ', name="..p"', 'p.c'],
  ])('detects a direct name colliding with the %s', (_, parentOption, directName) => {
    const text = setup + 'other = Blueprint("other", __name__)\n' + route
      + '@app.route("/direct")\ndef direct():\n    pass\nparent.register_blueprint(child)\n'
      + `app.register_blueprint(parent${parentOption})\napp.register_blueprint(other, name="${directName}")\n`;
    const direct = find(text).routes.find(item => item.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });

  it('detects name collisions even when both conflicting blueprints have no routes', () => {
    const text = setup + 'other = Blueprint("other", __name__)\n@app.route("/direct")\ndef direct():\n    pass\n'
      + links + 'app.register_blueprint(other, name="p.c")\n';
    expect(find(text).routes.find(item => item.handler.name === 'direct')).toMatchObject({ prefix: 'unknown' });
  });
  it('keeps source literal blueprint names distinct without NFKC normalization', () => {
    const text = setup + 'other = Blueprint("other", __name__)\n' + route + links + 'app.register_blueprint(other, name="ｐ.c")\n';
    expect(find(text).routes).toMatchObject([{ path: '/api/users/detail', prefix: 'known' }]);
  });
  it('allows the same child under distinct qualified parent names', () => {
    const text = setup + 'other = Blueprint("q", __name__, url_prefix="/other")\n' + route
      + 'parent.register_blueprint(child)\nother.register_blueprint(child)\napp.register_blueprint(parent)\napp.register_blueprint(other)\n';
    expect(find(text).routes.map(item => item.path).sort()).toEqual(['/api/users/detail', '/other/users/detail'].sort());
  });
  it('does not mix effective names across separate final apps', () => {
    const text = setup + 'second = Flask(__name__)\n' + route + links + 'second.register_blueprint(parent, url_prefix="/second")\n';
    expect(find(text).routes.map(item => [item.path, item.prefix])).toEqual([['/api/users/detail', 'known'], ['/second/users/detail', 'known']]);
  });

  it.each([
    'parent.register_blueprint(child, url_prefix=config)',
    'parent.register_blueprint(child, name=config)',
    'parent.register_blueprint(child, name_prefix="custom")',
    'parent.register_blueprint(child, **options)',
    'parent.register_blueprint(unknown_child)',
  ])('withholds an ancestor route after unresolved registration %s', registration => {
    const text = setup + route + '@app.route("/direct")\ndef direct():\n    pass\n'
      + registration + '\napp.register_blueprint(parent)\n';
    const direct = find(text).routes.find(item => item.handler.name === 'direct')!;
    expect(direct).toBeDefined();
    expect(direct.prefix === 'unknown' || direct.unmatched).toBeTruthy();
  });
  it('does not claim a late child setup was present at earlier parent registration', () => {
    uncertain(setup + route + 'app.register_blueprint(parent)\nparent.register_blueprint(child)\n');
  });

  it('composes factory-local nested blueprints while retaining deployment uncertainty', () => {
    const local = source.slice(imports.length).split('\n').filter(Boolean).map(line => '    ' + line).join('\n');
    const result = find(imports + `def create_app():\n${local}\n    return app\n`);
    expect(result.routes).toMatchObject([{ path: '/api/users/detail', prefix: 'unknown' }]);
  });
  it.each(['    alias = child\n', '    consume([child])\n', '    Blueprint = replacement\n'])('does not compose an unsafe factory-local namespace: %j', effect => {
    const local = source.slice(imports.length).split('\n').filter(Boolean).map(line => '    ' + line).join('\n');
    const text = imports + `def create_app():\n${local.replace('    parent.register_blueprint', effect + '    parent.register_blueprint')}\n    return app\n`;
    expect(find(text).routes.some(item => item.path === '/api/users/detail')).toBe(false);
  });

  it.each(['parent.register_blueprint(parent)', 'child.register_blueprint(parent)'])('bounds a cyclic Blueprint graph: %s', cycle => {
    const result = find(setup + route + 'parent.register_blueprint(child)\n' + cycle + '\napp.register_blueprint(parent)\n');
    expect(result.routes.length).toBeLessThanOrEqual(1000);
    expect(result.routes.every(item => item.prefix === 'unknown' || item.unmatched)).toBe(true);
  });
  it.each([8, 9])('bounds a Blueprint chain with %s registration edges', count => {
    const owners = Array.from({ length: count }, (_, i) => `b${i} = Blueprint("b${i}", __name__, url_prefix="/b${i}")\n`).join('');
    const declarations = `@b${count - 1}.route("/end")\ndef end():\n    pass\n`;
    const registrations = Array.from({ length: count - 1 }, (_, i) => count - 2 - i).map(i => `b${i}.register_blueprint(b${i + 1})\n`).join('');
    const result = find(imports + 'app = Flask(__name__)\n' + owners + declarations + registrations + 'app.register_blueprint(b0)\n');
    if (count === 8) expect(result.routes).toMatchObject([{ path: Array.from({ length: count }, (_, i) => `/b${i}`).join('') + '/end', prefix: 'known' }]);
    else {
      expect(result.cut).toBe(true);
      expect(result.routes.every(item => item.prefix === 'unknown' || item.unmatched)).toBe(true);
    }
  });
  it('enforces output caps after expanding nested registrations', () => {
    const text = setup + route + 'parent.register_blueprint(child, name="one", url_prefix="/one")\nparent.register_blueprint(child, name="two", url_prefix="/two")\napp.register_blueprint(parent)\n';
    const result = find(text, 1);
    expect(result.routes).toHaveLength(1);
    expect(result.cut).toBe(true);
  });
  it('bounds effective-name expansion in a route-empty branching graph', () => {
    const owners = Array.from({ length: 7 }, (_, i) => `b${i} = Blueprint("b${i}", __name__)\n`).join('');
    const branches = Array.from({ length: 6 }, (_, i) => 5 - i).map(i => Array.from({ length: 10 }, (_, n) => `b${i}.register_blueprint(b${i + 1}, name="n${n}")\n`).join('')).join('');
    const text = imports + 'app = Flask(__name__)\n' + owners + '@app.route("/direct")\ndef direct():\n    pass\n' + branches + 'app.register_blueprint(b0)\n';
    const result = find(text, 100_000, 1_000_000);
    expect(result.cut).toBe(true);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/direct', prefix: 'unknown' });
  });
  it('preserves direct Flask and nested FastAPI behavior in the same reader', () => {
    expect(find(setup + route + 'app.register_blueprint(child)\n').routes).toMatchObject([{ path: '/users/detail', prefix: 'known' }]);
    const fast = 'from fastapi import FastAPI, APIRouter\napp = FastAPI()\na = APIRouter(prefix="/a")\nb = APIRouter(prefix="/b")\n@b.get("/x")\ndef x():\n    pass\na.include_router(b)\napp.include_router(a)\n';
    expect(find(fast).routes).toMatchObject([{ path: '/a/b/x', prefix: 'known' }]);
  });
});
