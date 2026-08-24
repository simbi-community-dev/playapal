/**
 * Streaming filter that separates reasoning and tool-call token spans from
 * user-visible content in a raw token stream.
 *
 * llama.rn's partial callback usually provides parsed `content` /
 * `reasoning_content` fields when jinja chat formatting is active, but on
 * device (LFM2.5, llama.rn 0.12.8) the stream arrives RAW — reasoning and
 * `<|tool_call_start|>` spans included — and is only parsed clean at the end
 * of the completion. This filter is what keeps the live bubble readable; the
 * final message text is always replaced with the parsed result afterwards.
 *
 * Device-validated 2026-08-13: LFM2.5's chat template pre-opens a <think>
 * block (the model never emits the opening tag itself), so the stream starts
 * inside reasoning — hence `startInThink` defaulting true.
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
const TOOL_OPEN = '<|tool_call_start|>';
const TOOL_CLOSE = '<|tool_call_end|>';

type Mode = 'visible' | 'think' | 'tool';

export class ThinkFilter {
  private mode: Mode;
  private buffer = '';

  constructor(startInThink = true) {
    this.mode = startInThink ? 'think' : 'visible';
  }

  /**
   * Feed one raw chunk; returns the user-visible text it contributes
   * (possibly '') plus whether the stream is currently inside reasoning.
   */
  push(token: string): { visible: string; thinking: boolean } {
    this.buffer += token;
    let visible = '';
    // Process the buffer until no complete tag transition remains.
    for (;;) {
      if (this.mode === 'think') {
        const idx = this.buffer.indexOf(CLOSE_TAG);
        if (idx === -1) {
          break;
        }
        this.buffer = this.buffer.slice(idx + CLOSE_TAG.length);
        this.mode = 'visible';
      } else if (this.mode === 'tool') {
        const idx = this.buffer.indexOf(TOOL_CLOSE);
        if (idx === -1) {
          break;
        }
        this.buffer = this.buffer.slice(idx + TOOL_CLOSE.length);
        this.mode = 'visible';
      } else {
        const thinkIdx = this.buffer.indexOf(OPEN_TAG);
        const toolIdx = this.buffer.indexOf(TOOL_OPEN);
        const enterThink =
          thinkIdx !== -1 && (toolIdx === -1 || thinkIdx < toolIdx);
        if (!enterThink && toolIdx === -1) {
          break;
        }
        const idx = enterThink ? thinkIdx : toolIdx;
        const tag = enterThink ? OPEN_TAG : TOOL_OPEN;
        visible += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + tag.length);
        this.mode = enterThink ? 'think' : 'tool';
      }
    }
    // Emit what cannot be part of a split tag: keep a tail as long as the
    // longest openable tag minus one character.
    if (this.mode === 'visible') {
      const holdback = Math.max(OPEN_TAG.length, TOOL_OPEN.length) - 1;
      if (this.buffer.length > holdback) {
        visible += this.buffer.slice(0, this.buffer.length - holdback);
        this.buffer = this.buffer.slice(this.buffer.length - holdback);
      }
    }
    return { visible, thinking: this.mode === 'think' };
  }

  /** Flush any held-back tail at end of stream. */
  flush(): string {
    const rest = this.mode === 'visible' ? this.buffer : '';
    this.buffer = '';
    this.mode = 'visible';
    return rest;
  }
}

/** The partial-event fields we may receive from llama.rn's token callback. */
export interface PartialTokenData {
  token?: string;
  content?: string;
  reasoning_content?: string;
  accumulated_text?: string;
}

/**
 * Pick the ONLY safely streamable text out of a llama.rn partial event.
 *
 * `token` is the raw text DELTA. `content` / `reasoning_content` /
 * `accumulated_text` are ACCUMULATED snapshots — llama.rn re-parses the whole
 * completion so far on every token (parseChatOutput(true) in RNLlamaJSI.cpp)
 * and attaches the full parsed text. Streaming any accumulated field as if it
 * were a delta replays the entire transcript into the bubble on every token —
 * including the raw <think> body whenever the chat parser does not recognize
 * the model's reasoning format. That was the owner-visible thinking leak
 * (Pixel 7, 2026-08-13): raw reasoning flooding the bubble for ~10 s until
 * the final parsed text replaced it.
 *
 * Regression rule: NEVER stream `content` — only `token`, through ThinkFilter.
 */
export function streamChunkFromPartial(data: PartialTokenData): string {
  return typeof data.token === 'string' ? data.token : '';
}

/**
 * Strip residual <think> blocks and tool-call spans from a FINAL (non-stream)
 * text. Defense-in-depth for the end-of-turn bubble replacement: when the
 * chat parser does not recognize the model's format, `result.content` can
 * still carry raw markup.
 */
export function stripResidualMarkup(text: string): string {
  const f = new ThinkFilter(false);
  return stripMarkdownEmphasis((f.push(text).visible + f.flush()).trim());
}

/**
 * Drop the markdown the model can't stop emitting: the bubble renders plain
 * text, so **bold** showed raw asterisks (owner-visible, Pixel 7 2026-08-17,
 * "**John Law** was..."), and the speech path would read them aloud. Only
 * unambiguous markup is stripped — emphasis pairs, inline code, [text](url)
 * links, and line-leading heading hashes; hyphen bullets and bare brackets
 * are legitimate plain-text idioms and stay. Mirrored by the eval's
 * strip_residual_markup so graded text is what the phone shows.
 */
export function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}
