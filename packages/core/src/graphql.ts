/**
 * A GraphQL query parser.
 *
 * Why hand-written, when `graphql-js` exists and is excellent: projections need only its
 * executor-free front half, and `graphql-js` is a megabyte of code. What is here is the
 * query language only — no type system definition parsing, no mutations, no subscriptions —
 * which is a few hundred lines and can be read in one sitting.
 *
 * What IS supported, because projections need it:
 *   - anonymous and named `query` operations, with variables and defaults
 *   - aliases, arguments, nested selection sets
 *   - named fragments, inline fragments, and type conditions
 *   - directives with arguments, on fields and fragment spreads
 *   - all literal kinds, including block strings and objects
 *
 * Errors carry a line and column and a hint, because a projection is a thing users write
 * by hand in a config file, and "Unexpected token" with no position is how a config
 * language earns a reputation.
 */

import { VfsError } from './errors.js';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type GqlValue =
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly GqlValue[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, GqlValue> }
  | { readonly kind: 'variable'; readonly name: string };

export interface GqlArgument {
  readonly name: string;
  readonly value: GqlValue;
}

export interface GqlDirective {
  readonly name: string;
  readonly args: readonly GqlArgument[];
}

export interface GqlField {
  readonly kind: 'field';
  readonly alias?: string;
  readonly name: string;
  readonly args: readonly GqlArgument[];
  readonly directives: readonly GqlDirective[];
  readonly selections: readonly GqlSelection[];
  readonly line: number;
}

export interface GqlFragmentSpread {
  readonly kind: 'spread';
  readonly name: string;
  readonly directives: readonly GqlDirective[];
  readonly line: number;
}

export interface GqlInlineFragment {
  readonly kind: 'inline';
  readonly typeCondition?: string;
  readonly directives: readonly GqlDirective[];
  readonly selections: readonly GqlSelection[];
  readonly line: number;
}

export type GqlSelection = GqlField | GqlFragmentSpread | GqlInlineFragment;

export interface GqlTypeRef {
  readonly kind: 'named' | 'list' | 'nonNull';
  readonly name?: string;
  readonly of?: GqlTypeRef;
}

export interface GqlVariableDef {
  readonly name: string;
  readonly type: GqlTypeRef;
  readonly defaultValue?: GqlValue;
}

export interface GqlOperation {
  readonly operation: 'query';
  readonly name?: string;
  readonly variables: readonly GqlVariableDef[];
  readonly directives: readonly GqlDirective[];
  readonly selections: readonly GqlSelection[];
}

export interface GqlFragment {
  readonly name: string;
  readonly typeCondition: string;
  readonly directives: readonly GqlDirective[];
  readonly selections: readonly GqlSelection[];
}

