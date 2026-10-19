import type Parser from 'tree-sitter';
import type { ProjectFile } from '../../shared/contracts';
import { parse } from './project-map';
import { functionTypes, importOf } from './syntax';

/*
 * Names in one file, read from the code only (plan v2.3 F and V-1): which declaration a name means, scope by
 * scope outward, and what is written where it is declared and assigned. Whatever cannot be settled is
 * marked, never guessed: a file with `with`, eval, escaped names or dynamic global keys is `unclear`, and one
 * not walked to the end is not `complete`.
 */

const MAX_TEXT = 300;
/** Line numbers as the analyzer's evidence gives them: a range ending at a line start does not take that line. */
export const lineRange = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1,
  endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)) });
/** A node's first line as written, cut short; ` …` marks more lines. */
export function firstLine(node: Parser.SyntaxNode): string {
  const [first, ...rest] = node.text.split('\n');
  const line = first.replace(/\r$/, '');
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : rest.length ? `${line} …` : line;
}
// A const or let whose value is one of these is a function by that name, as the analyzer lists it.
export const functionValues = new Set(['arrow_function', 'function_expression', 'generator_function']);

/**
 * What V-1 shows about a variable-like name: how it is declared and what is written where it is declared.
 * Nodes are kept so ranges and text can be taken from the file that holds them.
 */
export interface VariableInfo {
  role: 'parameter' | 'const' | 'let' | 'var' | 'for' | 'catch' | 'arguments';
  /** The name as declared; null for the `arguments` every non-arrow function has. */
  node: Parser.SyntaxNode | null;
  /** The function whose parameters or body hold it; null at the top of the file or in a class body. */
  owner: Parser.SyntaxNode | null;
  scope: Scope;
  /** The parameter, declarator or loop it comes from. */
  source: Parser.SyntaxNode | null;
  /** The written type annotation of a plain name. */
  type: Parser.SyntaxNode | null;
  /** The value written where a plain name is declared: its initializer, or a parameter's default. */
  value: Parser.SyntaxNode | null;
  /** A plain name, a rest parameter (`...rest`), or one taken out by destructuring. */
  shape: 'plain' | 'rest' | 'destructured';
  /** A plain parameter's position among the arguments (a TS `this` parameter is not counted). */
  index: number | null;
  /**
   * Why it cannot be told apart from another declaration of its name: a parameter declared again by its
   * function's body (`function f(x) { var x }`), or a catch name declared again with var inside the catch.
   */
  clash: string | null;
}
/** What a name means in the scope that declares it. */
export type Declaration =
  /** A function declaration at the top of a file, function or namespace body, a const/let function, or a function expression's own name. */
  /** A `let` function also keeps its V-1 details: it can be given another value later. */
  | { kind: 'function'; fn: Parser.SyntaxNode; info?: VariableInfo; clash?: string }
  | { kind: 'import'; specifier: string | null; imported: string }
  /** A parameter or any other variable, class, catch or for name, namespace import, `arguments`. */
  /** `at` is where a name without V-1 details (a class, enum, namespace, require) is declared. */
  | { kind: 'variable'; info?: VariableInfo; at?: Parser.SyntaxNode }
  | { kind: 'var'; info?: VariableInfo }
  | { kind: 'block-function'; fn: Parser.SyntaxNode };
export interface Scope { parent: Scope | null; names: Map<string, Declaration[]> }
export interface CallFact {
  node: Parser.SyntaxNode;
  scope: Scope;
  /** The innermost function the analyzer lists that holds the call; null at the top of the file. */
  fn: Parser.SyntaxNode | null;
  inNamespace: boolean;
}
/**
 * An export at the top of a file. `fn` is the exported function, `local` its name inside the file. `snapshot`
 * is the expression of `export default …`, which exports the value it has then, not the name.
 */
