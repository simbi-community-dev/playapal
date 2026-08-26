import {
  eventDateLabel,
  eventFollowUp,
  eventFollowUpHasTemporalConstraint,
  eventSearchNarration,
  reconcileEventNarration,
} from '../src/llm/eventNarration';
import type {
  EventRow,
  EventSearchOutcome,
  SourceRef,
} from '../src/types';

const event: EventRow = {
  id: 501,
  title: 'Sunrise Yoga',
  desc: 'Gentle movement and a quiet start to the day.',
  day: 'Thursday',
  date: '2026-09-03',
  time_start: '07:00',
  time_end: '08:00',
  camp: 'Test Camp',
  location: '7:30 & G',
};

function search(): Extract<EventSearchOutcome, { state: 'matches' }> {
  return {
    state: 'matches',
    results: [event],
    window: null,
    relation: 'unconstrained',
    strategy: 'fts-and',
  };
}

const source: SourceRef = {
  id: 'guide:1',
  pack: 'Survival Guide',
  doc: 'Hydration',
  heading: 'Survival > Hydration',
  passage: 'Bring water and shade for the afternoon.',
  memorial: false,
};

describe('structured-event narration guard', () => {
  test('does nothing when search_events did not run', () => {
    expect(reconcileEventNarration([])).toBeNull();
  });

  test.each([
    'Nothing is happening tonight.',
    'I found zero events.',
    'Three events are Friday at 9:00 near Center Camp.',
    'Morning yoga starts at 10:00.',
  ])('generated competing event prose is never part of the result: %s', _text => {
    expect(reconcileEventNarration([search()])?.text).toBe(
      'I found 1 event in the offline guide.',
    );
  });

  test('distinguishes an authoritative zero-result search', () => {
    const empty: EventSearchOutcome = {
      state: 'empty',
      results: [],
      window: {
        label: 'tonight',
        startISO: '2026-09-02T18:00',
        endISO: '2026-09-03T05:59',
      },
      searchedScope: 'all-enabled-events',
      strategy: 'none',
    };
    expect(eventSearchNarration(empty)).toBe(
      'I found no matching events for tonight in the offline guide.',
    );
  });

  test('uses deterministic relaxed-window mismatch context and exact dates', () => {
    const relaxed: EventSearchOutcome = {
      state: 'matches',
      results: [event],
      window: {
        label: 'Wednesday',
        startISO: '2026-09-02T00:00',
        endISO: '2026-09-02T23:59',
      },
      relation: 'outside-requested-date',
      strategy: 'fts-and',
    };
    expect(eventSearchNarration(relaxed)).toBe(
      'No Wednesday matches; here is 1 alternative on Thursday, September 3, 2026.',
    );
  });

  test('does not claim an untimed alternative disproves an exact-time match', () => {
    const untimed: EventSearchOutcome = {
      state: 'matches',
      results: [{ ...event, time_start: '', time_end: '' }],
      window: {
        label: 'Thursday at 9:00 PM',
        startISO: '2026-09-03T21:00',
        endISO: '2026-09-03T21:00',
      },
      relation: 'outside-requested-time',
      strategy: 'fts-and',
    };
    expect(eventSearchNarration(untimed)).toBe(
      'No confirmed Thursday at 9:00 PM matches; here is 1 alternative on Thursday, September 3, 2026.',
    );
  });

  test('keeps lower-authority descriptions and passages out of display and speech', () => {
    const stale = {
      ...event,
      desc: 'Monday at 09:00 in Center Camp.',
    };
    const result = reconcileEventNarration([
      { ...search(), results: [stale] },
    ], [{ ...source, passage: 'Monday at 09:00 in Center Camp.' }]);
    expect(result?.text).toBe('I found 1 event in the offline guide.');
    expect(result?.text).not.toContain('Monday');
    expect(result?.history).toContain(
      'Grounded guide material: Monday at 09:00 in Center Camp.',
    );
  });

  test('deduplicates repeated searches and ignores not-run noise beside results', () => {
    const notRun: EventSearchOutcome = {
      state: 'not-run',
      results: [],
      window: null,
      reason: 'no-keywords-or-window',
      strategy: 'none',
    };
    const result = reconcileEventNarration([notRun, search(), search()]);
    expect(result?.text).toBe('I found 1 event in the offline guide.');
    expect(result?.history.match(/"id":501/g)).toHaveLength(1);
  });

  test('keeps incompatible scoped misses scoped instead of inventing a global zero', () => {
    const monday: EventSearchOutcome = {
      state: 'empty',
      results: [],
      window: {
        label: 'Monday',
        startISO: '2026-08-31T00:00',
        endISO: '2026-08-31T23:59',
      },
      searchedScope: 'requested-window',
      strategy: 'none',
    };
    const tuesday: EventSearchOutcome = {
      ...monday,
      window: {
        label: 'Tuesday',
        startISO: '2026-09-01T00:00',
        endISO: '2026-09-01T23:59',
      },
    };
    expect(reconcileEventNarration([monday, tuesday])?.text).toBe(
      'I found no matching events for Monday in the offline guide. I found no matching events for Tuesday in the offline guide.',
    );
  });

  test('closes a sole not-run event call without accepting a generated denial', () => {
    const notRun: EventSearchOutcome = {
      state: 'not-run',
      results: [],
      window: null,
      reason: 'no-keywords-or-window',
      strategy: 'none',
    };
    expect(reconcileEventNarration([notRun])?.text).toBe(
      'I need an event name, activity, place, or time to search the offline guide.',
    );
    expect(reconcileEventNarration([notRun], [source])).toBeNull();
  });

  test('collapses a zero plus direct match into one positive presentation', () => {
    const empty: EventSearchOutcome = {
      state: 'empty', results: [], window: null,
      searchedScope: 'all-enabled-events', strategy: 'none',
    };
    expect(reconcileEventNarration([empty, search()])?.text).toBe(
      'I found 1 event in the offline guide.',
    );
  });

  test('preserves distinct positive and empty event query identities', () => {
    const yoga: EventSearchOutcome = {
      ...search(),
      query: 'sunrise yoga',
    };
    const tea: EventSearchOutcome = {
      state: 'empty',
      results: [],
      window: null,
      query: 'tea ceremony',
      searchedScope: 'all-enabled-events',
      strategy: 'none',
    };
    const result = reconcileEventNarration([yoga, tea]);
    expect(result?.text).toBe(
      'I found 1 event matching “sunrise yoga” in the offline guide. I found no matching events for “tea ceremony” in the offline guide.',
    );
    expect(result?.history.match(/"id":501/g)).toHaveLength(1);
  });

  test('preserves one coherent relaxed match while dropping an intermediate zero', () => {
    const window = {
      label: 'Wednesday',
      startISO: '2026-09-02T00:00',
      endISO: '2026-09-02T23:59',
    };
    const empty: EventSearchOutcome = {
      state: 'empty', results: [], window,
      searchedScope: 'requested-window', strategy: 'none',
    };
    const relaxed: EventSearchOutcome = {
      state: 'matches', results: [event], window,
      relation: 'outside-requested-date', strategy: 'fts-and',
    };
    expect(reconcileEventNarration([empty, relaxed])?.text).toBe(
      'No Wednesday matches; here is 1 alternative on Thursday, September 3, 2026.',
    );
  });

  test('uses one generic positive summary for incompatible direct and relaxed searches', () => {
    const direct: EventSearchOutcome = {
      state: 'matches',
      results: [event],
      strategy: 'fts-and',
      window: {
        label: 'Thursday',
        startISO: '2026-09-03T00:00',
        endISO: '2026-09-03T23:59',
      },
      relation: 'within-request',
    };
    const relaxed: EventSearchOutcome = {
      state: 'matches',
      results: [event],
      strategy: 'fts-and',
      window: {
        label: 'Wednesday morning',
        startISO: '2026-09-02T06:00',
        endISO: '2026-09-02T11:59',
      },
      relation: 'outside-requested-date',
    };
    expect(reconcileEventNarration([direct, relaxed])?.text).toBe(
      'I found 1 event in the offline guide.',
    );
  });

  test('deduplicates final rows across differing relax types and windows', () => {
    const outsideTime: EventSearchOutcome = {
      state: 'matches', results: [event],
      window: {
        label: 'Thursday morning',
        startISO: '2026-09-03T06:00',
        endISO: '2026-09-03T11:59',
      },
      relation: 'outside-requested-time', strategy: 'fts-and',
    };
    const outsideDate: EventSearchOutcome = {
      state: 'matches', results: [event, event],
      window: {
        label: 'Wednesday',
        startISO: '2026-09-02T00:00',
        endISO: '2026-09-02T23:59',
      },
      relation: 'outside-requested-date', strategy: 'fts-or',
    };
    const result = reconcileEventNarration([outsideTime, outsideDate]);
    expect(result?.text).toBe('I found 1 event in the offline guide.');
    expect(result?.history.match(/"id":501/g)).toHaveLength(1);
  });

  test('keeps exact structured event identity in inference history', () => {
    const result = reconcileEventNarration([search()]);
    expect(result?.history).toContain('"id":501');
    expect(result?.history).toContain('"title":"Sunrise Yoga"');
    expect(result?.history).toContain('"date":"2026-09-03"');
    expect(result?.history).toContain('"location":"7:30 & G"');
  });

  test('resolves conservative ordinal, title, and sole-event reserved-fact follow-ups', () => {
    expect(eventFollowUp('What time does the first event start?', [event])?.text).toBe(
      'Sunrise Yoga starts at 07:00.',
    );
    expect(eventFollowUp('Where is Sunrise Yoga?', [event])?.text).toBe(
      'Sunrise Yoga is at 7:30 & G.',
    );
    expect(eventFollowUp('What time is it?', [event])?.text).toBe(
      'Sunrise Yoga runs 07:00–08:00.',
    );
    expect(eventFollowUp('When is this event?', [event])?.text).toBe(
      'Sunrise Yoga is on Thursday, September 3, 2026, 07:00–08:00.',
    );
    expect(eventFollowUp('Where is first aid?', [event])).toBeNull();
    expect(eventFollowUp('Where can I park near it?', [event])).toBeNull();
    expect(eventFollowUp('Where and when is Sunrise Yoga?', [event])).toBeNull();
  });

  test('treats recurring exact titles as ambiguous until one occurrence is named', () => {
    const repeat = {
      ...event,
      id: 502,
      date: '2026-09-05',
      day: 'Saturday',
      time_start: '09:00',
      time_end: '10:00',
    };
    expect(eventFollowUp('When is Sunrise Yoga?', [event, repeat])).toEqual({
      event: null,
      field: 'when',
      text: "I can't tell which event you mean. Name one of the event titles shown above.",
    });
  });

  test('accepts natural polite shells and possessive reserved-field follow-ups', () => {
    expect(eventFollowUp('Could you tell me where Sunrise Yoga is?', [event])?.text).toBe(
      'Sunrise Yoga is at 7:30 & G.',
    );
    expect(eventFollowUp('When does Sunrise Yoga start?', [event])?.text).toBe(
      'Sunrise Yoga starts at 07:00.',
    );
    expect(eventFollowUp("What's its location?", [event])?.text).toBe(
      'Sunrise Yoga is at 7:30 & G.',
    );
    expect(eventFollowUp('Does it have an end time?', [event])?.text).toBe(
      'Sunrise Yoga ends at 08:00.',
    );
    expect(eventFollowUp('When is it ending?', [event])?.text).toBe(
      'Sunrise Yoga ends at 08:00.',
    );
    expect(eventFollowUp('When is it beginning?', [event])?.text).toBe(
      'Sunrise Yoga starts at 07:00.',
    );
  });

  test('distinguishes end time and incomplete time/location listings', () => {
    expect(eventFollowUp('What time does the first option end?', [event])?.text).toBe(
      'Sunrise Yoga ends at 08:00.',
    );
    const open = { ...event, time_end: '' };
    expect(eventFollowUp('When does that one end?', [open])?.text).toBe(
      'Sunrise Yoga has no listed end time.',
    );
    expect(eventFollowUp('What time is it?', [open])?.text).toBe(
      'Sunrise Yoga starts at 07:00, with no listed end time.',
    );
    const untimed = { ...event, time_start: '', time_end: '', location: '' };
    expect(eventFollowUp('When does that one start?', [untimed])?.text).toBe(
      'Sunrise Yoga has no listed start time.',
    );
    expect(eventFollowUp('What time is it?', [untimed])?.text).toBe(
      'Sunrise Yoga has no listed time.',
    );
    expect(eventFollowUp('Where is it?', [untimed])?.text).toBe(
      'Sunrise Yoga has no listed location.',
    );
  });

  test('prefers nested specificity without discarding separately named titles', () => {
    const generic = { ...event, id: 502, title: 'Yoga' };
    expect(eventFollowUp('Where is Sunrise Yoga?', [generic, event])).toEqual({
      event,
      field: 'location',
      text: 'Sunrise Yoga is at 7:30 & G.',
    });
    expect(eventFollowUp('Where is Sunrise Yoga?', [generic])).toBeNull();
    const tea = { ...event, id: 503, title: 'Tea Ceremony' };
    expect(eventFollowUp('Where are Yoga and Tea Ceremony?', [generic, tea])).toEqual({
      event: null,
      field: 'location',
      text: "I can't tell which event you mean. Name one of the event titles shown above.",
    });
  });

  test('does not mistake reserved words inside a title for the requested field', () => {
    const titled = { ...event, title: 'The End' };
    const early = { ...event, id: 502, title: 'Early Start' };
    expect(eventFollowUp('Where is The End?', [titled])).toEqual({
      event: titled,
      field: 'location',
      text: 'The End is at 7:30 & G.',
    });
    expect(eventFollowUp('The End', [titled], 'location')).toEqual({
      event: titled,
      field: 'location',
      text: 'The End is at 7:30 & G.',
    });
    expect(eventFollowUp('What time is The End?', [titled])?.field).toBe('time');
    expect(eventFollowUp('When is Early Start?', [early])?.field).toBe('when');
    expect(eventFollowUp('Do you know when the first one begins?', [early])?.field)
      .toBe('start');
  });

  test('prefers exact titles but generic ordinal references still use result order', () => {
    const titled = { ...event, id: 502, title: 'The Last Event' };
    const actualLast = { ...event, id: 503, title: 'Closing Party' };
    expect(eventFollowUp('Where is The Last Event?', [titled, actualLast])?.event).toBe(
      titled,
    );
    const namedFirst = { ...event, id: 504, title: 'First' };
    expect(eventFollowUp('Where is the first event?', [event, namedFirst])?.event).toBe(
      event,
    );
  });

  test('keeps real constraints without treating exact temporal-word titles as constraints', () => {
    const friday = { ...event, id: 505, title: 'Friday' };
    const thisWeek = { ...event, id: 506, title: 'This Week' };
    expect(eventFollowUp('Where is Friday?', [friday])?.event).toBe(friday);
    expect(eventFollowUpHasTemporalConstraint('Where is Friday?', friday)).toBe(false);
    expect(eventFollowUp('What time is This Week?', [thisWeek])?.event).toBe(thisWeek);
    expect(eventFollowUpHasTemporalConstraint('What time is This Week?', thisWeek)).toBe(false);
    expect(eventFollowUpHasTemporalConstraint('Where is Sunrise Yoga Friday?', event))
      .toBe(true);
    const morning = { ...event, title: 'Morning Yoga' };
    expect(eventFollowUpHasTemporalConstraint('Where is Morning Yoga?', morning))
      .toBe(false);
    expect(eventFollowUpHasTemporalConstraint(
      'Where is Morning Yoga?',
      null,
      [morning, { ...morning, id: 506 }],
    )).toBe(false);
    expect(eventFollowUpHasTemporalConstraint('Where is Sunrise Yoga at 9pm?', event))
      .toBe(true);
    expect(eventFollowUp('Where is Sunrise Yoga on 2026-09-04?', [event])?.event)
      .toBe(event);
    expect(eventFollowUpHasTemporalConstraint(
      'Where is Sunrise Yoga on 2026-09-04?',
      event,
    )).toBe(true);
    expect(eventFollowUp('Where is Sunrise Yoga on September 4?', [event])?.event)
      .toBe(event);
    expect(eventFollowUp('Where is Sunrise Yoga this week?', [event])?.event)
      .toBe(event);
    expect(eventFollowUp('Where is Sunrise Yoga at 9pm?', [event])?.event)
      .toBe(event);
    expect(friday.title).toBe('Friday');
  });

  test('matches title accents with the same normalization as fact identity', () => {
    const cafe = { ...event, title: 'Café Yoga' };
    expect(eventFollowUp('Where is Cafe Yoga?', [cafe])?.event).toBe(cafe);
  });

  test('carries an ambiguous field into a following bare-title disambiguation', () => {
    const other = { ...event, id: 502, title: 'Sunset Yoga' };
    expect(eventFollowUp('Where is that event?', [event, other])).toEqual({
      event: null,
      field: 'location',
      text: "I can't tell which event you mean. Name one of the event titles shown above.",
    });
    expect(eventFollowUp('Sunrise Yoga', [event, other], 'location')).toEqual({
      event,
      field: 'location',
      text: 'Sunrise Yoga is at 7:30 & G.',
    });
    expect(
      eventFollowUp('Is Sunrise Yoga kid friendly?', [event, other], 'location'),
    ).toBeNull();
  });

  test('formats exact valid event dates without host-locale drift', () => {
    expect(eventDateLabel('2026-09-03')).toBe('September 3, 2026');
    expect(eventDateLabel('2026-02-31')).toBe('2026-02-31');
    expect(eventDateLabel('not-a-date')).toBe('not-a-date');
  });
});