export interface GqlDocument {
  readonly operations: readonly GqlOperation[];
  readonly fragments: ReadonlyMap<string, GqlFragment>;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | 'punct'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

const PUNCTUATORS = ['...', '!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|'];

function isNameStart(char: string): boolean {
  return /[_A-Za-z]/.test(char);
}

function isNameChar(char: string): boolean {
  return /[_0-9A-Za-z]/.test(char);
}

export function tokenizeGraphQL(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const fail = (message: string, hint?: string): never => {
    throw graphqlError(message, line, i - lineStart + 1, hint);
  };

  while (i < input.length) {
    const char = input[i] as string;

    if (char === '\n') {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    // Commas are insignificant in GraphQL, like whitespace. Honouring that matters here
    // because projections are written by people copying examples, and a stray comma
    // rejected as a syntax error would be baffling.
    if (char === ' ' || char === '\t' || char === '\r' || char === ',' || char === '\uFEFF') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }

    const column = i - lineStart + 1;

    if (input.startsWith('"""', i)) {
      const end = input.indexOf('"""', i + 3);
      if (end === -1) fail('This block string is never closed.', 'Block strings end with """.');
      const raw = input.slice(i + 3, end);
      for (const c of raw) if (c === '\n') line += 1;
      tokens.push({ kind: 'string', value: dedentBlockString(raw), line, column });
      i = end + 3;
      continue;
    }

    if (char === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const c = input[i] as string;
        if (c === '\n') fail('This string is never closed.', 'Strings cannot span lines; use """ for that.');
        if (c === '\\') {
          const escape = input[i + 1];
          switch (escape) {
            case '"': value += '"'; break;
            case '\\': value += '\\'; break;
            case '/': value += '/'; break;
            case 'b': value += '\b'; break;
            case 'f': value += '\f'; break;
            case 'n': value += '\n'; break;
            case 'r': value += '\r'; break;
            case 't': value += '\t'; break;
            case 'u': {
              const hex = input.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(`"\\u${hex}" is not a valid escape.`);
              value += String.fromCharCode(Number.parseInt(hex, 16));
              i += 4;
              break;
            }
            default:
              fail(`"\\${String(escape)}" is not a valid escape.`);
          }
          i += 2;
          continue;
        }
        value += c;
        i += 1;
      }
      if (i >= input.length) fail('This string is never closed.');
      i += 1;
      tokens.push({ kind: 'string', value, line, column });
      continue;
    }

    if (char === '-' || /[0-9]/.test(char)) {
      const start = i;
      if (input[i] === '-') i += 1;
      while (i < input.length && /[0-9]/.test(input[i] as string)) i += 1;
      let isFloat = false;
      if (input[i] === '.') {
        isFloat = true;
        i += 1;
        while (i < input.length && /[0-9]/.test(input[i] as string)) i += 1;
      }
      if (input[i] === 'e' || input[i] === 'E') {
        isFloat = true;
        i += 1;
        if (input[i] === '+' || input[i] === '-') i += 1;
        while (i < input.length && /[0-9]/.test(input[i] as string)) i += 1;
      }
      const text = input.slice(start, i);
      if (!/^-?[0-9]/.test(text) || text === '-') fail(`"${text}" is not a number.`);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text, line, column });
      continue;
    }

    if (isNameStart(char)) {
      const start = i;
      while (i < input.length && isNameChar(input[i] as string)) i += 1;
      tokens.push({ kind: 'name', value: input.slice(start, i), line, column });
      continue;
    }

    const punct = PUNCTUATORS.find((p) => input.startsWith(p, i));
    if (punct !== undefined) {
      tokens.push({ kind: 'punct', value: punct, line, column });
      i += punct.length;
      continue;
    }

    fail(`"${char}" cannot appear here.`);
  }

  tokens.push({ kind: 'eof', value: '', line, column: i - lineStart + 1 });
  return tokens;
}

/** GraphQL's block-string dedent: strip common indentation and blank leading/trailing lines. */
function dedentBlockString(raw: string): string {
  const lines = raw.split('\n');
  let common = Infinity;
  for (const line of lines.slice(1)) {
    const indent = line.length - line.trimStart().length;
    if (indent < line.length) common = Math.min(common, indent);
  }
  const dedented = lines.map((line, index) =>
    index === 0 || common === Infinity ? line : line.slice(common),
  );
  while (dedented.length > 0 && (dedented[0] as string).trim() === '') dedented.shift();
  while (dedented.length > 0 && (dedented[dedented.length - 1] as string).trim() === '') dedented.pop();
  return dedented.join('\n');
}

