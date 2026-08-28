/**
 * THE ADVERTISER KEEPS ITS ADDRESS (punchlist #17, the root of field
 * sweep X5).
 *
 * Every advertise stop/start mints a fresh random BLE address, and the
 * shipped 0.8.0 conductor restarted the advertisement on every payload
 * change — a sharing phone renamed itself four times a minute, measured
 * as 15 distinct addresses with an 11-second median lifetime in one scan
 * log. meshSync's freshness gate survives that world; this change ends
 * it: on API 26+ the payload updates IN PLACE on a live AdvertisingSet.
 *
 * These are source assertions in the walkieCap idiom, because the logic
 * is native and no JS harness reaches it. Each names the mutation it
 * dies on.
 */

// Renamed, not `readSource`/`KT`: suites are SCRIPTS, not modules, so a
// top-level const is GLOBAL — shareApp.test.ts already owns `KT` and
// walkieCap owns `readSource`; tsc rejects the redeclaration while jest
// happily runs both. Same trap the shareApp suite documents.
const readAdvertiserSrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const ADVERTISER_KT = 'android/app/src/main/java/com/playapal/CrewBeaconModule.kt';

describe('the payload updates in place on the set path', () => {
  const kt = readAdvertiserSrc(ADVERTISER_KT);

  test('a live set gets setScanResponseData, not a restart', () => {
    // Mutation: route every payload change through stop/start again and
    // the rotation returns — invisible in any JS test, expensive at camp
    // scale, and the exact thing X5's whole fix family exists to survive.
    expect(kt).toMatch(/set\.setScanResponseData\(/);
    expect(kt).toMatch(/advertise\/\/payload-inplace bytes=/);
  });

  test('LEGACY MODE is pinned — the wire format must not change', () => {
    // Mutation: drop setLegacyMode(true) and the set becomes an EXTENDED
    // advertisement, which iOS CoreBluetooth scanners and pre-extended
    // Android handsets simply do not see. Every peer goes dark at once,
    // and nothing in this repo's tests can notice, because the format
    // lives below all of them.
    expect(kt).toMatch(/\.setLegacyMode\(true\)/);
    // ...and it stays connectable, because the GATT sync path dials it.
    expect(kt).toMatch(/AdvertisingSetParameters\.Builder\(\)[\s\S]{0,400}\.setConnectable\(true\)/);
  });

  test('an in-place update failure is SAID, not swallowed', () => {
    // The advertisement stays on the air with the PREVIOUS payload when
    // setScanResponseData fails — a stale position broadcast dressed as a
    // fresh one, the knows-and-does-not-say class again. The status
    // callback must log and emit state.
    expect(kt).toMatch(/onScanResponseDataSet\(/);
    expect(kt).toMatch(/advertise\/\/payload-inplace failed code=/);
  });

  test('a stopped set drops its handle so nobody pokes a corpse', () => {
    // onAdvertisingSetStopped fires when the OS reclaims the set; keeping
    // the handle would make the next payload change throw into the
    // fallback path forever instead of restarting cleanly once.
    expect(kt).toMatch(/onAdvertisingSetStopped\(/);
    expect(kt).toMatch(/onAdvertisingSetStopped[\s\S]{0,400}advertisingSet = null/);
  });

  test('the legacy pre-26 restart path survives as the fallback', () => {
    // minSdk is 24: an API 24/25 handset still advertises the old way,
    // restart-on-change and all. Mutation: delete the branch and those
    // phones stop advertising entirely.
    expect(kt).toMatch(/advertise\/\/payload-restart bytes=/);
    expect(kt).toMatch(/startAdvertising\(settings, data, scanResponse, cb\)/);
  });

  test('adapter-off drops the set handle with the rest of the radio state', () => {
    // The adapter dying invalidates every handle; a stale set surviving
    // onAdapterOff would be poked by the next payload change.
    expect(kt).toMatch(/onAdapterOff[\s\S]{0,600}advertisingSet = null/);
  });
});
