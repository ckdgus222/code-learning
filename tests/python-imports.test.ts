import { describe, expect, it } from 'vitest';
import { parse } from '../src/core/analysis/syntax';
import { initFactsOf, mentionsMachinery, pythonImportsOf, resolvePythonImport, type PythonFacts } from '../src/core/analysis/python-imports';
import { PYTHON_STDLIB } from '../src/core/analysis/python-stdlib';

const tree = (text: string) => parse(text, 'x.py');
const imports = (text: string) => pythonImportsOf(tree(text).firstNamedChild!);
const plain: PythonFacts = { init: () => new Set(), plain: () => true };
const resolve = (text: string, from = 'pkg/main.py', files = ['pkg/__init__.py', 'pkg/service.py'], facts = plain) =>
  imports(text).flatMap(item => resolvePythonImport(from, item, new Set([...files, from]), facts));
const file = (relativePath: string, specifier: string, names: string[] | 'all' = 'all') => ({ kind: 'file', relativePath, specifier, names });
const ambiguous = (candidates: string[]) => ({ kind: 'unresolved', reason: 'ambiguous', candidates });
const machineryReason = 'import 동작을 바꿀 수 있는 이름(__name__, __path__, __getattr__ 등)이 얽혀 있어 확정하지 않았어요.';
const unsettledReason = '코드만으로는 확정하지 못했어요. 실행 방법, Python 버전, 설치된 패키지에 따라 이 파일이 아닐 수 있어요.';
const factsWithInit = (text: string | null): PythonFacts => ({ ...plain, init: () => text === null ? null : initFactsOf(tree(text)) });

describe('reading Python imports', () => {
  it.each([
    ['import a.b', [{ level: 0, module: ['a', 'b'], names: null }]],
    ['import a.b as x, c', [{ level: 0, module: ['a', 'b'], names: null }, { level: 0, module: ['c'], names: null }]],
    ['from a.b import n1, n2 as y', [{ level: 0, module: ['a', 'b'], names: ['n1', 'n2'] }]],
    ['from a.b import *', [{ level: 0, module: ['a', 'b'], names: 'all' }]],
    ['from .m import n', [{ level: 1, module: ['m'], names: ['n'] }]],
    ['from .. import n', [{ level: 2, module: [], names: ['n'] }]],
    ['from ...p.q import *', [{ level: 3, module: ['p', 'q'], names: 'all' }]],
    ['from . import (n, x as y)', [{ level: 1, module: [], names: ['n', 'x'] }]],
    // Dots written apart are still one dot each.
    ['from . . import n', [{ level: 2, module: [], names: ['n'] }]],
    ['from .. .m import n', [{ level: 3, module: ['m'], names: ['n'] }]],
    ['from ｐkg import ｓervice', [{ level: 0, module: ['ｐkg'], names: ['ｓervice'] }]],
    ['from __future__ import annotations', []], ['from __ｆuture__ import annotations', []], ['pass', []], ['importlib.import_module("x")', []],
    ['from . import a as', []],
  ])('%s', (text, expected) => expect(imports(text)).toEqual(expected));

  it('copies the 329-name standard-library union, including private modules and version changes', () => {
    expect(PYTHON_STDLIB.size).toBe(329);
    for (const name of ['__future__', '_abc', '_zstd', 'sys', 'email', 'annotationlib', 'tomllib', 'distutils', 'cgi']) expect(PYTHON_STDLIB.has(name)).toBe(true);
  });
});

