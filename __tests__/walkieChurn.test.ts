/**
 * linkChurnCopy — the §1 patch sentence (docs/WALKIE-LADDER.md §1: a rung
 * failure must never degrade membership; until the channel line grows
 * stable rows, the honest patch is NAMING the churn while it happens).
 *
 * Audit case 2, 2026-08-25 dust bench: the same podmate flickered in and
 * out of the channel list as their pipe reconnected, with no frame in
 * which that reads as anything but a fault.
 */
import { WALKIE_CHURN_MS, linkChurnCopy } from '../src/crews/walkie';

describe('the churn sentence appears on observation and only then', () => {
  const T = 1_000_000;

  test('two flips inside the window earn the sentence', () => {
    // Mutation: fire on the first flip — every walkie start (empty ->
    // someone) announces churn that never happened.
    const line = linkChurnCopy([T - 30_000, T - 5_000], T);
    expect(line).toMatch(/come and go/);
    expect(line).toMatch(/not a fault/);
    expect(line).toMatch(/get through/); // async keeps equal billing
  });

  test('one flip is a join, not churn', () => {
    expect(linkChurnCopy([T - 5_000], T)).toBeNull();
  });

  test('old flips age out of the window', () => {
    // Mutation: drop the window filter — one flappy minute at sunset
    // brands the channel unstable for the rest of the night (a claim
    // about the future, which §5 forbids).
    expect(
      linkChurnCopy([T - WALKIE_CHURN_MS - 1, T - WALKIE_CHURN_MS - 2], T),
    ).toBeNull();
  });

  test('the sentence never names a mechanism', () => {
    const line = linkChurnCopy([T - 10_000, T - 5_000], T)!;
    expect(line).not.toMatch(
      /\b(ble|gatt|aware|lan|nan|datapath|rung|ladder|wi-?fi|bluetooth|udp|mdns|subnet|protocol)\b/i,
    );
  });
});
