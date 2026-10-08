/**
 * VE2E-96: a small RSS 2.0 item reader for news-source adapters - only the fields a feed publishes for its headlines (title, link, date,
 * description, image). Text-level, no XML engine: entities are decoded from a fixed list and numeric references, never expanded from a
 * DOCTYPE, so a feed cannot pull in external entities. Pure, no network.
 */

export type RssItem = {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  /** Item picture: `<image>` text (Yahoo! JAPAN), `<enclosure type="image/*">`, `<media:thumbnail>` or `<media:content medium="image">`. */
  image: string;
  guid: string;
};

const MAX_ITEMS = 200;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** XML entities: the fixed named ones and numeric references; anything else is left as written. */
export const decodeXmlEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });

/** Element text: CDATA unwrapped, entities decoded, markup inside a description reduced to plain text. */
const textOf = (raw: string): string => {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  const decodedOnce = decodeXmlEntities(unwrapped);
  // a description may carry escaped HTML: drop its tags, decode once more
  return decodeXmlEntities(decodedOnce.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
};

const escapeTag = (tag: string) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const element = (block: string, tag: string): string => {
  const match = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "i").exec(block);
  return match ? textOf(match[1]!) : "";
};
const attribute = (tagSource: string, name: string): string => {
  const match = new RegExp(`\\s${escapeTag(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagSource);
  return match ? decodeXmlEntities(match[2] ?? match[3] ?? "").trim() : "";
};
const imageOf = (block: string): string => {
  const direct = element(block, "image");
  if (/^https?:\/\//i.test(direct)) return direct;
  for (const match of block.matchAll(/<(enclosure|media:thumbnail|media:content)\b[^>]*>/gi)) {
    const tag = match[0];
    const kind = match[1]!.toLowerCase();
    const url = attribute(tag, "url");
    if (!url) continue;
    if (kind === "media:thumbnail") return url;
    if (kind === "enclosure" && /^image\//i.test(attribute(tag, "type"))) return url;
    if (kind === "media:content" && (attribute(tag, "medium").toLowerCase() === "image" || /^image\//i.test(attribute(tag, "type")))) return url;
  }
  return "";
};

/** The `<item>`s of an RSS 2.0 document, in feed order (at most 200). Items without a title or a link are skipped. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]!;
    const item: RssItem = {
      title: element(block, "title"),
      link: element(block, "link"),
      pubDate: element(block, "pubDate"),
      description: element(block, "description"),
      image: imageOf(block),
      guid: element(block, "guid"),
    };
    if (item.title && item.link) items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}
