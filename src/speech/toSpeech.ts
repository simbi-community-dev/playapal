/**
 * Speech-text transform: assistant markdown -> plain synthesizable prose.
 * TTS engines read "*" as "asterisk" and URLs as letter soup; app-owned
 * structured cards get fixed spoken shapes instead of model-generated prose.
 *
 * Pure module — no native imports; fully unit-tested.
 */

import type { ChatCard, EventRow, FactCard } from '../types';

/**
 * Emoji / pictograph ranges as EXPLICIT code-point ranges. Hermes' regex
 * support for \p{Extended_Pictographic} is not guaranteed across RN versions,
 * and a bad regex would fail at bytecode compile — explicit ranges work
 * everywhere. Covers: misc symbols + pictographs, transport, supplemental
 * symbols, extended-A, dingbats, misc technical arrows/hourglass/keycap
 * combiners, regional indicators (flags), skin tones, ZWJ, variation
 * selectors.
 */
const EMOJI_RE = new RegExp(
  [
    '[\u{1F000}-\u{1FAFF}]', // pictographs, emoticons, transport, extended
    '[\u{2600}-\u{27BF}]', // misc symbols + dingbats (incl. ☀✨✅❤)
    '[\u{2190}-\u{21FF}]', // arrows
    '[\u{2B00}-\u{2BFF}]', // misc symbols and arrows (⭐)
    '[\u{2300}-\u{23FF}]', // misc technical (⌛⏰)
    '[\u{FE00}-\u{FE0F}]', // variation selectors
    '[\u{1F3FB}-\u{1F3FF}]', // skin tones (inside first range, kept explicit)
    '\u{200D}', // zero-width joiner
    '\u{20E3}', // combining enclosing keycap
  ].join('|'),
  'gu',
);

/** Ensure a fragment ends with sentence punctuation so the TTS pauses. */
function sentence(fragment: string): string {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return /[.!?:;,]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Markdown/emoji -> plain speech text. Bold/italics/strikethrough unwrap,
 * links speak their label, list items and headings become sentences, code
 * fences keep their content, tables flatten, emoji vanish.
 */
export function toMarkdownlessSpeech(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: drop the fences, keep the content (the assistant
  // rarely emits code; when it does, the words still carry the meaning).
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, '$1');
  // Inline code.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images speak their alt text; links speak their label.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bare URLs are letter soup — drop them.
  text = text.replace(/https?:\/\/\S+/g, '');
  // Emphasis (longest markers first so ** unwraps before *). The (\S(?:...)?)
  // capture keeps intra-word underscores (snake_case) intact because the
  // marker must hug non-space content on both sides.
  text = text.replace(/\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*/g, '$1');
  text = text.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '$1');
  text = text.replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, '$1');
  text = text.replace(/__(\S(?:[\s\S]*?\S)?)__/g, '$1');
  text = text.replace(/(^|\s)_(\S(?:[^_\n]*?\S)?)_(?=\s|[.,!?;:]|$)/gm, '$1$2');
  text = text.replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '$1');

  const lines = text.split('\n').map(line => {
    let out = line;
    // Table separator rows (|---|---|) vanish; cell pipes become commas.
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(out) && out.includes('-')) {
      return '';
    }
    if (out.includes('|')) {
      out = out
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell.length > 0)
        .join(', ');
    }
    // Headings, blockquotes, bullets, numbered items -> bare sentences.
    const heading = out.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      return sentence(heading[1]);
    }
    out = out.replace(/^\s{0,3}>\s?/, '');
    const bullet = out.match(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/);
    if (bullet) {
      return sentence(bullet[1]);
    }
    // Horizontal rules.
    if (/^\s*([-*_]\s*){3,}$/.test(out)) {
      return '';
    }
    return out;
  });
  text = lines.join('\n');

  // Emoji out, then whitespace discipline: newlines to spaces, collapse runs.
  text = text.replace(EMOJI_RE, '');
  // Leftover empty emphasis/artifact punctuation pairs like "()" from
  // stripped URLs.
  text = text.replace(/\(\s*\)/g, '');
  text = text.replace(/\s+([.,!?;:])/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** "16:00" -> "4:00 PM"; "09:30" -> "9:30 AM"; junk passes through. */
export function timeToSpeech(hhmm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return hhmm;
  }
  const hours = Number(m[1]);
  const minutes = m[2];
  if (hours > 23) {
    return hhmm;
  }
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${minutes} ${suffix}`;
}

/**
 * One event card in its fixed spoken shape:
 * "Title, day, time, at location." Playa addresses speak "&" as "and"
 * ("7:30 and G"); an open-ended card omits the end time.
 */
export function eventToSpeech(ev: EventRow): string {
  const time =
    ev.time_end && ev.time_end.length > 0
      ? `${timeToSpeech(ev.time_start)} to ${timeToSpeech(ev.time_end)}`
      : timeToSpeech(ev.time_start);
  const location = ev.location.replace(/\s*&\s*/g, ' and ');
  const title = toMarkdownlessSpeech(ev.title);
  return `${title}, ${ev.day}, ${time}, at ${location}.`;
}

export function factCardToSpeech(fact: FactCard): string {
  if (fact.kind === 'person') {
    // The camp's own words, in the card's order — remembrance first for the
    // departed, then the summary sentence, then the other names the list
    // carried. Never the model's synthesis of any of it.
    const parts = fact.memoriam === null ? [] : [fact.memoriam];
    parts.push(fact.summary);
    if (fact.aliases.length > 0) {
      parts.push(
        `${fact.memoriam === null ? 'Also' : 'Also appeared'} on the list as ${fact.aliases.join(', ')}.`,
      );
    }
    return parts.map(sentence).join(' ');
  }
  if (fact.kind === 'attendance') {
    return `${fact.person} attended in ${fact.years.map(item => item.year).join(', ')}.`;
  }
  if (fact.kind === 'projects') {
    const projects = fact.projects.map(item =>
      item.year === null ? item.name : `${item.name} in ${item.year}`,
    );
    return `${fact.person}'s projects: ${projects.join(', ')}.`;
  }
  if (fact.kind === 'cohort') {
    return `${fact.year} cohort: ${fact.people.map(item => item.name).join(', ')}.`;
  }
  return fact.relationships
    .map(item =>
      `${item.from} was sponsored by ${item.to}${
        item.year === null ? '' : ` in ${item.year}`
      }.`,
    )
    .join(' ');
}

/** Full spoken text: transformed prose, then every app-owned structured card. */
export function speechForAssistantMessage(text: string, cards?: ChatCard[]): string {
  const parts: string[] = [];
  const prose = toMarkdownlessSpeech(text);
  if (prose.length > 0) {
    parts.push(sentence(prose));
  }
  for (const card of cards ?? []) {
    parts.push(
      card.kind === 'event' ? eventToSpeech(card.event) : factCardToSpeech(card),
    );
  }
  return parts.join(' ');
}
