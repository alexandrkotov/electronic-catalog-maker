import { decodeEntities } from "./normalize";
import type { CardField, SavedPagePreset } from "./presets";

type Values = Partial<Record<keyof SavedPagePreset["fields"], string>>;

/**
 * Reads the product cards out of a store page the person saved from their
 * own browser (see presets.ts "saved-page"). Bun's built-in HTMLRewriter
 * does the CSS-selector matching, so there's no HTML-parser dependency.
 * Each field takes only the FIRST matching element in its card — Payhip,
 * for one, repeats every product name in a second, hidden heading.
 */
export interface PageLink {
  number: number;
  href: string;
}

export interface ExtractedPage {
  cards: Values[];
  /** Numbered links to OTHER pages of the list (the current one excluded). */
  pageLinks: PageLink[];
  /** This page's own number, when the pagination shows it; null = no pagination (a one-page list). */
  current: number | null;
  /** A "Next" link is there — this isn't the last page. */
  hasNext: boolean;
}

export async function extractCards(html: string, preset: SavedPagePreset): Promise<ExtractedPage> {
  const pageLinks: PageLink[] = [];
  let collectText: ((t: string) => void) | null = null;
  const cards: Values[] = [];
  let current: Values | null = null;
  let filled = new Set<string>();
  let rewriter = new HTMLRewriter().on(preset.card, {
    element() {
      current = {};
      filled = new Set();
      cards.push(current);
    },
  });

  for (const [name, field] of Object.entries(preset.fields) as Array<[keyof Values, CardField]>) {
    const selector = field.selector ? `${preset.card} ${field.selector}` : preset.card;
    let collecting = false;
    rewriter = rewriter.on(selector, {
      element(el) {
        if (!current || filled.has(name)) return;
        filled.add(name);
        if (field.attr) {
          current[name] = el.getAttribute(field.attr) ?? "";
        } else if (field.text) {
          current[name] = "";
          collecting = true;
          el.onEndTag(() => void (collecting = false));
        }
      },
      text(chunk) {
        if (collecting && current) current[name] = (current[name] ?? "") + chunk.text;
      },
    });
  }

  let currentPage: number | null = null;
  let hasNext = false;
  if (preset.pagination) {
    const { link, nextIcon } = preset.pagination;
    rewriter = rewriter
      .on(link, {
        element(el) {
          const entry = { href: el.getAttribute("href") ?? "", text: "" };
          el.onEndTag(() => {
            const n = Number(entry.text.trim());
            if (!Number.isInteger(n) || n < 1) return;
            // Payhip links the current page too, to "#" (or the page itself).
            if (entry.href === "" || entry.href.endsWith("#")) currentPage = n;
            else pageLinks.push({ number: n, href: decodeEntities(entry.href) });
          });
          collectText = (t) => (entry.text += t);
        },
        text(chunk) {
          collectText?.(chunk.text);
        },
      })
      .on(`${link} ${nextIcon}`, {
        element() {
          hasNext = true;
        },
      });
  }
  await rewriter.transform(new Response(html)).text();

  return { pageLinks, current: currentPage, hasNext, cards: cards.map((card) => {
    const out: Values = {};
    for (const [name, raw] of Object.entries(card) as Array<[keyof Values, string]>) {
      let value = decodeEntities(raw).replace(/\s+/g, " ").trim();
      const pattern = preset.fields[name]?.pattern;
      if (pattern) value = new RegExp(pattern).exec(value)?.[0] ?? "";
      out[name] = value;
    }
    return out;
  }) };
}

/**
 * The address the page was saved from: Chrome/Edge write a
 * `<!-- saved from url=(NNNN)https://... -->` comment, and most stores
 * also carry a canonical link. Null if neither is there.
 */
export function savedPageUrl(html: string): string | null {
  const saved = /<!-- saved from url=\(\d+\)(\S+?) -->/.exec(html)?.[1];
  if (saved) return saved;
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  return canonical ? (/href=["']([^"']+)["']/i.exec(canonical)?.[1] ?? null) : null;
}