describe('import-only initializers', () => {
  it('collects normalized bindings and skips only unaliased from-dot submodules', () => {
    const source = `"doc"
pass
import a.b, c.d as e
from m import n, x as y
from . import service, model as alias
from .. import parent
from .other import value
from __future__ import annotations
ｓervice = 1
__all__ = ["a", (2, True, None), {3}]
__version__ = "1.0"
negative = -1
positive = +2.5
`;
    expect([...initFactsOf(tree(source))!]).toEqual(['a', 'e', 'n', 'y', 'alias', 'parent', 'value', 'annotations', 'service', '__all__', '__version__', 'negative', 'positive']);
  });

  it.each(['', '# comment', '("doc")', '(\n# comment\n"doc"\n)', '"a" "b"', 'pass', 'from . import service'])('accepts %s', text => {
    expect(initFactsOf(tree(text))).toEqual(new Set());
  });

  const nonImportOnly = ['from m import *', "globals()['service'] = 1", 'call()', 'def service(): pass', 'class Service: pass',
    'if True: pass', 'try:\n pass\nexcept: pass', 'a.service = 1', 'a[0] = 1', 'service = f"{x}"', 'service = f"plain"',
    'a = service = 1', 'service =', 'service: int = 1', 'service = {}', '(1)', 'service = -call()', 'service = [call()]'];
  it.each(nonImportOnly)('rejects %s and withholds the submodule arrow', text => {
    expect(initFactsOf(tree(text))).toBeNull();
    expect(resolve('from . import service', undefined, undefined, factsWithInit(text)))
      .toMatchObject([ambiguous(['pkg/service.py', 'pkg/__init__.py'])]);
  });

  it.each(['', 'from .models import User', 'from . import service'])('does not shadow a submodule: %s', text => {
    expect(resolve('from . import service', undefined, undefined, factsWithInit(text))).toEqual([file('pkg/service.py', '.')]);
  });
  it.each(['service = 1', 'import service', 'import other as service', 'from other import service', 'from other import x as service',
    'from . import service as service', 'ｓervice = 1', null])('cannot prove the name is a submodule: %s', text => {
    expect(resolve('from . import service', undefined, undefined, factsWithInit(text)))
      .toMatchObject([ambiguous(['pkg/service.py', 'pkg/__init__.py'])]);
  });
});

describe('walking relative module paths', () => {
  it('takes all names from a module and deduplicates initializer targets while merging names', () => {
    expect(resolve('from .service import a, b')).toEqual([file('pkg/service.py', '.service', ['a', 'b'])]);
    expect(resolve('from .service import *')).toEqual([file('pkg/service.py', '.service')]);
    expect(resolve('from . import service, x, y')).toEqual([file('pkg/service.py', '.'), file('pkg/__init__.py', '.', ['x', 'y'])]);
    expect(resolve('from . import service, service')).toEqual([file('pkg/service.py', '.')]);
    expect(resolve('from . import *')).toEqual([file('pkg/__init__.py', '.')]);
  });
  it('walks up and through packages and namespace folders', () => {
    const files = ['pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/service.py', 'pkg/ns/model.py'];
    expect(resolve('from ..sub.service import X', 'pkg/inner/main.py', files)).toEqual([file('pkg/sub/service.py', '..sub.service', ['X'])]);
    expect(resolve('from . import sub', undefined, files)).toEqual([file('pkg/sub/__init__.py', '.')]);
    expect(resolve('from .sub import *', undefined, files)).toEqual([file('pkg/sub/__init__.py', '.sub')]);
    expect(resolve('from .ns import model', undefined, files)).toEqual([file('pkg/ns/model.py', '.ns')]);
    expect(resolve('from .ns import *', undefined, files)).toEqual([]);
    expect(resolve('from . import ns', undefined, files)).toEqual([]);
    expect(resolve('import pkg.ns', undefined, files)).toEqual([]);
  });
  it('requires names from a namespace folder to exist and retains a successful sibling', () => {
    expect(resolve('from . import service, absent', undefined, ['pkg/service.py']))
      .toEqual([file('pkg/service.py', '.'), { kind: 'unresolved', reason: 'not-found', candidates: [], specifier: '.' }]);
  });
  it.each(['from .. import x', 'from ...p.q import *'])('stops above the project: %s', text => {
    expect(resolve(text, 'main.py', [])).toMatchObject([{ kind: 'unresolved', reason: 'outside', candidates: [] }]);
  });
  it.each(['from .missing import X', 'from .a.b import X'])('reports missing or blocked paths: %s', text => {
    expect(resolve(text, undefined, ['pkg/a.py', 'pkg/a/b.py'])).toMatchObject([{ reason: 'not-found' }]);
  });
  it.each(['from .m import X', 'from .m.child import X', 'from . import m'])('keeps module/package conflicts: %s', text => {
    expect(resolve(text, undefined, ['pkg/m.py', 'pkg/m/__init__.py', 'pkg/m/child.py']))
      .toMatchObject([ambiguous(['pkg/m.py', 'pkg/m/__init__.py'])]);
  });
  it('adds the initializer when an attribute could also hide a conflict', () => {
    expect(resolve('from . import m', undefined, ['pkg/__init__.py', 'pkg/m.py', 'pkg/m/__init__.py'], factsWithInit('m = 1')))
      .toMatchObject([ambiguous(['pkg/m.py', 'pkg/m/__init__.py', 'pkg/__init__.py'])]);
  });
});

