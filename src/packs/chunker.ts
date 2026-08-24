/**
 * Freeform-content chunker for data packs.
 *
 * Splits a markdown/plain-text document into ~500-token chunks (approximated
 * as ~2000 characters at 4 chars/token) that each carry their heading
 * breadcrumb, so a BM25 hit on a chunk stays interpretable ("Survival Guide >
 * Water"). Pure string work — unit-tested on the dev box, no device needed.
 */

export interface RawChunk {
  /** Heading breadcrumb, " > "-joined; empty string for headingless text. */
  heading: string;
  content: string;
  /** 0-based position within the source document. */
  index: number;
}

/** ~500 tokens at the ~4 chars/token English average. */
export const DEFAULT_MAX_CHARS = 2000;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface Section {
  breadcrumb: string[];
  lines: string[];
}

/** Split markdown into sections at every heading, tracking the breadcrumb stack. */
function splitSections(text: string): Section[] {
  const sections: Section[] = [{ breadcrumb: [], lines: [] }];
  // Breadcrumb stack: stack[i] = active heading text at depth i+1.
  let stack: { level: number; text: string }[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1].length;
      stack = stack.filter(h => h.level < level);
      stack.push({ level, text: m[2] });
      sections.push({ breadcrumb: stack.map(h => h.text), lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections.filter(s => s.lines.join('\n').trim().length > 0);
}

/** Greedily pack paragraphs into chunks of at most maxChars. */
function packParagraphs(body: string, maxChars: number): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) {
      out.push(current);
      current = '';
    }
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      // An oversized paragraph. If it is a LIST (lines that begin with a
      // bullet), pack whole lines instead of hard-splitting mid-sentence:
      // the survival guide is bullet lists under headings with no blank
      // lines between bullets, so the "paragraph" is the whole section, and
      // a space-split lands mid-bullet. Bullet-aware packing keeps each
      // fact whole and lets the same section span several chunks that each
      // carry the breadcrumb (2026-08-17: 42 of 79 guide chunks were over
      // the 700-char excerpt budget, so the model saw a window of most
      // sections — the Temple burn sentence sat outside the window the
      // query 'temple' chose, and the model answered from memory).
      flush();
      const lines = p.split('\n');
      const bulleted = lines.filter(l => /^\s*(?:[-*•]|\d+[.)])\s/.test(l)).length >= 2;
      if (bulleted) {
        let cur = '';
        for (const line of lines) {
          if (line.length > maxChars) {
            if (cur.length > 0) {
              out.push(cur);
              cur = '';
            }
            let rest = line;
            while (rest.length > maxChars) {
              const cut = rest.lastIndexOf(' ', maxChars);
              const at = cut > maxChars / 2 ? cut : maxChars;
              out.push(rest.slice(0, at).trim());
              rest = rest.slice(at).trim();
            }
            cur = rest;
            continue;
          }
          if (cur.length > 0 && cur.length + 1 + line.length > maxChars) {
            out.push(cur);
            cur = '';
          }
          cur = cur.length > 0 ? `${cur}\n${line}` : line;
        }
        if (cur.trim().length > 0) {
          out.push(cur);
        }
        continue;
      }
      // Prose: hard-split at the last space before the budget so no chunk
      // ever exceeds maxChars.
      let rest = p;
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(' ', maxChars);
        const at = cut > maxChars / 2 ? cut : maxChars;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest.length > 0) {
        current = rest;
      }
      continue;
    }
    if (current.length > 0 && current.length + 2 + p.length > maxChars) {
      flush();
    }
    current = current.length > 0 ? `${current}\n\n${p}` : p;
  }
  flush();
  return out;
}

/**
 * Chunk one document. Markdown headings become breadcrumbs; a section longer
 * than the budget is split on paragraph boundaries; headingless plain text
 * chunks with an empty breadcrumb.
 */
export function chunkDocument(
  text: string,
  opts?: { maxChars?: number },
): RawChunk[] {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: RawChunk[] = [];
  for (const section of splitSections(text)) {
    const heading = section.breadcrumb.join(' > ');
    for (const piece of packParagraphs(section.lines.join('\n'), maxChars)) {
      chunks.push({ heading, content: piece, index: chunks.length });
    }
  }
  return chunks;
}
