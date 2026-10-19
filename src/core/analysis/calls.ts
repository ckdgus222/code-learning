import type Parser from 'tree-sitter';
import type { CallLink, CallSite, CallUnknownReason, FunctionCalls, ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { assertAllowedFile, MAX_FILE_BYTES, readAllowed } from '../project/files';
import { candidatesFor, codeFile, isRelative, parse, type MapLimits } from './project-map';
import { functionName, functionTypes, importOf } from './syntax';

/*
 * Plan v2.3 F: which function a call by name leads to, read from the code only. A name is settled by its
 * nearest declaration, scope by scope outward from the call; whatever the rules cannot settle is reported
 * as unknown with its reason, never guessed.
 */

const MAX_TEXT = 300;
// A const or let whose value is one of these is a function by that name, as the analyzer lists it.
const functionValues = new Set(['arrow_function', 'function_expression', 'generator_function']);

/** What a name means in the scope that declares it. */
type Declaration =
  /** A function declaration at the top of a file, function or namespace body, a const/let function, or a function expression's own name. */
  | { kind: 'function'; fn: Parser.SyntaxNode }
  | { kind: 'import'; specifier: string | null; imported: string }
  /** A parameter or any other variable, class, catch or for name, namespace import, `arguments`. */
  | { kind: 'variable' }
  | { kind: 'var' }
  | { kind: 'block-function' };
interface Scope { parent: Scope | null; names: Map<string, Declaration[]> }
interface CallFact {
  node: Parser.SyntaxNode;
  scope: Scope;
  /** The innermost function the analyzer lists that holds the call; null at the top of the file. */
  fn: Parser.SyntaxNode | null;
  inNamespace: boolean;
}
/** An export at the top of a file. `fn` is the exported function, `local` its name inside the file. */
interface ExportFact { fn: Parser.SyntaxNode | null; local: string | null }
interface FileFacts {
  file: ProjectFile;
  hash: string;
  /** Walked to the end without a syntax error: only then are its declarations and assignments all known. */
  complete: boolean;
  incompleteReason: string | null;
  /** A `with` statement, an `eval(…)` call or a name written with escapes (`\u0066`): names here cannot be settled. */
  unclear: boolean;
  program: Scope;
  calls: CallFact[];
  assignments: { name: string; scope: Scope }[];
  /** The functions the analyzer lists, in source order. */
  functions: Parser.SyntaxNode[];
  exports: Map<string, ExportFact[]>;
  reexported: Set<string>;
  reexportsAll: boolean;
}
type Found =
  | { kind: 'linked'; facts: FileFacts; fn: Parser.SyntaxNode }
  | { kind: 'external'; specifier: string }
  | { kind: 'unknown'; reason: CallUnknownReason; detail: string | null };
const unknown = (reason: CallUnknownReason, detail: string | null = null): Found => ({ kind: 'unknown', reason, detail });

const newScope = (parent: Scope | null): Scope => ({ parent, names: new Map() });
function declare(scope: Scope, name: string, declaration: Declaration): void {
  const list = scope.names.get(name);
  if (list) list.push(declaration); else scope.names.set(name, [declaration]);
}
const sameRange = (a: Parser.SyntaxNode, b: { startIndex: number; endIndex: number }) =>
  a.startIndex === b.startIndex && a.endIndex === b.endIndex;
// Anonymous tokens such as `type` in `import type` are children without a name.
const hasToken = (node: Parser.SyntaxNode, token: string) => node.children.some(child => !child.isNamed && child.type === token);

// Wrappers an assignment target may wear without changing which name it writes to: `(f)`, `f!`, `f as T`, `<T>f`.
const targetWrappers = new Set(['parenthesized_expression', 'non_null_expression', 'as_expression', 'satisfies_expression', 'type_assertion']);
// Comments are named children too (`(/* note */ f) = …`), so they are skipped when picking a part.
const firstCode = (node: Parser.SyntaxNode | null) => node?.namedChildren.find(child => child.type !== 'comment') ?? null;
const lastCode = (node: Parser.SyntaxNode | null) => node?.namedChildren.findLast(child => child.type !== 'comment') ?? null;
/** What a wrapper wraps: in `<T>f` the type comes first, in the others the target does. */
const wrappedPart = (node: Parser.SyntaxNode) => node.type === 'type_assertion' ? lastCode(node) : firstCode(node);
/** A node without the wrappers above: `(eval)` and `eval!` still name eval. */
function unwrapped(node: Parser.SyntaxNode): Parser.SyntaxNode {
  const inner = targetWrappers.has(node.type) ? wrappedPart(node) : null;
  return inner ? unwrapped(inner) : node;
}
/** A property's name as a member call writes it: `save`, also for `"save"() {}` and `{ 'save': … }`. */
function propertyName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'string') return node.namedChildren.find(child => child.type === 'string_fragment')?.text ?? '';
  return node.type === 'computed_property_name' ? null : node.text;
}
/** The property a member call names: `obj.save()` and `obj['save']()`; null when it is computed. */
function calledProperty(callee: Parser.SyntaxNode): string | null {
  if (callee.type === 'member_expression') return propertyName(callee.childForFieldName('property'));
  const index = callee.type === 'subscript_expression' ? callee.childForFieldName('index') : null;
  return index?.type === 'string' ? propertyName(index) : null;
}
const globalObjects = new Set(['window', 'globalThis', 'self', 'global']);
const codeRunners = new Set(['eval', 'Function']);
const isMemberCall = (callee: Parser.SyntaxNode) => callee.type === 'member_expression' || callee.type === 'subscript_expression';