describe('absolute imports and Form B guards', () => {
  it.each(['', 'src/', 'services/api/', 'services/api/src/'])('connects the own top-level package under %s', prefix => {
    const files = [`${prefix}app/__init__.py`, `${prefix}app/models.py`];
    expect(resolve('from app.models import X', `${prefix}app/main.py`, files)).toEqual([file(`${prefix}app/models.py`, 'app.models', ['X'])]);
    expect(resolve('import app.models', `${prefix}app/main.py`, files)).toEqual([file(`${prefix}app/models.py`, 'app.models')]);
    expect(resolve('import app', `${prefix}app/main.py`, files)).toEqual([file(`${prefix}app/__init__.py`, 'app')]);
  });
  it.each(['main.py', 'tests/test_x.py'])('withholds imports outside the package: %s', from => {
    expect(resolve('from app.models import X', from, ['app/__init__.py', 'app/models.py']))
      .toMatchObject([{ ...ambiguous(['app/models.py']), reasonText: unsettledReason }]);
  });
  it.each([
    ['app/main.py', ['app/models.py']],
    ['outer/app/main.py', ['outer/__init__.py', 'outer/app/__init__.py', 'outer/app/models.py']],
    ['app/main.py', ['app/__init__.py', 'app/models.py', 'app/app/__init__.py', 'app/app/models.py']],
    ['app/main.py', ['app/__init__.py', 'app/models.py', 'src/app/__init__.py', 'src/app/models.py']],
  ] as [string, string[]][])('withholds missing init, subpackage or multiple hit roots: %s %s', (from, files) => {
    const result = resolve('import app.models', from, files);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(target => target.kind === 'unresolved' && target.reason === 'ambiguous' && target.reasonText === unsettledReason)).toBe(true);
  });
  it.each(['sys', 'email', 'annotationlib'])('withholds a standard-library-named own package: %s', name => {
    expect(resolve(`import ${name}`, `${name}/main.py`, [`${name}/__init__.py`]))
      .toMatchObject([{ ...ambiguous([`${name}/__init__.py`]), reasonText: unsettledReason }]);
  });
  it.each(['utils', 'logging'])('lists a script sibling as a candidate: %s', name => {
    expect(resolve(`import ${name}`, 'app/main.py', [`app/${name}.py`])).toMatchObject([ambiguous([`app/${name}.py`])]);
  });
  it('reports a module blocking a dotted path even with a descendant on disk', () => {
    expect(resolve('import a.b', 'main.py', ['a.py', 'a/b.py'])).toMatchObject([{ reason: 'not-found', candidates: [] }]);
  });
  it('passes conflicts through instead of treating their files as settled candidates', () => {
    expect(resolve('import a.b', 'main.py', ['a.py', 'a/__init__.py', 'a/b.py']))
      .toMatchObject([ambiguous(['a.py', 'a/__init__.py'])]);
  });
  it('keeps folders without files empty for relative imports and not-found for unsettled absolute ones', () => {
    expect(resolve('import ns', 'main.py', ['ns/child.py'])).toMatchObject([{ reason: 'not-found' }]);
    expect(resolve('from ns import *', 'main.py', ['ns/child.py'])).toMatchObject([{ reason: 'not-found' }]);
  });
  it('finds unreachable same-named files, but groups stdlib and external names by their top-level name', () => {
    expect(resolve('import service', 'main.py', ['other/service.py', 'else/service/__init__.py']))
      .toMatchObject([{ reason: 'not-found', candidates: ['else/service/__init__.py', 'other/service.py'], reasonText: expect.stringContaining('이 import 경로로는 닿지 않아요') }]);
    expect(resolve('import logging.config', 'main.py', ['other/logging/config.py'])).toEqual([{ kind: 'external', specifier: 'logging' }]);
    expect(resolve('from fastapi.responses import Response', 'main.py', [])).toEqual([{ kind: 'external', specifier: 'fastapi' }]);
  });
  it('keeps five candidates in path order and says that there are more', () => {
    const files = Array.from({ length: 999 }, (_, index) => `d${String(index).padStart(3, '0')}/a.py`);
    const [entry] = resolve('import a', 'main.py', files);
    expect(entry).toMatchObject({ reason: 'not-found', candidates: files.slice(0, 5) });
    expect((entry as { reasonText: string }).reasonText).toMatch(/닿지 않아요.*후보가 더 있지만 처음 5개만 적었어요\.$/);
    const [exact] = resolve('import a', 'main.py', files.slice(0, 5));
    expect(exact).toMatchObject({ candidates: files.slice(0, 5) });
    expect((exact as { reasonText: string }).reasonText).not.toContain('후보가 더 있지만');
  });
  it('looks at 2,000 names of one statement, merges what they share and says the rest was not looked at', () => {
    const names = Array.from({ length: 36_000 }, (_, index) => `n${index}`);
    const targets = resolve(`from . import ${names.join(', ')}`, 'pkg/main.py', ['pkg/__init__.py']);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ kind: 'file', relativePath: 'pkg/__init__.py' });
    expect((targets[0] as { names: string[] }).names).toEqual(names.slice(0, 2_000));
    expect(targets[1]).toMatchObject({ kind: 'unresolved', candidates: [], reasonText: '한 문장이 가져오는 이름이 2,000개를 넘어, 그 뒤의 이름은 보지 않았어요.' });
    expect(resolve(`from . import ${names.slice(0, 2_000).join(', ')}`, 'pkg/main.py', ['pkg/__init__.py'])).toHaveLength(1);
  });
  it('counts a repeated name once and merges equal results of one statement', () => {
    // More repeats than names are looked at: counted once, so nothing is reported as left out.
    const repeated = Array.from({ length: 2_500 }, () => 'service').join(', ');
    expect(resolve(`from . import ${repeated}`)).toEqual([file('pkg/service.py', '.')]);
    expect(resolve('from . import a, b, c', 'ns/main.py', ['ns/other.py'])).toEqual([{ kind: 'unresolved', reason: 'not-found', candidates: [], specifier: '.' }]);
  });
  it('cuts a very long dotted module path in the specifier', () => {
    const [target] = resolve(`import ${Array.from({ length: 400 }, () => 'a').join('.')}`, 'main.py', []);
    expect(target).toEqual({ kind: 'external', specifier: 'a' });
    const [inside] = resolve(`from .${Array.from({ length: 400 }, () => 'a').join('.')} import x`);
    expect(inside.specifier).toHaveLength(301);
    const [outside] = resolve(`import ${'z'.repeat(5_000)}`, 'main.py', []);
    expect(outside).toMatchObject({ kind: 'external' });
    expect(outside.specifier).toHaveLength(301);
  });
  it('normalizes module and imported names without normalizing filenames', () => {
    expect(resolve('from ｐkg import ｓervice')).toEqual([file('pkg/service.py', 'pkg')]);
    expect(resolve('from .ｓervice import X')).toEqual([file('pkg/service.py', '.service', ['X'])]);
    expect(resolve('from .service import X', undefined, ['pkg/ｓervice.py'])).toMatchObject([{ reason: 'not-found' }]);
    expect(resolve('from pkg import service', undefined, undefined, factsWithInit('ｓervice = 1')))
      .toMatchObject([ambiguous(['pkg/service.py', 'pkg/__init__.py'])]);
  });
});

