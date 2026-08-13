/**
 * Conformance: is our card model actually a subset of Adaptive Cards?
 *
 * The claim in `docs/RENDERING.md` and `docs/PRIOR-ART.md` is that the vocabulary was
 * adopted rather than invented — that it is a published, versioned schema we do not
 * maintain, and that a Teams message carrying a real Adaptive Card could eventually be
 * rendered by the same pipeline. A claim like that decays quietly: one convenient extra
 * property at a time, until what is left is a lookalike dialect and the justification for
 * choosing it no longer holds.
 *
 * So this test compares the model against the real schema and requires every divergence to
 * be *declared*. The declarations below are the interesting output: they are the exact and
 * complete list of ways this differs from Adaptive Cards, each with the reason. Adding a
 * property to an interface in `card.ts` without recording it here fails, because the
 * property names are read out of the source rather than restated by hand.
 *
 * The fixture is derived from the official schema, with the upstream sha256 recorded in it,
 * so the derivation is checkable. See `packages/core/src/test/fixtures/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/test -> dist -> core -> packages -> repo root. */
const repoRoot = join(here, '..', '..', '..', '..');

interface SchemaFixture {
  readonly source: string;
  readonly sha256: string;
  readonly definitions: Readonly<Record<string, { readonly properties: readonly string[] }>>;
}

const schema = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'core', 'src', 'test', 'fixtures', 'adaptive-card-schema.json'), 'utf8'),
) as SchemaFixture;

const cardSource = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'card.ts'), 'utf8');

/**
 * Pull an interface's property names out of the source.
 *
 * Reading the source rather than restating the fields is the whole point: a hand-written
 * mirror of the model drifts from the model, which is the failure this test exists to
 * catch, one level up.
 */
function propertiesOf(name: string): readonly string[] {
  const start = cardSource.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `interface ${name} not found in card.ts`);
  const end = cardSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `interface ${name} is not closed`);
  const block = cardSource.slice(start, end);
  return [...block.matchAll(/^\s*readonly (\w+)\??:/gm)].map((m) => m[1] as string).sort();
}

/**
 * Properties Adaptive Cards defines on every element, which the fixture attaches to the
 * concrete definitions already. Listed here only for the reader.
 */
const SHARED = ['spacing', 'separator'];

/**
 * The complete, deliberate divergence list.
 *
 * Each entry is a property we define that Adaptive Cards does not, with why. If this list
 * grows without a reason beside it, the "we adopted a schema" argument has stopped being
 * true and `docs/PRIOR-ART.md` should say so.
 */
const DIVERGENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Card: {
    title: 'The pane needs a heading. Adaptive Cards leaves this to the host chrome, which a terminal pane does not have.',
  },
  TextBlock: {
    tone: 'Replaces `color`. Adaptive Cards names a colour; a tone names a meaning, so a monochrome theme can render it as a mark. This is the central adaptation.',
    speak: 'Adaptive Cards carries `speak` only on the card. Per-element speech is what lets a diffstat read as "876 added, 24 removed" instead of as punctuation.',
  },
  Fact: {
    tone: 'Same substitution as TextBlock. Upstream facts cannot be toned at all.',
  },
  Table: {
    header: 'Upstream models a header as `firstRowAsHeader` plus a TableRow. A separate array makes "every row has the same number of cells as the header" checkable, which is the ragged-table bug.',
    speak: 'A grid read down a one-dimensional channel is the worst case in speech; this says the sentence the table is shorthand for.',
  },
  TableCell: {
    text: 'Upstream cells contain arbitrary elements. A terminal cell is one string, and nesting a card inside a table cell is a layout problem with no good answer at 40 columns.',
    tone: 'Same substitution as TextBlock.',
    style: 'Same substitution as TextBlock.',
  },
  Container: {
    title: 'Upstream has no container title. A titled group is how a comment thread nests legibly in a pane.',
    tone: 'Same substitution as TextBlock.',
  },
};