/**
 * The names a declaration, destructuring pattern or assignment target binds or writes to (`f`, `[f!]`,
 * `({ x: f } = …)`); property keys, default values and member targets (`obj.f = …`) are not names.
 */
function bindingNames(node: Parser.SyntaxNode | null): string[] {
  if (!node) return [];
  if (targetWrappers.has(node.type)) return bindingNames(wrappedPart(node));
  switch (node.type) {
    case 'identifier': case 'shorthand_property_identifier_pattern': return [node.text];
    case 'required_parameter': case 'optional_parameter': return bindingNames(node.childForFieldName('pattern'));
    case 'assignment_pattern': case 'object_assignment_pattern': return bindingNames(node.childForFieldName('left'));
    case 'pair_pattern': return bindingNames(node.childForFieldName('value'));
    case 'rest_pattern': return bindingNames(firstCode(node));
    case 'array_pattern': case 'object_pattern': return node.namedChildren.flatMap(bindingNames);
    default: return [];
  }
}

/** Where the walk is: the scope a name found here is looked up from, and what holds this place. */
interface Frame {
  scope: Scope;
  /** Where `var` and block function declarations go: the nearest function body, namespace body or file. */
  varScope: Scope;
  fn: Parser.SyntaxNode | null;
  /** Inside a function with a syntax error, which the analyzer neither lists nor goes into. */
  broken: boolean;
  inNamespace: boolean;
  /** Start of the statement block that is the body of the function or namespace this frame belongs to. */
  bodyStart: number;
  bodyIsNamespace: boolean;
  /** Children are statements of a list (file, block, case); not the lone statement of `if (x) function f() {}` or a loop. */
  inList: boolean;
  /**
   * Children worked out where the function or class sits, not inside it: a method's computed name
   * (`[key()]() {}`), parameter decorators (`m(@dec() x)`) and class decorators (`@dec() class C {}`).
   */
  outside?: { starts: Set<number>; frame: Frame };
}

/**
 * Scopes, declarations, assignments, calls, listed functions and exports of one file, from one walk with a
 * tree cursor (moving by sibling or parent searches from the root and gets slow in deeply nested code).
 */
