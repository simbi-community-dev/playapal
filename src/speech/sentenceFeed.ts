/**
 * SentenceFeed — incremental sentence-boundary detection over the FILTERED
 * token stream, so spoken replies can start at the first completed sentence
 * instead of after the whole decode (owner field report: a 30 s tooled turn
 * felt long; perceived latency becomes time-to-first-sentence).
 *
 * Pure module, fully unit-tested. Feed it visible-text chunks as they
 * arrive; it returns sentences the moment they complete. flush() hands back
 * whatever remains when the stream ends.
 */

/**
 * A sentence completes at terminal punctuation (. ! ? …), optionally followed
 * by closing quotes/brackets, and THEN whitespace — the trailing whitespace
 * requirement keeps decimals ("1.5 gallons") and abbreviations mid-token
 * intact, because the "." there is followed by a digit/letter, not space.
 * A newline always completes the unit (markdown headings and list items are
 * spoken lines even without terminal punctuation).
 */
const BOUNDARY_RE = /[.!?…][)\]"'”’]*\s/;

export class SentenceFeed {
  private buffer = '';

  /** Feed one streamed chunk; returns any sentences completed by it. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const done: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      const match = BOUNDARY_RE.exec(this.buffer);
      let end: number;
      if (match && (newline < 0 || match.index < newline)) {
        // Split after the punctuation + closers, before the whitespace.
        end = match.index + match[0].length - 1;
      } else if (newline >= 0) {
        end = newline;
      } else {
        break;
      }
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (sentence.length > 0) {
        done.push(sentence);
      }
    }
    return done;
  }

  /** The unfinished remainder (stream over); resets the feed. */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }
}