export interface ExportFact { fn: Parser.SyntaxNode | null; local: string | null; snapshot?: Parser.SyntaxNode }
/** A write to a name: an assignment, update or `for (x of …)`; `viaGlobal` for `window.x` in a plain script. */
export interface AssignmentFact { name: string; scope: Scope; node: Parser.SyntaxNode; viaGlobal?: boolean; inNamespace?: boolean }
/** A name read or written in code (not where it is declared), kept for the chosen file only. */
export interface ReferenceFact { node: Parser.SyntaxNode; scope: Scope; fn: Parser.SyntaxNode | null; inNamespace: boolean }
export interface FileFacts {
  file: ProjectFile;
  hash: string;
  text: string;
  /** Walked to the end without a syntax error: only then are its declarations and assignments all known. */
  complete: boolean;
  incompleteReason: string | null;
  /** A `with` statement, an `eval(…)` call or a name written with escapes (`\u0066`): names here cannot be settled. */
  unclear: boolean;
  /**
   * `arguments` or `undefined` declared or assigned as a name somewhere. Plan F settles calls around them;
   * V-1 does not work out values in such a file, a rare case not worth reading in detail (user, 2026-10-19).
   */
  oddNames: boolean;
  program: Scope;
  calls: CallFact[];
  assignments: AssignmentFact[];
  /** Every variable-like name with its V-1 details, in source order. */
  variables: VariableInfo[];
  /** Function declarations (`function f`) with the function they are made in, for V-1 when f is given another value. */
  functionDeclarations: { name: string; scope: Scope; owner: Parser.SyntaxNode | null }[];
  references: ReferenceFact[];
  /** The functions the analyzer lists, in source order. */
  functions: Parser.SyntaxNode[];
  exports: Map<string, ExportFact[]>;
  reexported: Set<string>;
  reexportsAll: boolean;
}

export const newScope = (parent: Scope | null): Scope => ({ parent, names: new Map() });
function declare(scope: Scope, name: string, declaration: Declaration): void {
  const list = scope.names.get(name);
  if (list) list.push(declaration); else scope.names.set(name, [declaration]);
}
export const sameRange = (a: Parser.SyntaxNode, b: { startIndex: number; endIndex: number }) =>
  a.startIndex === b.startIndex && a.endIndex === b.endIndex;
// Anonymous tokens such as `type` in `import type` are children without a name.
export const hasToken = (node: Parser.SyntaxNode, token: string) => node.children.some(child => !child.isNamed && child.type === token);

// Wrappers an assignment target may wear without changing which name it writes to: `(f)`, `f!`, `f as T`, `<T>f`.
const targetWrappers = new Set(['parenthesized_expression', 'non_null_expression', 'as_expression', 'satisfies_expression', 'type_assertion']);
// Comments are named children too (`(/* note */ f) = …`), so they are skipped when picking a part.
export const firstCode = (node: Parser.SyntaxNode | null) => node?.namedChildren.find(child => child.type !== 'comment') ?? null;
const lastCode = (node: Parser.SyntaxNode | null) => node?.namedChildren.findLast(child => child.type !== 'comment') ?? null;
/** What a wrapper wraps: in `<T>f` the type comes first, in the others the target does. */
const wrappedPart = (node: Parser.SyntaxNode) => node.type === 'type_assertion' ? lastCode(node) : firstCode(node);
/** A node without the wrappers above: `(eval)` and `eval!` still name eval. */
export function unwrapped(node: Parser.SyntaxNode): Parser.SyntaxNode {
  const inner = targetWrappers.has(node.type) ? wrappedPart(node) : null;
  return inner ? unwrapped(inner) : node;
}
/** A property's name as a member call writes it: `save`, also for `"save"() {}` and `{ 'save': … }`. */
export function propertyName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'string') return node.namedChildren.find(child => child.type === 'string_fragment')?.text ?? '';
  return node.type === 'computed_property_name' ? null : node.text;
}
/** The property a member call names: `obj.save()` and `obj['save']()`; null when it is computed. */
export function calledProperty(callee: Parser.SyntaxNode): string | null {
  if (callee.type === 'member_expression') return propertyName(callee.childForFieldName('property'));
  const index = callee.type === 'subscript_expression' ? callee.childForFieldName('index') : null;
  return index?.type === 'string' ? propertyName(index) : null;
}
const globalObjects = new Set(['window', 'globalThis', 'self', 'global']);
const codeRunners = new Set(['eval', 'Function']);
export const isMemberCall = (callee: Parser.SyntaxNode) => callee.type === 'member_expression' || callee.type === 'subscript_expression';