function graphqlError(message: string, line: number, column: number, hint?: string): VfsError {
  return VfsError.invalid(
    `${message} (line ${line}, column ${column})`,
    hint ?? 'Run `schema` to see the fields and arguments a projection can use.',
  );
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  get #current(): Token {
    return this.#tokens[this.#index] as Token;
  }

  #fail(message: string, hint?: string): never {
    const token = this.#current;
    throw graphqlError(message, token.line, token.column, hint);
  }

  #at(kind: TokenKind, value?: string): boolean {
    const token = this.#current;
    return token.kind === kind && (value === undefined || token.value === value);
  }

  #take(kind: TokenKind, value?: string): Token {
    if (!this.#at(kind, value)) {
      const found = this.#current.kind === 'eof' ? 'the end of the query' : `"${this.#current.value}"`;
      this.#fail(`Expected ${value === undefined ? kind : `"${value}"`}, found ${found}.`);
    }
    const token = this.#current;
    this.#index += 1;
    return token;
  }

  #accept(kind: TokenKind, value?: string): boolean {
    if (!this.#at(kind, value)) return false;
    this.#index += 1;
    return true;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();

    while (!this.#at('eof')) {
      if (this.#at('punct', '{')) {
        operations.push({
          operation: 'query',
          variables: [],
          directives: [],
          selections: this.#parseSelectionSet(),
        });
        continue;
      }

      if (this.#at('name', 'query')) {
        this.#index += 1;
        operations.push(this.#parseOperationRest());
        continue;
      }

      if (this.#at('name', 'mutation') || this.#at('name', 'subscription')) {
        this.#fail(
          `A projection cannot contain a ${this.#current.value}.`,
          'Projections are read-only views. Use `do` to act on an item.',
        );
      }

      if (this.#at('name', 'fragment')) {
        this.#index += 1;
        const name = this.#take('name').value;
        if (!this.#accept('name', 'on')) this.#fail('A fragment needs a type condition, as in `fragment F on Entry`.');
        const typeCondition = this.#take('name').value;
        const directives = this.#parseDirectives();
        const selections = this.#parseSelectionSet();
        if (fragments.has(name)) this.#fail(`There are two fragments called "${name}".`);
        fragments.set(name, { name, typeCondition, directives, selections });
        continue;
      }

      this.#fail(
        `"${this.#current.value}" cannot start a projection.`,
        'A projection is a GraphQL query: start with `{` or with `query`.',
      );
    }

    if (operations.length === 0) {
      throw VfsError.invalid(
        'This projection contains no query.',
        'A projection needs at least one `{ ... }` selection describing the tree you want.',
      );
    }
    return { operations, fragments };
  }

  #parseOperationRest(): GqlOperation {
    const name = this.#at('name') ? this.#take('name').value : undefined;
    const variables = this.#at('punct', '(') ? this.#parseVariableDefinitions() : [];
    const directives = this.#parseDirectives();
    const selections = this.#parseSelectionSet();
    return {
      operation: 'query',
      ...(name === undefined ? {} : { name }),
      variables,
      directives,
      selections,
    };
  }

  #parseVariableDefinitions(): readonly GqlVariableDef[] {
    this.#take('punct', '(');
    const defs: GqlVariableDef[] = [];
    while (!this.#accept('punct', ')')) {
      this.#take('punct', '$');
      const name = this.#take('name').value;
      this.#take('punct', ':');
      const type = this.#parseTypeRef();
      const defaultValue = this.#accept('punct', '=') ? this.#parseValue() : undefined;
      defs.push({ name, type, ...(defaultValue === undefined ? {} : { defaultValue }) });
    }
    return defs;
  }

  #parseTypeRef(): GqlTypeRef {
    let type: GqlTypeRef;
    if (this.#accept('punct', '[')) {
      const inner = this.#parseTypeRef();
      this.#take('punct', ']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.#take('name').value };
    }
    if (this.#accept('punct', '!')) return { kind: 'nonNull', of: type };
    return type;
  }

  #parseSelectionSet(): readonly GqlSelection[] {
    this.#take('punct', '{');
    const selections: GqlSelection[] = [];
    while (!this.#accept('punct', '}')) {
      if (this.#at('eof')) this.#fail('This selection is never closed.', 'Every `{` needs a matching `}`.');
      selections.push(this.#parseSelection());
    }
    if (selections.length === 0) {
      this.#fail('An empty `{}` selects nothing.', 'List the fields you want inside the braces.');
    }
    return selections;
  }

  #parseSelection(): GqlSelection {
    const line = this.#current.line;

    if (this.#accept('punct', '...')) {
      if (this.#at('name') && this.#current.value !== 'on') {
        const name = this.#take('name').value;
        return { kind: 'spread', name, directives: this.#parseDirectives(), line };
      }
      const typeCondition = this.#accept('name', 'on') ? this.#take('name').value : undefined;
      const directives = this.#parseDirectives();
      return {
        kind: 'inline',
        ...(typeCondition === undefined ? {} : { typeCondition }),
        directives,
        selections: this.#parseSelectionSet(),
        line,
      };
    }

    let name = this.#take('name').value;
    let alias: string | undefined;
    if (this.#accept('punct', ':')) {
      alias = name;
      name = this.#take('name').value;
    }

    const args = this.#at('punct', '(') ? this.#parseArguments() : [];
    const directives = this.#parseDirectives();
    const selections = this.#at('punct', '{') ? this.#parseSelectionSet() : [];

    return {
      kind: 'field',
      ...(alias === undefined ? {} : { alias }),
      name,
      args,
      directives,
      selections,
      line,
    };
  }

  #parseArguments(): readonly GqlArgument[] {
    this.#take('punct', '(');
    const args: GqlArgument[] = [];
    while (!this.#accept('punct', ')')) {
      if (this.#at('eof')) this.#fail('This argument list is never closed.');
      const name = this.#take('name').value;
      this.#take('punct', ':');
      args.push({ name, value: this.#parseValue() });
    }
    return args;
  }

  #parseDirectives(): readonly GqlDirective[] {
    const directives: GqlDirective[] = [];
    while (this.#accept('punct', '@')) {
      const name = this.#take('name').value;
      directives.push({ name, args: this.#at('punct', '(') ? this.#parseArguments() : [] });
    }
    return directives;
  }

  #parseValue(): GqlValue {
    const token = this.#current;

    if (this.#accept('punct', '$')) {
      return { kind: 'variable', name: this.#take('name').value };
    }
    if (token.kind === 'int') {
      this.#index += 1;
      return { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'float') {
      this.#index += 1;
      return { kind: 'float', value: Number.parseFloat(token.value) };
    }
    if (token.kind === 'string') {
      this.#index += 1;
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.#index += 1;
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (this.#accept('punct', '[')) {
      const values: GqlValue[] = [];
      while (!this.#accept('punct', ']')) {
        if (this.#at('eof')) this.#fail('This list is never closed.');
        values.push(this.#parseValue());
      }
      return { kind: 'list', values };
    }
    if (this.#accept('punct', '{')) {
      const fields = new Map<string, GqlValue>();
      while (!this.#accept('punct', '}')) {
        if (this.#at('eof')) this.#fail('This object is never closed.');
        const name = this.#take('name').value;
        this.#take('punct', ':');
        fields.set(name, this.#parseValue());
      }
      return { kind: 'object', fields };
    }

    this.#fail(`"${token.value}" is not a value.`);
  }
}

export function parseGraphQL(source: string): GqlDocument {
  return new Parser(tokenizeGraphQL(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type GqlRuntimeValue =
  | string
  | number
  | boolean
  | null
  | readonly GqlRuntimeValue[]
  | { readonly [key: string]: GqlRuntimeValue };

/** Resolve a literal against the operation's variables. */
export function valueOf(
  value: GqlValue,
  variables: Readonly<Record<string, GqlRuntimeValue>> = {},
): GqlRuntimeValue {
  switch (value.kind) {
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, GqlRuntimeValue> = {};
      for (const [key, entry] of value.fields) out[key] = valueOf(entry, variables);
      return out;
    }
    case 'variable': {
      const provided = variables[value.name];
      if (provided === undefined) {
        throw VfsError.invalid(
          `The projection uses $${value.name}, which was not supplied.`,
          'Pass it with --var name=value, or give the variable a default in the query.',
        );
      }
      return provided;
    }
    default:
      return null;
  }
}

/** Arguments of a field or directive, as plain values. */
export function argsOf(
  args: readonly GqlArgument[],
  variables: Readonly<Record<string, GqlRuntimeValue>> = {},
): Record<string, GqlRuntimeValue> {
  const out: Record<string, GqlRuntimeValue> = {};
  for (const arg of args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

export function findDirective(
  directives: readonly GqlDirective[],
  name: string,
): GqlDirective | undefined {
  return directives.find((directive) => directive.name === name);
}

/** The name a field appears under in the result — its alias when it has one. */
export function responseName(field: GqlField): string {
  return field.alias ?? field.name;
}

/**
 * Resolve variable values for an operation, applying defaults.
 *
 * Unsupplied variables without a default are left absent rather than defaulted to null,
 * so using one produces a precise error naming the variable instead of a silent empty
 * result. A projection that quietly returns nothing is indistinguishable from a mailbox
 * with nothing in it, and that is the failure this codebase treats as the worst kind.
 */
export function resolveVariables(
  operation: GqlOperation,
  supplied: Readonly<Record<string, GqlRuntimeValue>>,
): Record<string, GqlRuntimeValue> {
  const out: Record<string, GqlRuntimeValue> = {};
  for (const definition of operation.variables) {
    const value = supplied[definition.name];
    if (value !== undefined) {
      out[definition.name] = value;
    } else if (definition.defaultValue !== undefined) {
      out[definition.name] = valueOf(definition.defaultValue, out);
    }
  }
  for (const [key, value] of Object.entries(supplied)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}