function readFacts(file: ProjectFile, text: string, hash: string, nodeBudget: number): FileFacts {
  const root = parse(text, file.relativePath);
  const program = newScope(null);
  const facts: FileFacts = { file, hash, complete: !root.hasError, incompleteReason: root.hasError ? '구문 오류가 있어 이 파일의 이름은 확정하지 않았어요.' : null,
    unclear: false, program, calls: [], assignments: [], functions: [], exports: new Map(), reexported: new Set(), reexportsAll: false };
  const pendingExports: { exported: string; local: string }[] = [];
  // Escapes in names are written `\u…`; most files have none, so names are only looked at when one might.
  const mayEscape = text.includes('\\u');
  const addExport = (exported: string, entry: ExportFact) => {
    const list = facts.exports.get(exported);
    if (list) list.push(entry); else facts.exports.set(exported, [entry]);
  };

  // What a node means for names, and the frame its children are in; null skips its children.
  const enter = (cursor: Parser.TreeCursor, frame: Frame): Frame | null => {
    const type = cursor.nodeType;
    if (!cursor.nodeIsNamed || type === 'ERROR' || cursor.nodeIsMissing || type === 'comment') return null;
    // A name written with escapes (`\u0066`, also a class's) is the same name as `f`, which is not worked out here.
    // Every kind of name has `identifier` in its type (`shorthand_property_identifier_pattern` too).
    if (mayEscape && type.includes('identifier') && cursor.nodeText.includes('\\')) facts.unclear = true;
    // Any mention of eval or Function, called directly or not (`(0, eval)(…)`, `const e = eval`), can run text
    // that declares or replaces names, so the file's names are not settled.
    // Any kind of name counts (`{ eval }` too), except a type name such as `cb: Function`, which does not run.
    if (type.includes('identifier') && type !== 'type_identifier' && codeRunners.has(cursor.nodeText)) facts.unclear = true;
    if ((type === 'computed_property_name' || type === 'decorator') && frame.outside?.starts.has(cursor.startIndex)) return frame.outside.frame;
    if (functionTypes.has(type)) {
      const node = cursor.currentNode;
      const body = node.childForFieldName('body');
      const listed = !frame.broken && !node.hasError && !!body;
      if (listed) facts.functions.push(node);
      const name = node.childForFieldName('name')?.text;
      if (name && (type === 'function_declaration' || type === 'generator_function_declaration')) {
        if (frame.scope === frame.varScope && frame.inList) declare(frame.scope, name, { kind: 'function', fn: node });
        else {
          // Outside strict mode a block's function (or `if (x) function f() {}`) also reaches the enclosing
        // function, like a `var`.
          declare(frame.scope, name, { kind: 'block-function' });
          if (frame.varScope !== frame.scope) declare(frame.varScope, name, { kind: 'block-function' });
        }
      }
      // A function expression's own name sits outside its parameters: `function f(f) { f() }` calls the parameter.
      let outer = frame.scope;
      if (name && (type === 'function_expression' || type === 'generator_function')) {
        outer = newScope(outer);
        declare(outer, name, { kind: 'function', fn: node });
      }
      // Parameters get a scope of their own: a default value cannot see declarations in the body.
      const parameters = newScope(outer);
      if (type !== 'arrow_function') declare(parameters, 'arguments', { kind: 'variable' });
      const list = node.childForFieldName('parameters');
      const single = node.childForFieldName('parameter');
      for (const parameter of list ? list.namedChildren.flatMap(bindingNames) : bindingNames(single)) {
        declare(parameters, parameter, { kind: 'variable' });
      }
      const key = type === 'method_definition' ? node.childForFieldName('name') : null;
      const outsideStarts = new Set(list?.namedChildren.flatMap(parameter => parameter.namedChildren)
        .filter(child => child.type === 'decorator').map(child => child.startIndex));
      if (key?.type === 'computed_property_name') outsideStarts.add(key.startIndex);
      // A class method's are already placed by its class body (they run where the class is defined).
      const placed = frame.outside && [...outsideStarts].some(start => frame.outside!.starts.has(start));
      return { scope: parameters, varScope: parameters, fn: listed ? node : frame.fn, broken: frame.broken || node.hasError,
        inNamespace: frame.inNamespace, bodyStart: body?.type === 'statement_block' ? body.startIndex : -1, bodyIsNamespace: false, inList: true,
        outside: outsideStarts.size ? { starts: outsideStarts, frame: placed ? frame.outside!.frame : frame } : undefined };
    }
    switch (type) {
      case 'statement_block': {
        const scope = newScope(frame.scope);
        if (cursor.startIndex !== frame.bodyStart) return { ...frame, scope, bodyStart: -1, inList: true };
        return { ...frame, scope, varScope: scope, inNamespace: frame.inNamespace || frame.bodyIsNamespace, bodyStart: -1, bodyIsNamespace: false, inList: true };
      }
      // Statements that hold a single statement rather than a list.
      case 'if_statement': case 'else_clause': case 'while_statement': case 'do_statement': case 'labeled_statement':
        return { ...frame, inList: false };
      case 'class_declaration': case 'abstract_class_declaration': case 'class': {
        const node = cursor.currentNode;
        const name = node.childForFieldName('name')?.text;
        if (!name) return frame;
        if (type !== 'class') declare(frame.scope, name, { kind: 'variable' });
        // The class's own name covers its `extends` expression and body; its decorators run outside.
        const scope = newScope(frame.scope);
        declare(scope, name, { kind: 'variable' });
        const decorators = new Set(node.namedChildren.filter(child => child.type === 'decorator').map(child => child.startIndex));
        return { ...frame, scope, bodyStart: -1, outside: decorators.size ? { starts: decorators, frame } : frame.outside };
      }
      // A class body runs later (fields on `new`, methods when called), so its calls belong to no function here,
      // as the analyzer leaves class bodies out of a function's steps. Its decorators and computed names
      // run where the class is defined.
      case 'class_body': {
        const starts = new Set<number>();
        for (const member of cursor.currentNode.namedChildren) {
          if (member.type === 'decorator') starts.add(member.startIndex);
          for (const part of member.namedChildren) if (part.type === 'decorator' || part.type === 'computed_property_name') starts.add(part.startIndex);
          for (const parameter of member.childForFieldName('parameters')?.namedChildren ?? []) {
            for (const part of parameter.namedChildren) if (part.type === 'decorator') starts.add(part.startIndex);
          }
        }
        return { ...frame, fn: null, outside: starts.size ? { starts, frame } : undefined };
      }
      case 'for_statement': return { ...frame, scope: newScope(frame.scope), bodyStart: -1, inList: false };
      case 'switch_body': return { ...frame, scope: newScope(frame.scope), bodyStart: -1, inList: true };
      case 'for_in_statement': {
        const node = cursor.currentNode;
        const scope = newScope(frame.scope);
        const kind = node.childForFieldName('kind')?.type;
        const names = bindingNames(node.childForFieldName('left'));
        if (kind === 'var') for (const name of names) declare(frame.varScope, name, { kind: 'var' });
        else if (kind) for (const name of names) declare(scope, name, { kind: 'variable' });
        else for (const name of bindingNames(node.childForFieldName('left'))) facts.assignments.push({ name, scope: frame.scope });
        return { ...frame, scope, bodyStart: -1, inList: false };
      }
      case 'catch_clause': {
        const scope = newScope(frame.scope);
        for (const name of bindingNames(cursor.currentNode.childForFieldName('parameter'))) declare(scope, name, { kind: 'variable' });
        return { ...frame, scope, bodyStart: -1 };
      }
      case 'lexical_declaration': {
        for (const declarator of cursor.currentNode.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name');
          const value = declarator.childForFieldName('value');
          if (name?.type === 'identifier' && value && functionValues.has(value.type)) declare(frame.scope, name.text, { kind: 'function', fn: value });
          else for (const bound of bindingNames(name)) declare(frame.scope, bound, { kind: 'variable' });
        }
        return frame;
      }
      case 'variable_declaration': {
        for (const declarator of cursor.currentNode.namedChildren) {
          for (const bound of bindingNames(declarator.childForFieldName('name'))) declare(frame.varScope, bound, { kind: 'var' });
        }
        return frame;
      }
      case 'import_statement': {
        const node = cursor.currentNode;
        // Its names are read here rather than visited, so escapes in them are looked for here too (the
        // clause holds only names; the path string is not part of it).
        const names = node.namedChildren.filter(child => child.type === 'import_clause' || child.type === 'import_require_clause')
          .map(child => child.type === 'import_clause' ? child.text : firstCode(child)?.text ?? '');
        if (mayEscape && names.some(text => text.includes('\\'))) facts.unclear = true;
        // `import type` brings no values to call.
        if (hasToken(node, 'type')) return null;
        const specifier = importOf(node)?.specifier ?? null;
        for (const part of node.namedChildren) {
          if (part.type === 'import_require_clause') {
            const name = part.namedChildren.find(child => child.type === 'identifier')?.text;
            if (name) declare(frame.scope, name, { kind: 'variable' });
          }
          if (part.type !== 'import_clause') continue;
          for (const imported of part.namedChildren) {
            if (imported.type === 'identifier') declare(frame.scope, imported.text, { kind: 'import', specifier, imported: 'default' });
            if (imported.type === 'namespace_import') {
              const name = firstCode(imported)?.text;
              if (name) declare(frame.scope, name, { kind: 'variable' });
            }
            if (imported.type !== 'named_imports') continue;
            for (const item of imported.namedChildren) {
              const name = item.childForFieldName('name')?.text;
              if (item.type !== 'import_specifier' || !name || hasToken(item, 'type')) continue;
              declare(frame.scope, item.childForFieldName('alias')?.text ?? name, { kind: 'import', specifier, imported: name });
            }
          }
        }
        return null;
      }
      case 'export_statement': {
        if (frame.scope !== program) return frame;
        const node = cursor.currentNode;
        // `export type { f }` exports no value to call.
        if (hasToken(node, 'type')) return null;
        const source = node.childForFieldName('source');
        const clause = node.namedChildren.find(child => child.type === 'export_clause');
        const specifiers = clause?.namedChildren.filter(child => child.type === 'export_specifier' && !hasToken(child, 'type')) ?? [];
        const exportedName = (item: Parser.SyntaxNode) => (item.childForFieldName('alias') ?? item.childForFieldName('name'))?.text ?? '';
        if (source) {
          // `export … from` and `export *` are not followed.
          if (!clause) {
            const named = firstCode(node.namedChildren.find(child => child.type === 'namespace_export') ?? null)?.text;
            if (named) facts.reexported.add(named); else facts.reexportsAll = true;
          }
          for (const item of specifiers) facts.reexported.add(exportedName(item));
          return null;
        }
        for (const item of specifiers) {
          const local = item.childForFieldName('name')?.text;
          if (local) pendingExports.push({ exported: exportedName(item), local });
        }
        const declaration = node.childForFieldName('declaration');
        const value = node.childForFieldName('value');
        const isDefault = hasToken(node, 'default');
        if (declaration && (declaration.type === 'function_declaration' || declaration.type === 'generator_function_declaration')) {
          const name = declaration.childForFieldName('name')?.text ?? null;
          addExport(isDefault ? 'default' : name ?? '', { fn: declaration, local: name });
        } else if (declaration?.type === 'lexical_declaration') {
          for (const declarator of declaration.namedChildren) {
            const name = declarator.childForFieldName('name');
            const init = declarator.childForFieldName('value');
            if (name?.type === 'identifier' && init && functionValues.has(init.type)) addExport(name.text, { fn: init, local: name.text });
            else for (const bound of bindingNames(name)) addExport(bound, { fn: null, local: bound });
          }
        } else if (declaration && declaration.type !== 'function_signature' && declaration.type !== 'ambient_declaration') {
          // An overload or ambient signature is not a separate export.
          for (const bound of declaration.type === 'variable_declaration'
            ? declaration.namedChildren.flatMap(declarator => bindingNames(declarator.childForFieldName('name')))
            : [declaration.childForFieldName('name')?.text ?? '']) addExport(isDefault ? 'default' : bound, { fn: null, local: bound });
        }
        if (value) {
          // `export default save;` exports the local `save`, like `export { save as default }`.
          if (value.type === 'identifier') pendingExports.push({ exported: 'default', local: value.text });
          else addExport('default', functionValues.has(value.type)
            // A function expression's own name is not a name of the file, so it has no local name here.
            ? { fn: value, local: null } : { fn: null, local: null });
        }
        return frame;
      }
      case 'call_expression': {
        const node = cursor.currentNode;
        const callee = node.childForFieldName('function');
        if (!callee || callee.type === 'import' || callee.type === 'super') return frame;
        facts.calls.push({ node, scope: frame.scope, fn: frame.fn, inNamespace: frame.inNamespace });
        return frame;
      }
      case 'assignment_expression': case 'augmented_assignment_expression': {
        for (const name of bindingNames(cursor.currentNode.childForFieldName('left'))) facts.assignments.push({ name, scope: frame.scope });
        return frame;
      }
      case 'update_expression': {
        for (const name of bindingNames(cursor.currentNode.childForFieldName('argument'))) facts.assignments.push({ name, scope: frame.scope });
        return frame;
      }
      case 'with_statement': facts.unclear = true; return { ...frame, inList: false };
      // A class's static block is a body of its own: its `var`s stay inside it.
      case 'class_static_block': {
        const body = cursor.currentNode.childForFieldName('body');
        return { ...frame, bodyStart: body ? body.startIndex : -1, bodyIsNamespace: false };
      }
      case 'internal_module': case 'module': {
        const node = cursor.currentNode;
        const name = node.childForFieldName('name');
        if (name?.type === 'identifier') declare(frame.scope, name.text, { kind: 'variable' });
        const body = node.childForFieldName('body');
        return { ...frame, bodyStart: body ? body.startIndex : -1, bodyIsNamespace: true };
      }
      // TS `import f = N.f` declares f as a value that is not followed here.
      case 'import_alias': {
        const name = firstCode(cursor.currentNode);
        if (name?.type === 'identifier') declare(frame.scope, name.text, { kind: 'variable' });
        return frame;
      }
      case 'enum_declaration': {
        const name = cursor.currentNode.childForFieldName('name')?.text;
        if (name) declare(frame.scope, name, { kind: 'variable' });
        return frame;
      }
      // Inside an enum its members are names too (`enum E { f = 1, v = f() }`); like a namespace, not followed.
      case 'enum_body': return { ...frame, inNamespace: true };
      // In a plain script `window.f` is the top-level function f, and it can be written to in many forms
      // (`window.f = …`, `[window.f] = …`, `window.f++`). Any mention of it counts as writing to f.
      case 'member_expression': case 'subscript_expression': {
        const node = cursor.currentNode;
        const holder = node.childForFieldName('object');
        if (!holder || !globalObjects.has(unwrapped(holder).text)) return frame;
        // `window[name]` or `window['\u0066']` may be any top-level name, so the file's names are not settled.
        const index = node.childForFieldName('index');
        const plain = index?.type === 'string' && index.namedChildren.every(child => child.type === 'string_fragment');
        if (type === 'subscript_expression' && !plain) facts.unclear = true;
        const property = calledProperty(node);
        if (property && codeRunners.has(property)) facts.unclear = true;
        if (property) facts.assignments.push({ name: property, scope: program });
        return frame;
      }
      // An overload or ambient signature has no body and declares nothing that runs.
      case 'function_signature': return null;
      default: return frame;
    }
  };

  const cursor = root.walk();
  const outside: Frame[] = [];
  let frame: Frame = { scope: program, varScope: program, fn: null, broken: false, inNamespace: false, bodyStart: -1, bodyIsNamespace: false, inList: true };
  let visited = 0;
  let entering = true;
  if (cursor.gotoFirstChild()) for (;;) {
    if (entering) {
      if (cursor.nodeIsNamed && ++visited > nodeBudget) {
        facts.complete = false;
        facts.incompleteReason = '분석량 한도에 닿아 파일 뒷부분은 보지 않아 이 파일의 이름은 확정하지 않았어요.';
        break;
      }
      const inner = enter(cursor, frame);
      if (inner && cursor.gotoFirstChild()) { outside.push(frame); frame = inner; continue; }
    }
    if (cursor.gotoNextSibling()) { entering = true; continue; }
    if (!outside.length) break;
    cursor.gotoParent();
    frame = outside.pop()!;
    entering = false;
  }

  for (const { exported, local } of pendingExports) {
    const declared = program.names.get(local);
    const only = declared?.length === 1 ? declared[0] : null;
    addExport(exported, { fn: only?.kind === 'function' ? only.fn : null, local });
  }
  return facts;
}