// `undefined` can be declared as a name (`function f(undefined) {}`); the grammar gives it a node type of its own.
const isName = (node: Parser.SyntaxNode | null | undefined) => node?.type === 'identifier' || node?.type === 'undefined';
/**
 * The names a declaration, destructuring pattern or assignment target binds or writes to (`f`, `[f!]`,
 * `({ x: f } = …)`); property keys, default values and member targets (`obj.f = …`) are not names.
 */
function bindingNodes(node: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  if (!node) return [];
  if (targetWrappers.has(node.type)) return bindingNodes(wrappedPart(node));
  switch (node.type) {
    case 'identifier': case 'undefined': case 'shorthand_property_identifier_pattern': return [node];
    case 'required_parameter': case 'optional_parameter': return bindingNodes(node.childForFieldName('pattern'));
    case 'assignment_pattern': case 'object_assignment_pattern': return bindingNodes(node.childForFieldName('left'));
    case 'pair_pattern': return bindingNodes(node.childForFieldName('value'));
    case 'rest_pattern': return bindingNodes(firstCode(node));
    case 'array_pattern': case 'object_pattern': return node.namedChildren.flatMap(bindingNodes);
    default: return [];
  }
}
const bindingNames = (node: Parser.SyntaxNode | null) => bindingNodes(node).map(bound => bound.text);

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
  /** The parameters scope of the function whose body block comes next. */
  parameters?: Scope;
}

/**
 * Scopes, declarations, assignments, calls, listed functions and exports of one file, from one walk with a
 * tree cursor (moving by sibling or parent searches from the root and gets slow in deeply nested code).
 */
