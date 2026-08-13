/**
 * A small, tolerant XML reader.
 *
 * Yes, this is a hand-written XML parser, and no, that is not normally a good idea. It is
 * here because feed parsing is the only place XML appears, the input is a well-defined
 * subset (RSS, RDF, Atom), and the parser only has to be good enough to pull text out of
 * elements.
 *
 * Tolerance over correctness is deliberate. Feeds in the wild are frequently malformed —
 * unescaped ampersands, stray `<` in titles, mismatched close tags. A strict parser would
 * be more correct and less useful. Anything unparseable degrades to "no entries", never to
 * a crash.
 *
 * Explicitly NOT supported, because feeds do not need them and each is an attack surface:
 * DTDs, entity definitions (so no billion-laughs expansion), external entity references
 * (so no XXE), and processing instructions beyond the XML declaration.
 */

export interface XmlNode {
  readonly name: string;
  /** Namespace prefix stripped: `dc:creator` is stored as `creator` under `prefix: 'dc'`. */
  readonly prefix: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function makeNode(qualified: string, attrs: Record<string, string>): XmlNode {
  const colon = qualified.indexOf(':');
  return {
    name: (colon === -1 ? qualified : qualified.slice(colon + 1)).toLowerCase(),
    prefix: colon === -1 ? '' : qualified.slice(0, colon).toLowerCase(),
    attrs,
    children: [],
    text: '',
  };
}

export function parseXml(source: string): XmlNode {
  const root = makeNode('#document', {});
  const stack: XmlNode[] = [root];
  let i = 0;

  const current = (): XmlNode => stack[stack.length - 1] as XmlNode;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      current().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) current().text += decodeEntities(source.slice(i, lt));

    // CDATA is raw text, entities and all.
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      const stop = end === -1 ? source.length : end;
      current().text += source.slice(lt + 9, stop);
      i = end === -1 ? source.length : end + 3;
      continue;
    }

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }

    // Declarations and processing instructions are skipped wholesale. DTDs land here,
    // which is how entity-expansion and external-entity attacks are avoided: they are
    // never interpreted at all.
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) {
      current().text += decodeEntities(source.slice(lt));
      break;
    }
    const raw = source.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      const localName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
      // Unwind to the matching open tag if there is one; ignore the close tag otherwise.
      // Mismatched tags are common enough in real feeds that bailing out is not an option.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if ((stack[depth] as XmlNode).name === localName) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const space = body.search(/\s/);
    const qualified = space === -1 ? body : body.slice(0, space);
    const attrs = space === -1 ? {} : parseAttributes(body.slice(space + 1));

    const node = makeNode(qualified, attrs);
    current().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** Find the `>` that closes a tag, skipping any inside quoted attribute values. */
function findTagEnd(source: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = (match[1] as string).toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** First non-empty text among the named children, tried in order. */
export function firstText(node: XmlNode | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = child(node, name);
    const text = found?.text.trim();
    if (text !== undefined && text.length > 0) return text;
  }
  return undefined;
}

/**
 * Collapse HTML into readable plain text.
 *
 * Feed bodies are HTML far more often than not. Rendering raw markup in a terminal is
 * unpleasant to read and genuinely hostile through a screen reader, which would announce
 * every angle bracket. Block-level elements become line breaks so paragraph structure —
 * the one thing that actually matters for listening — survives.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '  • ');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