/** Whether the name is written to anywhere inside the scope, inner scopes included. */
function reassigned(facts: FileFacts, name: string, scope: Scope): boolean {
  return facts.assignments.some(assignment => {
    if (assignment.name !== name) return false;
    for (let inner: Scope | null = assignment.scope; inner; inner = inner.parent) if (inner === scope) return true;
    return false;
  });
}

/** The nearest declarations of a name, scope by scope outward. */
function nearest(scope: Scope, name: string): { declared: Declaration[]; scope: Scope } | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const declared = current.names.get(name);
    if (declared) return { declared, scope: current };
  }
  return null;
}

/** The one function exported by this name and not written to again in its file. */
function exportedFunction(facts: FileFacts, name: string): Found {
  if (facts.unclear) return unknown('export', '가져온 파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키가 있어요.');
  if (!facts.complete) return unknown('export', '가져온 파일을 끝까지 보지 못했어요.');
  const entries = facts.exports.get(name) ?? [];
  if (!entries.length) {
    return unknown('export', facts.reexported.has(name) || facts.reexportsAll
      ? '다른 파일에서 다시 내보낸 이름은 따라가지 않아요.' : '그 이름으로 내보낸 것이 없어요.');
  }
  if (entries.length > 1) return unknown('export', '같은 이름으로 내보낸 것이 여럿이에요.');
  const [{ fn, local }] = entries;
  if (!fn) return unknown('export', '내보낸 것을 함수로 정할 수 없어요.');
  if (local) {
    // The exported function must also be the only declaration of its name in the file.
    const declared = facts.program.names.get(local) ?? [];
    if (declared.length !== 1 || declared[0].kind !== 'function' || !sameRange(declared[0].fn, fn)) {
      return unknown('export', '내보낸 쪽에 같은 이름의 선언이 여럿이에요.');
    }
    if (reassigned(facts, local, facts.program)) return unknown('export', '내보낸 쪽에서 다시 대입돼요.');
  }
  return { kind: 'linked', facts, fn };
}

