/**
 * ThinkFilter — device-validated behavior (Pixel 7, LFM2.5, 2026-08-13):
 * the stream starts INSIDE an open think block (the chat template pre-opens
 * <think>), and tool-call token spans must never reach the visible bubble.
 */

import {
  ThinkFilter,
  streamChunkFromPartial,
  stripResidualMarkup,
} from '../src/llm/thinkFilter';

function run(filter: ThinkFilter, chunks: string[]): string {
  let visible = '';
  for (const chunk of chunks) {
    visible += filter.push(chunk).visible;
  }
  return visible + filter.flush();
}

describe('ThinkFilter', () => {
  it('starts inside reasoning by default (LFM2.5 pre-opened <think>)', () => {
    const f = new ThinkFilter();
    expect(run(f, ['I should search', ' events.</think>Here you go!'])).toBe(
      'Here you go!',
    );
  });

  it('reports thinking=true before </think> arrives', () => {
    const f = new ThinkFilter();
    expect(f.push('pondering...').thinking).toBe(true);
    expect(f.push('done</think>ok').thinking).toBe(false);
  });

  it('suppresses tool-call token spans from the visible stream', () => {
    const f = new ThinkFilter();
    const out = run(f, [
      'reasoning</think>',
      "<|tool_call_start|>[search_events(query='yoga')]<|tool_call_end|>",
      'Found it.',
    ]);
    expect(out).toBe('Found it.');
  });

  it('handles tags split across token boundaries', () => {
    const f = new ThinkFilter();
    const out = run(f, ['thought</th', 'ink>A<|tool_call_', 'start|>x(1)<|tool_call_end|>B']);
    expect(out).toBe('AB');
  });

  it('still strips explicit <think> blocks mid-stream', () => {
    const f = new ThinkFilter(false);
    expect(run(f, ['Hello <think>hmm</think>world'])).toBe('Hello world');
  });

  it('passes plain text through when constructed for visible mode', () => {
    const f = new ThinkFilter(false);
    expect(run(f, ['just', ' a normal answer'])).toBe('just a normal answer');
  });

  it('drops an unterminated think block instead of leaking it', () => {
    const f = new ThinkFilter();
    expect(run(f, ['endless pondering never closed'])).toBe('');
  });

  it('renders ZERO thinking chars when <think> opens mid-stream (owner defect #1)', () => {
    const f = new ThinkFilter(false);
    const chunks = [
      'Sure — let me ',
      'check.<th',
      'ink>secret plan: grep the guide',
      ' for water ratios',
      '</think>',
      'Bring 1.5 gallons per day.',
    ];
    // Assert on EVERY streamed increment, not just the total: the defect was
    // thinking text visibly streaming before a later cleanup.
    const increments: string[] = [];
    for (const c of chunks) {
      increments.push(f.push(c).visible);
    }
    increments.push(f.flush());
    const all = increments.join('');
    expect(all).toBe('Sure — let me check.Bring 1.5 gallons per day.');
    for (const inc of increments) {
      expect(inc).not.toContain('secret');
      expect(inc).not.toContain('grep');
    }
  });
});

describe('streamChunkFromPartial (the stream-side gate)', () => {
  it('streams only the raw token delta', () => {
    expect(streamChunkFromPartial({ token: 'abc' })).toBe('abc');
  });

  it('NEVER streams accumulated parsed content as a delta (the thinking leak)', () => {
    expect(
      streamChunkFromPartial({
        token: 'x',
        content: '<think>everything generated so far, re-sent every token',
      }),
    ).toBe('x');
    expect(
      streamChunkFromPartial({ content: 'accumulated only, no token field' }),
    ).toBe('');
    expect(
      streamChunkFromPartial({ reasoning_content: 'accumulated reasoning' }),
    ).toBe('');
  });
});

describe('stripResidualMarkup (final-text hardening)', () => {
  it('strips explicit think blocks', () => {
    expect(stripResidualMarkup('<think>hidden</think>Answer here')).toBe(
      'Answer here',
    );
  });

  it('strips tool-call spans and trims', () => {
    expect(
      stripResidualMarkup(
        "  A<|tool_call_start|>[x(1)]<|tool_call_end|> B  ",
      ),
    ).toBe('A B');
  });

  it('passes clean text through', () => {
    expect(stripResidualMarkup('Just an answer.')).toBe('Just an answer.');
  });
});

describe('stripMarkdownEmphasis (bubble renders plain text)', () => {
  const { stripMarkdownEmphasis } = require('../src/llm/thinkFilter');
  it.each([
    ['**John Law** was a *founder*', 'John Law was a founder'],
    ['run `lookup_facts` on [this](http://x.y)', 'run lookup_facts on this'],
    ['## Heading\nplain - bullet stays', 'Heading\nplain - bullet stays'],
    // arithmetic and bare brackets are NOT markdown — they stay verbatim
    ['5 * 3 * 2 stays', '5 * 3 * 2 stays'],
    ['credited to [Laughing Squid].', 'credited to [Laughing Squid].'],
    ['*whole line italic*', 'whole line italic'],
  ])('%s', (input, expected) => {
    expect(stripMarkdownEmphasis(input)).toBe(expected);
  });
});