export function readFacts(file: ProjectFile, text: string, hash: string, nodeBudget: number, withReferences = false): FileFacts {
  const root = parse(text, file.relativePath);
  const program = newScope(null);
  const facts: FileFacts = { file, hash, text, complete: !root.hasError, incompleteReason: root.hasError ? '구문 오류가 있어 이 파일의 이름은 확정하지 않았어요.' : null,
    unclear: false, oddNames: false, program, calls: [], assignments: [], variables: [], functionDeclarations: [], references: [], functions: [], exports: new Map(), reexported: new Set(),
    reexportsAll: false };
  const pendingExports: { exported: string; local: string; snapshot?: Parser.SyntaxNode }[] = [];
  // Function bodies with their parameters, to find a parameter declared again in the body.
  const bodies: { parameters: Scope; body: Scope }[] = [];
  const variable = (scope: Scope, name: string, declarationKind: 'variable' | 'var', info: Omit<VariableInfo, 'scope' | 'clash'>) => {
    const full: VariableInfo = { ...info, scope, clash: null };
    if (info.node) declaredNames.add(info.node.startIndex);
    // The `arguments` every non-arrow function has is not one written in the code.
    if (info.node && oddNames.has(name)) facts.oddNames = true;
    facts.variables.push(full);
    declare(scope, name, { kind: declarationKind, info: full });
    return full;
  };
  // `catch (x) { var x = 2 }` or `catch (x) { for (var x of xs) {} }`: the var reaches the function, but its
  // value goes to the catch's x. Both are marked, as neither can be told apart from the other.
  const catchClash = (frame: Frame, name: string, info: VariableInfo) => {
    for (let scope: Scope | null = frame.scope; scope && scope !== frame.varScope; scope = scope.parent) {
      const caught = scope.names.get(name)?.flatMap(item => item.kind === 'variable' && item.info?.role === 'catch' ? [item.info] : []) ?? [];
      if (!caught.length) continue;
      const clash = 'catch로 받는 이름과 같은 이름을 var로 다시 선언했어요.';
      info.clash = clash;
      for (const other of caught) other.clash = clash;
    }
  };
  const oddNames = new Set(['arguments', 'undefined']);
  const declareHere = (scope: Scope, name: string, declaration: Declaration) => {
    if (oddNames.has(name)) facts.oddNames = true;
    declare(scope, name, declaration);
  };
  // Lower-case JSX tags (`<div>`) are elements, not names in the code; nor is a name where it is declared.
  const intrinsicTags = new Set<number>();
  const declaredNames = new Set<number>();
  // Escapes in names are written `\u…`; most files have none, so names are only looked at when one might.
  const mayEscape = text.includes('\\u');
  const addExport = (exported: string, entry: ExportFact) => {
    const list = facts.exports.get(exported);
    if (list) list.push(entry); else facts.exports.set(exported, [entry]);
  };

  // What a node means for names, and the frame its children are in; null skips its children.
  const enter = (cursor: Parser.TreeCursor, frame: Frame): Frame | null => {
    const type = cursor.nodeType;
    // This grammar reads `using x = …` as an assignment, so a `using` declaration's name would be lost.
    if (!cursor.nodeIsNamed && type === 'using') facts.unclear = true;
    if (!cursor.nodeIsNamed || type === 'ERROR' || cursor.nodeIsMissing || type === 'comment') return null;
    // A name written with escapes (`\u0066`, also a class's) is the same name as `f`, which is not worked out here.
    // Every kind of name has `identifier` in its type (`shorthand_property_identifier_pattern` too).
    if (mayEscape && type.includes('identifier') && cursor.nodeText.includes('\\')) facts.unclear = true;
    // Any mention of eval or Function, called directly or not (`(0, eval)(…)`, `const e = eval`), can run text
    // that declares or replaces names, so the file's names are not settled.
    // Any kind of name counts (`{ eval }` too), except a type name such as `cb: Function`, which does not run.
    if (type.includes('identifier') && type !== 'type_identifier' && codeRunners.has(cursor.nodeText)) facts.unclear = true;
    if ((type === 'computed_property_name' || type === 'decorator') && frame.outside?.starts.has(cursor.startIndex)) return frame.outside.frame;
    // Any TS type (`function_type`, `object_type`, `union_type`, …) holds no code that runs.
    if (type.endsWith('_type')) return null;
    if (functionTypes.has(type)) {
      const node = cursor.currentNode;
      const body = node.childForFieldName('body');
      const listed = !frame.broken && !node.hasError && !!body;
      if (listed) facts.functions.push(node);
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text;
      if (nameNode) declaredNames.add(nameNode.startIndex);
      if (name && (type === 'function_declaration' || type === 'generator_function_declaration')) {
        if (frame.scope === frame.varScope && frame.inList) {
          declareHere(frame.scope, name, { kind: 'function', fn: node });
          facts.functionDeclarations.push({ name, scope: frame.scope, owner: frame.fn });
        }
        else {
          // Outside strict mode a block's function (or `if (x) function f() {}`) also reaches the enclosing
        // function, like a `var`.
          declareHere(frame.scope, name, { kind: 'block-function', fn: node });
          if (frame.varScope !== frame.scope) declareHere(frame.varScope, name, { kind: 'block-function', fn: node });
        }
      }
      // A function expression's own name sits outside its parameters: `function f(f) { f() }` calls the parameter.
      let outer = frame.scope;
      if (name && (type === 'function_expression' || type === 'generator_function')) {
        outer = newScope(outer);
        declareHere(outer, name, { kind: 'function', fn: node });
      }
      // Parameters get a scope of their own: a default value cannot see declarations in the body.
      const parameters = newScope(outer);
      const plainInfo = { source: null, type: null, value: null, shape: 'plain' as const, index: null };
      const list = node.childForFieldName('parameters');
      const single = node.childForFieldName('parameter');
      let position = 0;
      for (const parameter of list ? list.namedChildren.filter(child => child.type !== 'comment') : single ? [single] : []) {
        const typed = parameter.type === 'required_parameter' || parameter.type === 'optional_parameter';
        const pattern = typed ? parameter.childForFieldName('pattern') : parameter;
        // A TS `this` parameter only types `this`; it takes no argument.
        if (pattern?.type === 'this') continue;
        const target = pattern?.type === 'assignment_pattern' ? pattern.childForFieldName('left') : pattern;
        const fallback = pattern?.type === 'assignment_pattern' ? pattern.childForFieldName('right') : typed ? parameter.childForFieldName('value') : null;
        const shape = isName(target) ? 'plain' : target?.type === 'rest_pattern' ? 'rest' : 'destructured';
        for (const bound of bindingNodes(parameter)) {
          variable(parameters, bound.text, 'variable', { role: 'parameter', node: bound, owner: node, source: parameter, shape,
            type: shape !== 'destructured' ? firstCode(parameter.childForFieldName('type')) : null, value: shape === 'plain' ? fallback : null,
            index: shape === 'plain' ? position : null });
        }
        position++;
      }
      // Every non-arrow function has its own `arguments`, unless a parameter takes that name.
      if (type !== 'arrow_function' && !parameters.names.has('arguments')) {
        variable(parameters, 'arguments', 'variable', { ...plainInfo, role: 'arguments', node: null, owner: node });
      }
      const key = type === 'method_definition' ? node.childForFieldName('name') : null;
      const outsideStarts = new Set(list?.namedChildren.flatMap(parameter => parameter.namedChildren)
        .filter(child => child.type === 'decorator').map(child => child.startIndex));
      if (key?.type === 'computed_property_name') outsideStarts.add(key.startIndex);
      // A class method's are already placed by its class body (they run where the class is defined).
      const placed = frame.outside && [...outsideStarts].some(start => frame.outside!.starts.has(start));
      return { scope: parameters, varScope: parameters, fn: listed ? node : frame.fn, broken: frame.broken || node.hasError,
        inNamespace: frame.inNamespace, bodyStart: body?.type === 'statement_block' ? body.startIndex : -1, bodyIsNamespace: false, inList: true,
        outside: outsideStarts.size ? { starts: outsideStarts, frame: placed ? frame.outside!.frame : frame } : undefined,
        // Only a block body can declare a parameter's name again; an arrow's expression body cannot.
        parameters: body?.type === 'statement_block' ? parameters : undefined };
    }
    switch (type) {
      case 'statement_block': {
        const scope = newScope(frame.scope);
        if (cursor.startIndex !== frame.bodyStart) return { ...frame, scope, bodyStart: -1, inList: true, parameters: undefined };
        if (frame.parameters) bodies.push({ parameters: frame.parameters, body: scope });
        return { ...frame, scope, varScope: scope, inNamespace: frame.inNamespace || frame.bodyIsNamespace, bodyStart: -1, bodyIsNamespace: false,
          inList: true, parameters: undefined };
      }
      // Statements that hold a single statement rather than a list.
      case 'if_statement': case 'else_clause': case 'while_statement': case 'do_statement': case 'labeled_statement':
        return { ...frame, inList: false };
      case 'class_declaration': case 'abstract_class_declaration': case 'class': {
        const node = cursor.currentNode;
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text;
        if (!nameNode || !name) return frame;
        declaredNames.add(nameNode.startIndex);
        if (type !== 'class') declareHere(frame.scope, name, { kind: 'variable', at: nameNode });
        // The class's own name covers its `extends` expression and body; its decorators run outside.
        const scope = newScope(frame.scope);
        declareHere(scope, name, { kind: 'variable', at: nameNode });
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
        const left = node.childForFieldName('left');
        const loopInfo = { role: 'for' as const, owner: frame.fn, source: node, type: null, value: null, index: null,
          shape: isName(left) ? 'plain' as const : 'destructured' as const };
        if (kind === 'var') for (const bound of bindingNodes(left)) catchClash(frame, bound.text, variable(frame.varScope, bound.text, 'var', { ...loopInfo, node: bound }));
        else if (kind) for (const bound of bindingNodes(left)) variable(scope, bound.text, 'variable', { ...loopInfo, node: bound });
        else for (const name of bindingNames(left)) facts.assignments.push({ name, scope: frame.scope, node, inNamespace: frame.inNamespace });
        return { ...frame, scope, bodyStart: -1, inList: false };
      }
      case 'catch_clause': {
        const scope = newScope(frame.scope);
        const clause = cursor.currentNode;
        const parameter = clause.childForFieldName('parameter');
        const plain = isName(parameter);
        for (const bound of bindingNodes(parameter)) {
          variable(scope, bound.text, 'variable', { role: 'catch', node: bound, owner: frame.fn, source: parameter, value: null, index: null,
            type: plain ? firstCode(clause.childForFieldName('type')) : null, shape: plain ? 'plain' : 'destructured' });
        }
        return { ...frame, scope, bodyStart: -1 };
      }
      case 'lexical_declaration': case 'variable_declaration': {
        const node = cursor.currentNode;
        const role = type === 'variable_declaration' ? 'var' : hasToken(node, 'const') ? 'const' : 'let';
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name');
          const value = declarator.childForFieldName('value');
          if (role !== 'var' && name && isName(name) && value && functionValues.has(value.type)) {
            const info: VariableInfo | undefined = role === 'let' ? { role, node: name, owner: frame.fn, scope: frame.scope, source: declarator,
              type: firstCode(declarator.childForFieldName('type')), value, shape: 'plain', index: null, clash: null } : undefined;
            if (info) facts.variables.push(info);
            declareHere(frame.scope, name.text, { kind: 'function', fn: value, info });
            continue;
          }
          const plain = isName(name);
          for (const bound of bindingNodes(name)) {
            const info = variable(role === 'var' ? frame.varScope : frame.scope, bound.text, role === 'var' ? 'var' : 'variable', { role, node: bound,
              owner: frame.fn, source: declarator, type: plain ? firstCode(declarator.childForFieldName('type')) : null,
              value: plain ? value : null, shape: plain ? 'plain' : 'destructured', index: null });
            if (role === 'var') catchClash(frame, bound.text, info);
          }
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
            const name = part.namedChildren.find(child => child.type === 'identifier');
            if (name) declareHere(frame.scope, name.text, { kind: 'variable', at: name });
          }
          if (part.type !== 'import_clause') continue;
          for (const imported of part.namedChildren) {
            if (imported.type === 'identifier') declareHere(frame.scope, imported.text, { kind: 'import', specifier, imported: 'default' });
            // `* as ns` brings the whole file as one object, written `*` here.
            if (imported.type === 'namespace_import') {
              const name = firstCode(imported)?.text;
              if (name) declareHere(frame.scope, name, { kind: 'import', specifier, imported: '*' });
            }
            if (imported.type !== 'named_imports') continue;
            for (const item of imported.namedChildren) {
              const name = item.childForFieldName('name')?.text;
              if (item.type !== 'import_specifier' || !name || hasToken(item, 'type')) continue;
              declareHere(frame.scope, item.childForFieldName('alias')?.text ?? name, { kind: 'import', specifier, imported: name });
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
            if (name && isName(name) && init && functionValues.has(init.type)) addExport(name.text, { fn: init, local: name.text });
            else for (const bound of bindingNames(name)) addExport(bound, { fn: null, local: bound });
          }
        } else if (declaration && declaration.type !== 'function_signature' && declaration.type !== 'ambient_declaration') {
          // An overload or ambient signature is not a separate export.
          for (const bound of declaration.type === 'variable_declaration'
            ? declaration.namedChildren.flatMap(declarator => bindingNames(declarator.childForFieldName('name')))
            : [declaration.childForFieldName('name')?.text ?? '']) addExport(isDefault ? 'default' : bound, { fn: null, local: bound });
        }
        if (value) {
          // `export default save;` exports what save is then. For a function that is the function, as
          // `export { save as default }` would; for a value it is a snapshot, not the name.
          if (isName(value)) pendingExports.push({ exported: 'default', local: value.text, snapshot: value });
          else addExport('default', functionValues.has(value.type)
            // A function expression's own name is not a name of the file, so it has no local name here.
            ? { fn: value, local: null } : { fn: null, local: null, snapshot: value });
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
        const node = cursor.currentNode;
        for (const name of bindingNames(node.childForFieldName('left'))) facts.assignments.push({ name, scope: frame.scope, node, inNamespace: frame.inNamespace });
        return frame;
      }
      case 'update_expression': {
        const node = cursor.currentNode;
        for (const name of bindingNames(node.childForFieldName('argument'))) facts.assignments.push({ name, scope: frame.scope, node, inNamespace: frame.inNamespace });
        return frame;
      }
      case 'with_statement': facts.unclear = true; return { ...frame, inList: false };
      // A class's static block is a body of its own: its `var`s stay inside it.
      case 'class_static_block': {
        const body = cursor.currentNode.childForFieldName('body');
        // Its body is not a function's: a parameter around it is not declared again by a var inside it.
        return { ...frame, bodyStart: body ? body.startIndex : -1, bodyIsNamespace: false, parameters: undefined };
      }
      case 'internal_module': case 'module': {
        const node = cursor.currentNode;
        const name = node.childForFieldName('name');
        if (name?.type === 'identifier') declareHere(frame.scope, name.text, { kind: 'variable', at: name });
        const body = node.childForFieldName('body');
        return { ...frame, bodyStart: body ? body.startIndex : -1, bodyIsNamespace: true, parameters: undefined };
      }
      // TS `import f = N.f` declares f as a value that is not followed here.
      case 'import_alias': {
        const name = firstCode(cursor.currentNode);
        if (name?.type === 'identifier') declareHere(frame.scope, name.text, { kind: 'variable', at: name });
        return frame;
      }
      case 'enum_declaration': {
        const name = cursor.currentNode.childForFieldName('name');
        if (name) declareHere(frame.scope, name.text, { kind: 'variable', at: name });
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
        if (property) facts.assignments.push({ name: property, scope: program, node, viaGlobal: true });
        return frame;
      }
      // An overload or ambient signature has no body and declares nothing that runs.
      case 'function_signature': return null;
      // Types do not run: names inside them (`cb: (x: number) => number`, `v as (x: number) => number`) are
      // not uses of variables. Type nodes other than these containers all end in `_type`; see the check above.
      case 'type_annotation': case 'type_arguments': case 'type_parameters': case 'type_alias_declaration': case 'interface_declaration':
      case 'implements_clause': case 'type_query': case 'type_predicate_annotation': case 'asserts_annotation':
        return null;
      // `xmlns:xlink` in a JSX tag or attribute name is one name of the element, not two variables.
      case 'jsx_namespace_name': return null;
      case 'jsx_opening_element': case 'jsx_closing_element': case 'jsx_self_closing_element': {
        const name = cursor.currentNode.childForFieldName('name');
        if (name?.type === 'identifier' && /^[a-z]/.test(name.text)) intrinsicTags.add(name.startIndex);
        return frame;
      }
      // `({ x } = obj)` writes x through a shorthand pattern, so that is a use of x too.
      case 'identifier': case 'undefined': case 'shorthand_property_identifier': case 'shorthand_property_identifier_pattern':
        if (withReferences && !intrinsicTags.has(cursor.startIndex) && !declaredNames.has(cursor.startIndex)) {
          facts.references.push({ node: cursor.currentNode, scope: frame.scope, fn: frame.fn, inNamespace: frame.inNamespace });
        }
        return null;
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

  if (facts.assignments.some(write => !write.viaGlobal && oddNames.has(write.name))) facts.oddNames = true;
  for (const { exported, local, snapshot } of pendingExports) {
    const declared = program.names.get(local);
    const only = declared?.length === 1 ? declared[0] : null;
    addExport(exported, { fn: only?.kind === 'function' ? only.fn : null, local, ...(snapshot ? { snapshot } : {}) });
  }
  // A parameter declared again in its function's body is the same variable (`var x`) or replaced by it
  // (`function x() {}`), so neither can be told apart from the other.
  for (const { parameters, body } of bodies) {
    for (const [name, declared] of body.names) {
      const parameter = parameters.names.get(name)?.flatMap(item => item.kind === 'variable' && item.info?.role === 'parameter' ? [item.info] : []) ?? [];
      if (!parameter.length) continue;
      const clash = '매개변수와 같은 이름을 본문에서 다시 선언했어요.';
      for (const info of parameter) info.clash = clash;
      for (const item of declared) {
        if ((item.kind === 'variable' || item.kind === 'var' || item.kind === 'function') && item.info) item.info.clash = clash;
        if (item.kind === 'function') item.clash = clash;
      }
    }
  }
  return facts;
}

/** Whether the name is written to anywhere inside the scope, inner scopes included. */
export function reassigned(facts: FileFacts, name: string, scope: Scope): boolean {
  return facts.assignments.some(assignment => {
    if (assignment.name !== name) return false;
    for (let inner: Scope | null = assignment.scope; inner; inner = inner.parent) if (inner === scope) return true;
    return false;
  });
}

/** The nearest declarations of a name, scope by scope outward. */
export function nearest(scope: Scope, name: string): { declared: Declaration[]; scope: Scope } | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const declared = current.names.get(name);
    if (declared) return { declared, scope: current };
  }
  return null;
}