const lineRange = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1,
  endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)) });
function site(call: CallFact, facts: FileFacts): CallSite {
  const [first, ...rest] = call.node.text.split('\n');
  const line = first.replace(/\r$/, '');
  const text = line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : rest.length ? `${line} …` : line;
  return { fileId: facts.file.id, fileHash: facts.hash, startUtf16: call.node.startIndex, endUtf16: call.node.endIndex, ...lineRange(call.node),
    text, inFunction: call.fn ? { name: functionName(call.fn), startUtf16: call.fn.startIndex, endUtf16: call.fn.endIndex,
      startLine: call.fn.startPosition.row + 1 } : null };
}

/** Names the chosen function is called by (plan v2.3 F, '고른 함수의 이름들'). */
function namesOf(fn: Parser.SyntaxNode, facts: FileFacts): FunctionCalls['names'] {
  const local: string[] = [];
  const property: string[] = [];
  const own = fn.childForFieldName('name');
  const parent = fn.parent;
  if (fn.type === 'function_declaration' || fn.type === 'generator_function_declaration') { if (own) local.push(own.text); }
  else if (own && fn.type !== 'method_definition') local.push(own.text);
  // A `var` function cannot be settled, but its calls are still listed as ones that could not be.
  if (parent?.type === 'variable_declarator' && parent.childForFieldName('name')?.type === 'identifier') local.push(parent.childForFieldName('name')!.text);
  const named = (node: Parser.SyntaxNode | null) => { const name = propertyName(node); if (name) property.push(name); };
  if (fn.type === 'method_definition') named(own);
  if (parent?.type === 'pair') named(parent.childForFieldName('key'));
  if (parent && ['public_field_definition', 'field_definition'].includes(parent.type)) {
    named(parent.childForFieldName('name') ?? parent.childForFieldName('property'));
  }
  const exported = [...facts.exports].filter(([, entries]) => entries.some(entry => entry.fn && sameRange(entry.fn, fn))).map(([name]) => name);
  return { local: [...new Set(local)], exported, property: [...new Set(property)] };
}