describe('files that can change import machinery', () => {
  it.each(['__getattr__', '__path__', '__package__', '__spec__', '__loader__', '__import__', '__builtins__', '__dict__', '__class__'])
  ('detects %s as identifier, attribute and import alias', name => {
    for (const text of [name, `x.${name}`, `from helpers import lookup as ${name}`]) expect(mentionsMachinery(tree(text))).toBe(true);
  });
  it.each(['if __name__ == "__main__": pass', 'logging.getLogger(__name__)', 'Flask(import_name=__name__)'])('allows plainly read __name__: %s', text => {
    expect(mentionsMachinery(tree(text))).toBe(false);
    const facts = { ...plain, plain: () => !mentionsMachinery(tree(text)) };
    expect(resolve('from . import service', undefined, undefined, facts)).toEqual([file('pkg/service.py', '.')]);
  });
  it.each(['__name__ = "email.main"', '__name__.split(".")', 'x = __name__', 'f"{__name__}"', 'fn(__name__=1)', 'class X(__name__): pass', '__ｐath__ = []'])
  ('withholds arrows for non-plain reads or rebinding: %s', text => {
    expect(mentionsMachinery(tree(text))).toBe(true);
    expect(resolve('from . import service', undefined, undefined, { ...plain, plain: name => name !== 'pkg/main.py' || !mentionsMachinery(tree(text)) }))
      .toMatchObject([{ ...ambiguous(['pkg/service.py']), reasonText: machineryReason }]);
  });
  it.each(['__name__', '__path__', '__doc__'])('never treats a special imported name as a file: %s', name => {
    for (const files of [[`pkg/${name}.py`], ['pkg/__init__.py', `pkg/${name}.py`]]) {
      expect(resolve(`from pkg import ${name}`, undefined, files).every(target => target.kind !== 'file')).toBe(true);
      expect(resolve(`from . import ${name}`, undefined, files)).toMatchObject([{ reason: 'ambiguous', reasonText: machineryReason }]);
    }
  });
  it('never draws an own-package arrow for __main__', () => {
    expect(resolve('import __main__', '__main__/main.py', ['__main__/__init__.py']))
      .toMatchObject([{ reason: 'ambiguous', reasonText: machineryReason }]);
  });
  it.each(['pkg/main.py', 'pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/final/__init__.py'])('checks importer, anchor, passed and final packages: %s', unsafe => {
    const files = ['pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/final/__init__.py'];
    const facts = { ...plain, plain: (name: string) => name !== unsafe };
    for (const text of ['from .sub import final', 'import pkg.sub.final']) {
      expect(resolve(text, undefined, files, facts)).toMatchObject([{ ...ambiguous(['pkg/sub/final/__init__.py']), reasonText: machineryReason }]);
    }
  });
  it.each(['from .helpers import lookup as __getattr__', '__path__ = []', null])('withholds arrows through a changed or unread initializer: %s', text => {
    const facts = { init: () => text === null ? null : initFactsOf(tree(text)), plain: (name: string) => name !== 'pkg/__init__.py' || (text !== null && !mentionsMachinery(tree(text))) };
    for (const statement of ['from . import service', 'from pkg import service', 'from .service import X']) {
      const result = resolve(statement, undefined, undefined, facts);
      expect(result.every(target => target.kind === 'unresolved' && target.reasonText === machineryReason)).toBe(true);
      expect(result).toContainEqual(expect.objectContaining(ambiguous(['pkg/service.py'])));
    }
  });
});

it('reads deeply nested literal containers without recursive JavaScript calls', () => {
  const source = `__all__ = ${'['.repeat(5000)}"name"${']'.repeat(5000)}`;
  expect(initFactsOf(tree(source))).toEqual(new Set(['__all__']));
});