/** Elements that are ours entirely, with the reason upstream has no equivalent. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  BadgeSet:
    'Upstream has no chip element; labels would have to be a ColumnSet of TextBlocks, which cannot flow across lines as the width changes.',
  Prose:
    'Upstream TextBlock does not distinguish a paragraph flow from a labelled value. A mail body must preserve indentation, because indented text is quoted or code and re-wrapping destroys it.',
};

describe('Adaptive Cards conformance', () => {
  it('records where the schema came from, so the fixture can be re-derived', () => {
    assert.equal(schema.source, 'https://adaptivecards.io/schemas/adaptive-card.json');
    assert.match(schema.sha256, /^[0-9a-f]{64}$/);
  });

  const MAPPING: readonly (readonly [string, string])[] = [
    ['Card', 'AdaptiveCard'],
    ['TextBlock', 'TextBlock'],
    ['FactSet', 'FactSet'],
    ['Fact', 'Fact'],
    ['Table', 'Table'],
    ['TableCell', 'TableCell'],
    ['ColumnSet', 'ColumnSet'],
    ['Column', 'Column'],
    ['Container', 'Container'],
    ['ActionSet', 'ActionSet'],
    ['OpenUrlAction', 'Action.OpenUrl'],
  ];

  it('names every borrowed element exactly as the schema does', () => {
    for (const [, upstream] of MAPPING) {
      assert.ok(schema.definitions[upstream] !== undefined, `${upstream} is not in the schema`);
    }
  });

  for (const [ours, upstream] of MAPPING) {
    it(`${ours} adds nothing to ${upstream} that is not declared`, () => {
      const mine = propertiesOf(ours);
      const theirs = new Set(schema.definitions[upstream]?.properties ?? []);
      const declared = DIVERGENCES[ours] ?? {};
      const undeclared = mine
        .filter((p) => p !== 'type')
        .filter((p) => !theirs.has(p))
        .filter((p) => declared[p] === undefined);
      assert.deepEqual(
        undeclared,
        [],
        `${ours} has properties Adaptive Cards does not define and this test does not explain: ${undeclared.join(', ')}. ` +
          'Add them to DIVERGENCES with a reason, or remove them.',
      );
    });
  }

  /**
   * The other direction. A divergence that stops being a divergence is stale documentation
   * claiming a difference that no longer exists, which is exactly as misleading as an
   * undocumented one.
   */
  it('does not claim a divergence that no longer exists', () => {
    for (const [ours, entries] of Object.entries(DIVERGENCES)) {
      const mine = new Set(propertiesOf(ours));
      for (const property of Object.keys(entries)) {
        assert.ok(mine.has(property), `${ours}.${property} is declared as a divergence but is not in card.ts`);
      }
    }
  });

  it('keeps the extension set small and explained', () => {
    for (const [name, reason] of Object.entries(EXTENSIONS)) {
      assert.ok(schema.definitions[name] === undefined, `${name} is claimed as an extension but exists upstream`);
      assert.ok(reason.length > 40, `${name} needs a real reason`);
      assert.ok(cardSource.includes(`export interface ${name} {`), `${name} is not in card.ts`);
    }
    // Two is a subset with a couple of terminal-specific additions. Ten would be a dialect.
    assert.ok(Object.keys(EXTENSIONS).length <= 3, 'the extension set has grown past "a subset plus a little"');
  });

  it('borrows the shared element properties rather than renaming them', () => {
    for (const property of SHARED) {
      assert.ok(
        (schema.definitions['TextBlock']?.properties ?? []).includes(property),
        `${property} should be an upstream name`,
      );
      assert.ok(propertiesOf('TextBlock').includes(property), `${property} should be on our TextBlock`);
    }
  });

  /**
   * Version is not decoration. A stored card has to be migratable, and the number is the
   * only thing that says which vocabulary it was written against.
   */
  it('declares the schema version it targets', () => {
    assert.match(cardSource, /export const CARD_VERSION = '1\.5'/);
  });
});