/**
 * What the chosen function calls, and the calls in the project that lead to it, from the files listed when
 * the folder was opened. Files are only read. Reads stay within the map's limits; a stop request is
 * checked between files, as ending the thread inside a parse would abort the app.
 */
export async function findFunctionCalls(root: string, projectId: string, files: ProjectFile[],
  target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number },
  limits: MapLimits, shouldStop: () => boolean = () => false): Promise<FunctionCalls> {
  const chosenFile = files.find(file => file.id === target.fileId);
  if (!chosenFile) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 파일이 아닙니다.');
  const known = new Map(files.map(file => [file.relativePath, file]));
  const result = { limited: false, unexamined: new Map<string, { fileId: string; relativePath: string; reason: string }>() };
  const skip = (file: ProjectFile, reason: string) => {
    if (!result.unexamined.has(file.id)) result.unexamined.set(file.id, { fileId: file.id, relativePath: file.relativePath, reason });
  };
  let filesRead = 0;
  let bytesRead = 0;
  const texts = new Map<string, Promise<{ text: string; hash: string } | null>>();
  const read = (file: ProjectFile) => {
    if (!texts.has(file.id)) texts.set(file.id, (async () => {
      const left = limits.bytes - bytesRead;
      if (filesRead >= limits.files || left <= 0) { result.limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null; }
      filesRead++;
      try {
        const source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
        bytesRead += Buffer.byteLength(source.text);
        return source;
      } catch (error) {
        if (error instanceof AppError && error.code === 'LIMIT' && left < MAX_FILE_BYTES) {
          result.limited = true; skip(file, '찾기 한도에 닿아 이 파일은 읽지 않았어요.'); return null;
        }
        skip(file, error instanceof AppError ? error.message : '파일을 읽지 못했어요.');
        return null;
      }
    })());
    return texts.get(file.id)!;
  };
  const parsed = new Map<string, FileFacts>();
  const factsOf = (file: ProjectFile, source: { text: string; hash: string }) => {
    if (!parsed.has(file.id)) {
      const facts = readFacts(file, source.text, source.hash, limits.nodesPerFile);
      if (facts.incompleteReason) skip(file, facts.incompleteReason);
      else if (facts.unclear) skip(file, '파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키가 있어 이 파일의 이름은 확정하지 않았어요.');
      parsed.set(file.id, facts);
    }
    return parsed.get(file.id)!;
  };
  // A target may have been deleted, excluded or swapped for a link since the folder was opened (as in the map).
  const availability = new Map<string, Promise<boolean>>();
  const available = (relative: string): Promise<boolean> => {
    if (!availability.has(relative)) availability.set(relative, assertAllowedFile(root, relative).then(() => true, () => false));
    return availability.get(relative)!;
  };

  /** The one code file an import leads to by the map's rules, or why there is none. */
  const importedFile = async (from: FileFacts, specifier: string | null): Promise<ProjectFile | Found> => {
    if (specifier === null) return unknown('import-file', '경로 글을 그대로 읽을 수 없어요.');
    if (specifier.startsWith('/')) return unknown('import-file', '프로젝트 밖을 가리켜요.');
    if (!isRelative(specifier)) return { kind: 'external', specifier };
    const named = candidatesFor(from.file.relativePath, specifier, known);
    if (named === null) return unknown('import-file', '프로젝트 밖을 가리켜요.');
    const usable: string[] = [];
    for (const name of named) if (await available(name)) usable.push(name);
    if (usable.length !== 1) {
      return unknown('import-file', !named.length ? '파일을 찾지 못했어요.' : !usable.length ? '대상을 지금 확인할 수 없어요.' : `후보가 여럿이에요: ${usable.join(', ')}`);
    }
    const file = known.get(usable[0])!;
    return codeFile.test(file.relativePath) ? file : unknown('import-file', '코드 파일이 아니에요.');
  };
  const follow = async (from: FileFacts, specifier: string | null, imported: string): Promise<Found> => {
    const file = await importedFile(from, specifier);
    if ('kind' in file) return file;
    if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
    const source = await read(file);
    if (!source) return unknown('export', '가져온 파일을 읽지 못했어요.');
    return exportedFunction(factsOf(file, source), imported);
  };
  const resolve = async (call: CallFact, facts: FileFacts): Promise<Found> => {
    const callee = call.node.childForFieldName('function')!;
    if (isMemberCall(callee)) return unknown('member');
    if (callee.type !== 'identifier') return unknown('expression');
    if (call.inNamespace) return unknown('namespace');
    if (facts.unclear) return unknown('unclear-file');
    if (!facts.complete) return unknown('incomplete');
    const found = nearest(call.scope, callee.text);
    if (!found) return unknown('undeclared');
    if (found.declared.length > 1) return unknown('duplicate');
    const [declaration] = found.declared;
    switch (declaration.kind) {
      case 'function': return reassigned(facts, callee.text, found.scope) ? unknown('reassigned') : { kind: 'linked', facts, fn: declaration.fn };
      // Writing to an imported name is an error, but the call then may not reach the import.
      case 'import': return reassigned(facts, callee.text, found.scope) ? unknown('reassigned') : follow(facts, declaration.specifier, declaration.imported);
      case 'var': return unknown('var');
      case 'block-function': return unknown('block-function');
      case 'variable': return unknown('not-function');
    }
  };
  const link = (call: CallFact, facts: FileFacts, found: Found): CallLink => {
    const at = site(call, facts);
    if (found.kind === 'external') return { ...at, status: 'external', specifier: found.specifier };
    if (found.kind === 'unknown') return { ...at, status: 'unknown', reason: found.reason, detail: found.detail };
    return { ...at, status: 'linked', target: { fileId: found.facts.file.id, fileHash: found.facts.hash, startUtf16: found.fn.startIndex,
      endUtf16: found.fn.endIndex, startLine: found.fn.startPosition.row + 1, name: functionName(found.fn) } };
  };

  // The chosen function, as it is now.
  const chosenSource = await read(chosenFile);
  if (!chosenSource) throw new AppError('IO', result.unexamined.get(chosenFile.id)?.reason ?? '파일을 읽지 못했어요.');
  if (chosenSource.hash !== target.fileHash) throw new AppError('CHANGED', '함수를 고른 뒤 파일이 바뀌었어요. 파일을 다시 읽어 주세요.');
  const chosen = factsOf(chosenFile, chosenSource);
  const fn = chosen.functions.find(item => item.startIndex === target.startUtf16 && item.endIndex === target.endUtf16);
  if (!fn) throw new AppError('CHANGED', '고른 함수를 지금 파일에서 찾지 못했어요. 파일을 다시 읽어 주세요.');
  const isChosen = (found: Found) => found.kind === 'linked' && found.facts.file.id === chosenFile.id && sameRange(found.fn, fn);

  const calls: CallLink[] = [];
  for (const call of chosen.calls) if (call.fn && sameRange(call.fn, fn)) calls.push(link(call, chosen, await resolve(call, chosen)));

  const names = namesOf(fn, chosen);
  const anyName = new Set([...names.local, ...names.exported.filter(name => name !== 'default'), ...names.property]);
  const callers: CallSite[] = [];
  const maybeCallers: FunctionCalls['maybeCallers'] = [];
  const searched = names.local.length + names.exported.length + names.property.length > 0;
  if (searched) {
    const codeFiles = files.filter(file => codeFile.test(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const file of codeFiles) {
      if (shouldStop()) throw new AppError('CANCELLED', '호출 찾기를 취소했어요.');
      const source = await read(file);
      // An import names the exported name even when it renames it; only a default import does not.
      // A file with escapes (`\u0073ave`) may name it without its letters; it is read and reported as not settled.
      if (!source || (!names.exported.includes('default') && !source.text.includes('\\u')
        && ![...anyName].some(name => source.text.includes(name)))) continue;
      const facts = factsOf(file, source);
      for (const call of facts.calls) {
        const callee = call.node.childForFieldName('function')!;
        if (isMemberCall(callee)) {
          const property = calledProperty(callee);
          if (property && anyName.has(property)) maybeCallers.push({ ...site(call, facts), reason: 'member', detail: null });
          continue;
        }
        if (callee.type !== 'identifier') continue;
        // Only calls that may reach the chosen function are settled: by its name in its own file, or by a
        // name imported from its file elsewhere. Imports of other files are not read for this.
        let mayReach = file.id === chosenFile.id && names.local.includes(callee.text);
        // Its own file may import it too, under another name (`import { f as other } from './a'` in a.ts).
        if (!mayReach && !call.inNamespace) {
          const found = nearest(call.scope, callee.text);
          const declaration = found?.declared.length === 1 ? found.declared[0] : null;
          if (declaration?.kind === 'import' && names.exported.includes(declaration.imported)) {
            const from = await importedFile(facts, declaration.specifier);
            mayReach = !('kind' in from) && from.id === chosenFile.id;
          }
        }
        if (!mayReach) continue;
        const found = await resolve(call, facts);
        if (isChosen(found)) callers.push(site(call, facts));
        else if (found.kind === 'unknown') maybeCallers.push({ ...site(call, facts), reason: found.reason, detail: found.detail });
      }
    }
  }

  const notes = result.limited ? [`부르는 곳은 파일 ${limits.files}개·합계 ${limits.bytes / 1024 / 1024} MiB까지만 찾아요. 나머지 파일은 보지 않았어요.`] : [];
  return { projectId, fileId: chosenFile.id, fileHash: chosen.hash, startUtf16: fn.startIndex, endUtf16: fn.endIndex, name: functionName(fn),
    calls, callers: searched ? callers : null, maybeCallers, names, unexamined: [...result.unexamined.values()], limited: result.limited, notes };
}
