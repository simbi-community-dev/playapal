/**
 * Tool schemas passed to llama.rn's completion (OpenAI function-call format,
 * rendered into the chat template via jinja).
 *
 * search_events mirrors the prototype schema exactly (toolcall-proto-results:
 * 12/12 recall, 8/8 precision with the nudge-v2 system prompt). `day` remains
 * in the schema so the tested nudge stays verbatim, but the app treats it as
 * an UNTRUSTED HINT — the real time window is parsed app-side from the user's
 * raw text (see src/events/timeParser.ts).
 */

export const SEARCH_EVENTS_TOOL = {
  type: 'function',
  function: {
    name: 'search_events',
    description:
      'Search the offline Black Rock City events guide. Use for any question about what is happening, scheduled, or going on at a place or time.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "Search keywords taken from the user's question, e.g. 'sunrise yoga' or 'pancake breakfast'. Keywords only - no dates.",
        },
        day: {
          type: 'string',
          description:
            "The user's own day word, passed through verbatim: 'today', 'tonight', 'tomorrow', or a weekday name. Omit entirely if the user gave none. Never a calendar date.",
        },
      },
      required: ['query'],
    },
  },
} as const;

export const SEARCH_DOCS_TOOL = {
  type: 'function',
  function: {
    name: 'search_docs',
    description:
      'Search the imported document packs (camp guides, manuals, notes) for relevant passages. Use for questions the events guide cannot answer.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords, e.g. "generator fuel" or "shower policy".',
        },
        pack_id: {
          type: 'string',
          description: 'Optional: restrict the search to one document pack by its id.',
        },
      },
      required: ['query'],
    },
  },
} as const;

export const LOOKUP_FACTS_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_facts',
    // "and this camp's needs/offers board" added for camp board v0 — the
    // executor now also searches camp-board-* packs. The topic examples are
    // untouched (nudge/description wording is measurably load-bearing at
    // 2.6B; re-run EVAL-v11-TOOLS before editing further).
    description:
      "Look up a Burning Man concept or logistics topic (MOOP, exodus, the 10 principles, water, ice, medical, addresses) in the survival guide and this camp's needs/offers board.",
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: "The topic to look up, e.g. 'MOOP' or 'exodus'.",
        },
      },
      required: ['topic'],
    },
  },
} as const;

export const LOOKUP_HISTORY_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_history',
    description:
      'Look up structured camp history: attendance years, projects, sponsorship lineage, year cohorts, or a sponsorship path. Use this instead of guessing relational facts.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          enum: ['attendance', 'projects', 'sponsors', 'sponsees', 'cohort', 'path'],
          description: 'The exact canned graph query to run.',
        },
        entity: {
          type: 'string',
          description: 'Person name or alias. For cohort, this may be the year.',
        },
        year: {
          type: 'integer',
          minimum: 1,
          maximum: 9999,
          description: 'Optional attendance filter, or the cohort year.',
        },
        target: {
          type: 'string',
          description: 'Second person name or alias; required only for path.',
        },
        pack_id: {
          type: 'string',
          description: 'Optional pack id when the same name exists in multiple packs.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
} as const;

export const ALL_TOOLS = [
  SEARCH_EVENTS_TOOL,
  SEARCH_DOCS_TOOL,
  LOOKUP_FACTS_TOOL,
  LOOKUP_HISTORY_TOOL,
];
