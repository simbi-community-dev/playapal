/**
 * Speech-text transform: markdown/emoji -> plain synthesizable prose, and
 * event cards -> their fixed spoken shape.
 */

import {
  eventToSpeech,
  factCardToSpeech,
  speechForAssistantMessage,
  timeToSpeech,
  toMarkdownlessSpeech,
} from '../src/speech/toSpeech';
import type { EventRow } from '../src/types';

describe('toMarkdownlessSpeech', () => {
  it('unwraps bold, italics, and strikethrough', () => {
    expect(toMarkdownlessSpeech('Bring **1.5 gallons** of *water* daily')).toBe(
      'Bring 1.5 gallons of water daily',
    );
    expect(toMarkdownlessSpeech('__really__ important, ~~optional~~ required')).toBe(
      'really important, optional required',
    );
    expect(toMarkdownlessSpeech('***all three*** markers')).toBe(
      'all three markers',
    );
  });

  it('keeps intra-word underscores (snake_case survives)', () => {
    expect(toMarkdownlessSpeech('the search_events tool')).toBe(
      'the search_events tool',
    );
    expect(toMarkdownlessSpeech('use _emphasis_ here')).toBe('use emphasis here');
  });

  it('speaks link labels and drops bare URLs', () => {
    expect(
      toMarkdownlessSpeech('See [the survival guide](https://example.com/guide)'),
    ).toBe('See the survival guide');
    expect(toMarkdownlessSpeech('Info at https://burningman.org today')).toBe(
      'Info at today',
    );
  });

  it('speaks image alt text', () => {
    expect(toMarkdownlessSpeech('![map of the city](img.png) shows rings')).toBe(
      'map of the city shows rings',
    );
  });

  it('flattens headings and list items into sentences', () => {
    const md = '## Water\n- Bring 1.5 gallons per day\n- Never share from your mouth\n1. Pack it in\n2. Pack it out';
    expect(toMarkdownlessSpeech(md)).toBe(
      'Water. Bring 1.5 gallons per day. Never share from your mouth. Pack it in. Pack it out.',
    );
  });

  it('keeps existing sentence punctuation on list items', () => {
    expect(toMarkdownlessSpeech('- Drink water!\n- Rest often.')).toBe(
      'Drink water! Rest often.',
    );
  });

  it('unwraps inline code and code fences', () => {
    expect(toMarkdownlessSpeech('run `adb devices` first')).toBe(
      'run adb devices first',
    );
    expect(toMarkdownlessSpeech('```\nwater: 1.5 gal\n```')).toBe(
      'water: 1.5 gal',
    );
  });

  it('strips emoji and pictographs', () => {
    expect(toMarkdownlessSpeech('Stay hydrated 💧 out there 🦛🔥')).toBe(
      'Stay hydrated out there',
    );
    expect(toMarkdownlessSpeech('sun ☀️ and stars ⭐ tonight')).toBe(
      'sun and stars tonight',
    );
    // ZWJ sequence (family) and skin-toned wave.
    expect(toMarkdownlessSpeech('hi 👋🏽 fam 👨‍👩‍👧')).toBe('hi fam');
  });

  it('flattens tables and drops separator rows', () => {
    const md = '| Day | Event |\n|---|---|\n| Tue | Yoga |';
    expect(toMarkdownlessSpeech(md)).toBe('Day, Event Tue, Yoga');
  });

  it('strips blockquotes and horizontal rules', () => {
    expect(toMarkdownlessSpeech('> radical self-reliance\n\n---\n\nok')).toBe(
      'radical self-reliance ok',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(toMarkdownlessSpeech('  too   many\n\n\nspaces  ')).toBe(
      'too many spaces',
    );
  });

  it('passes plain prose through untouched', () => {
    expect(
      toMarkdownlessSpeech('Bring 1.5 gallons of water per person per day.'),
    ).toBe('Bring 1.5 gallons of water per person per day.');
  });
});

describe('timeToSpeech', () => {
  it('converts 24h to spoken 12h', () => {
    expect(timeToSpeech('16:00')).toBe('4:00 PM');
    expect(timeToSpeech('09:30')).toBe('9:30 AM');
    expect(timeToSpeech('00:15')).toBe('12:15 AM');
    expect(timeToSpeech('12:00')).toBe('12:00 PM');
  });

  it('passes junk through', () => {
    expect(timeToSpeech('sunset')).toBe('sunset');
    expect(timeToSpeech('25:99')).toBe('25:99');
  });
});

const YOGA: EventRow = {
  id: 1,
  title: 'Sunrise Yoga',
  desc: 'gentle flow',
  day: 'Tuesday',
  date: '2026-09-01',
  time_start: '06:00',
  time_end: '07:30',
  camp: 'Camp Bendy',
  location: '7:30 & G',
};

describe('eventToSpeech', () => {
  it('speaks "Title, day, time, at location" with & spoken as and', () => {
    expect(eventToSpeech(YOGA)).toBe(
      'Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM to 7:30 AM, at 7:30 and G.',
    );
  });

  it('omits the end time when open-ended', () => {
    expect(eventToSpeech({ ...YOGA, time_end: '' })).toBe(
      'Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM, at 7:30 and G.',
    );
  });

  it('handles named locations', () => {
    expect(
      eventToSpeech({ ...YOGA, location: 'Center Camp' }),
    ).toBe('Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM to 7:30 AM, at Center Camp.');
  });
});

describe('factCardToSpeech', () => {
  it('speaks app-owned attendance, project, and relationship values', () => {
    expect(
      factCardToSpeech({
        kind: 'attendance',
        person: 'River Moon',
        years: [
          { year: 2022, pack_id: 'history', evidence_ref: 'history.md#2022' },
          { year: 2023, pack_id: 'history', evidence_ref: 'history.md#2023' },
        ],
      }),
    ).toBe('River Moon attended in 2022, 2023.');
    expect(
      factCardToSpeech({
        kind: 'projects',
        person: 'River Moon',
        projects: [
          {
            name: 'Shade Build',
            year: 2023,
            pack_id: 'history',
            evidence_ref: 'history.md#shade',
          },
        ],
      }),
    ).toBe("River Moon's projects: Shade Build in 2023.");
    expect(
      factCardToSpeech({
        kind: 'path',
        from: 'River Moon',
        to: 'Drew',
        relationships: [
          {
            from: 'River Moon',
            to: 'Blair',
            year: 2019,
            pack_id: 'history',
            evidence_ref: 'history.md#river-blair',
          },
        ],
      }),
    ).toBe('River Moon was sponsored by Blair in 2019.');
  });

  it('speaks a person card in the pack’s own words, remembrance first', () => {
    expect(
      factCardToSpeech({
        kind: 'person',
        name: 'River Moon',
        alsoKnownAs: 'River',
        aliases: ['R. Moon'],
        tenure: { from: 'Mar 2010', to: 'Aug 2026' },
        summary: 'River Moon is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026.',
        memoriam: null,
        pack_id: 'lore',
        evidence_ref: 'people-lore.md#river-moon',
      }),
    ).toBe(
      'River Moon is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026. Also on the list as R. Moon.',
    );
    expect(
      factCardToSpeech({
        kind: 'person',
        name: 'Blair',
        alsoKnownAs: null,
        aliases: [],
        tenure: { from: 'Apr 2010', to: 'Oct 2011' },
        summary: 'Blair was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011.',
        memoriam: 'In memoriam. The camp gathered for Blair in 2013.',
        pack_id: 'lore',
        evidence_ref: 'people-lore.md#blair',
      }),
    ).toBe(
      'In memoriam. The camp gathered for Blair in 2013. Blair was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011.',
    );
  });
});

describe('speechForAssistantMessage', () => {
  it('speaks prose then each event card', () => {
    expect(
      speechForAssistantMessage('Two yoga sessions **tomorrow**:', [
        { kind: 'event', event: YOGA },
        {
          kind: 'event',
          event: {
            ...YOGA,
            id: 2,
            title: 'Dusk Flow',
            time_start: '18:00',
            time_end: '',
          },
        },
      ]),
    ).toBe(
      'Two yoga sessions tomorrow: Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM to 7:30 AM, at 7:30 and G. Dusk Flow, Tuesday, September 1, 2026, 6:00 PM, at 7:30 and G.',
    );
  });

  it('speaks cards alone when prose is empty', () => {
    expect(speechForAssistantMessage('', [{ kind: 'event', event: YOGA }])).toBe(
      'Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM to 7:30 AM, at 7:30 and G.',
    );
  });

  it('adds terminal punctuation to bare prose so TTS pauses before cards', () => {
    expect(
      speechForAssistantMessage('Here is one', [{ kind: 'event', event: YOGA }]),
    ).toBe(
      'Here is one. Sunrise Yoga, Tuesday, September 1, 2026, 6:00 AM to 7:30 AM, at 7:30 and G.',
    );
  });
});
