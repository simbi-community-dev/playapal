/**
 * where_am_i — the Angel-facing location tool.
 *
 * Not currently registered in the model tool contract or executor. Before
 * enabling it, add the schema to tools.ts, dispatch it in toolExecutor.ts,
 * update the system prompt, and re-export the contract used to train and
 * evaluate compatible models.
 */

import {
  formatDistanceFt,
  latLonToBrc,
  nearestToilets,
  type BrcGeometry,
} from './brcGeo';
import type { GeoFix } from './useLocation';

/** Same OpenAI function-call shape as src/llm/tools.ts. */
export const WHERE_AM_I_TOOL = {
  type: 'function',
  function: {
    name: 'where_am_i',
    description:
      "Report the user's current position as a Black Rock City address (clock & ring street), the distance from the Man, and the nearest porta-potty banks. Use when the user asks where they are, for their address, or for the nearest toilet.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
} as const;

/**
 * Executor body (deterministic, mirrors the ToolOutcome json field).
 * Honest absence in words, not an empty object — the 2.6B narrates over
 * shrugs (see toolExecutor.noCoverageJson).
 */
export function whereAmIJson(position: GeoFix | null, geo: BrcGeometry | null): string {
  if (!position) {
    return JSON.stringify({
      error: 'no_gps_fix',
      note: 'No GPS fix yet. Tell the user you cannot see where they are right now and to check that location is enabled.',
    });
  }
  if (!geo) {
    return JSON.stringify({
      error: 'no_city_geometry',
      note: 'GPS works but the city layout asset is missing, so no street address can be computed.',
    });
  }
  const here = latLonToBrc(position.lat, position.lon, geo);
  const toilets = nearestToilets(position.lat, position.lon, geo, 3).map(t => ({
    distance: formatDistanceFt(t.distanceFt),
    walk_min: t.walkMin,
    direction: t.direction,
  }));
  return JSON.stringify({
    address: here.address,
    ring: here.ring,
    clock: here.clock,
    distance_from_man: formatDistanceFt(here.distanceFt),
    nearest_toilets: toilets,
  });
}
