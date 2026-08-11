/**
 * Feed format normalization.
 *
 * RSS 2.0, RSS 1.0/RDF and Atom disagree about the name of every single field, and real
 * feeds mix vocabularies freely (an Atom feed carrying `dc:creator`, an RSS feed carrying
 * `content:encoded`). Rather than branch on format, every known spelling of each concept
 * is tried in priority order. This is why newsboat's feed handling is mostly a long list
 * of aliases too.
 */

import { child, childrenNamed, firstText, htmlToText, parseXml, type XmlNode } from './xml.js';

export interface FeedItem {
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  readonly author?: string;
  readonly published?: Date;
  readonly summary: string;
  readonly content: string;
  readonly categories: readonly string[];
  readonly enclosures: ReadonlyArray<{ url: string; type?: string; length?: number }>;
}

export interface Feed {
  readonly title: string;
  readonly link?: string;
  readonly description?: string;
  readonly items: readonly FeedItem[];
}

export function parseFeed(xml: string): Feed {
  const doc = parseXml(xml);

  const rss = child(doc, 'rss');
  const channel = child(rss ?? doc, 'channel');
  const atom = child(doc, 'feed');
  const rdf = child(doc, 'rdf');

  if (atom !== undefined) return parseAtom(atom);
  if (channel !== undefined) return parseRss(channel, rdf ?? rss ?? doc);
  if (rdf !== undefined) return parseRss(child(rdf, 'channel') ?? rdf, rdf);

  return { title: 'Unrecognised feed', items: [] };
}

function parseRss(channel: XmlNode, container: XmlNode): Feed {
  // RSS 1.0 puts <item> as a sibling of <channel>, RSS 2.0 puts it inside. Look in both.
  const items = [...childrenNamed(channel, 'item'), ...childrenNamed(container, 'item')];

  return {
    title: firstText(channel, 'title') ?? 'Untitled feed',
    ...(firstText(channel, 'link') === undefined ? {} : { link: firstText(channel, 'link') as string }),
    ...(firstText(channel, 'description') === undefined
      ? {}
      : { description: htmlToText(firstText(channel, 'description') as string) }),
    items: items.map((item, index) => parseRssItem(item, index)),
  };
}

function parseRssItem(item: XmlNode, index: number): FeedItem {
  const link = firstText(item, 'link') ?? child(item, 'link')?.attrs['href'];
  const rawContent = firstText(item, 'encoded', 'content', 'description', 'summary') ?? '';
  const rawSummary = firstText(item, 'description', 'summary') ?? rawContent;
  const published = parseDate(firstText(item, 'pubdate', 'date', 'published', 'updated'));

  const guid = firstText(item, 'guid', 'id');

  return {
    // Identity falls back through guid, link, then title+date, then position. A stable id
    // is what stops the same article being announced as new on every single poll.
    id: guid ?? link ?? `${firstText(item, 'title') ?? 'item'}@${published?.toISOString() ?? String(index)}`,
    title: firstText(item, 'title') ?? htmlToText(rawSummary).slice(0, 80) ?? 'Untitled',
    ...(link === undefined ? {} : { link }),
    ...(firstText(item, 'creator', 'author') === undefined
      ? {}
      : { author: cleanAuthor(firstText(item, 'creator', 'author') as string) }),
    ...(published === undefined ? {} : { published }),
    summary: htmlToText(rawSummary).slice(0, 400),
    content: htmlToText(rawContent),
    categories: childrenNamed(item, 'category')
      .map((c) => c.text.trim() || (c.attrs['term'] ?? ''))
      .filter((c) => c.length > 0),
    enclosures: childrenNamed(item, 'enclosure')
      .map((e) => ({
        url: e.attrs['url'] ?? '',
        ...(e.attrs['type'] === undefined ? {} : { type: e.attrs['type'] }),
        ...(e.attrs['length'] === undefined ? {} : { length: Number(e.attrs['length']) }),
      }))
      .filter((e) => e.url.length > 0),
  };
}

function parseAtom(feed: XmlNode): Feed {
  const selfLink = pickAtomLink(feed);
  return {
    title: firstText(feed, 'title') ?? 'Untitled feed',
    ...(selfLink === undefined ? {} : { link: selfLink }),
    ...(firstText(feed, 'subtitle') === undefined
      ? {}
      : { description: htmlToText(firstText(feed, 'subtitle') as string) }),
    items: childrenNamed(feed, 'entry').map((entry, index) => {
      const link = pickAtomLink(entry);
      const rawContent = firstText(entry, 'content', 'summary') ?? '';
      const rawSummary = firstText(entry, 'summary', 'content') ?? '';
      const published = parseDate(firstText(entry, 'published', 'updated'));
      const author = child(entry, 'author');

      return {
        id: firstText(entry, 'id') ?? link ?? `entry-${String(index)}`,
        title: firstText(entry, 'title') ?? 'Untitled',
        ...(link === undefined ? {} : { link }),
        ...(firstText(author, 'name') === undefined ? {} : { author: firstText(author, 'name') as string }),
        ...(published === undefined ? {} : { published }),
        summary: htmlToText(rawSummary).slice(0, 400),
        content: htmlToText(rawContent),
        categories: childrenNamed(entry, 'category')
          .map((c) => c.attrs['term'] ?? c.text.trim())
          .filter((c) => c.length > 0),
        enclosures: childrenNamed(entry, 'link')
          .filter((l) => l.attrs['rel'] === 'enclosure' && l.attrs['href'] !== undefined)
          .map((l) => ({
            url: l.attrs['href'] as string,
            ...(l.attrs['type'] === undefined ? {} : { type: l.attrs['type'] }),
          })),
      };
    }),
  };
}

function pickAtomLink(node: XmlNode | undefined): string | undefined {
  const links = childrenNamed(node, 'link');
  const alternate = links.find((l) => (l.attrs['rel'] ?? 'alternate') === 'alternate');
  return (alternate ?? links[0])?.attrs['href'];
}

function cleanAuthor(value: string): string {
  // RSS authors are canonically `email (Name)`; the name is the useful half.
  const match = /^\s*\S+@\S+\s*\((.+)\)\s*$/.exec(value);
  return match === null ? value.trim() : (match[1] as string).trim();
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
