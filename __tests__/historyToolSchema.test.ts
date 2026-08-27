import { ALL_TOOLS, LOOKUP_HISTORY_TOOL } from '../src/llm/tools';
import { HISTORY_QUERIES } from '../src/facts/historyLookup';

describe('lookup_history tool schema', () => {
  test('exposes only canned queries and rejects extra slots', () => {
    expect(LOOKUP_HISTORY_TOOL.function.parameters.properties.query.enum).toEqual(
      HISTORY_QUERIES,
    );
    expect(LOOKUP_HISTORY_TOOL.function.parameters.required).toEqual(['query']);
    expect(LOOKUP_HISTORY_TOOL.function.parameters.additionalProperties).toBe(false);
    expect(ALL_TOOLS).toContain(LOOKUP_HISTORY_TOOL);
  });
});
