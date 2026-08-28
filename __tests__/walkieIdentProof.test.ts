/**
 * THE PROOF MEMO AND THE CHURN DAMPER — the two halves of "already
 * reached", held to the same rule on both phones.
 *
 * Measured on the 2026-08-26 bench (p7-bench.log, p9-bench.log): each
 * Pixel logged `voice//connect hash=0` against the iPhone, never logged
 * `voice//peer-ready`, and then logged `voice//scan-drop
 * reason=already-reached addr=5A:34:2C:79:29:2C`. Read against the code
 * that triple has exactly one path: `provenAddr` was stamped by a dial the
 * duplicate check then REFUSED, and the damper spent that stamp on every
 * later sighting of the address — against a peer entry whose link runs
 * somewhere else entirely. An unproven connection became a permanent
 * suppression, and the scan stream is the only retry engine this rung has.
 *
 * Two invariants come out of that, and nothing type-checks a Kotlin file
 * against a Swift one, so this suite reads them:
 *
 *   1. The memo is written by SUCCESS. A record that says "this address is
 *      that phone" may only exist for a link that was actually established
 *      from that address.
 *   2. "Already reached" means READY. `connecting` is a dial in flight,
 *      which has proved nothing; refusing a second CONCURRENT dial is
 *      maybeConnect's job, on the same entry, and it still does it.
 *
 * Plus the third thing the bench could not do at all: read the iPhone.
 *
 * Each assertion names the mutation it dies on.
 */
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/WalkieBleLink.kt';
const SWIFT = 'ios/PlayaPal/WalkieBleVoice.swift';

describe('the proof memo is written by success, and only by success', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('Android stamps provenAddr AFTER the duplicate check can refuse the dial', () => {
    // THE ZOMBIE. Mutation: move the put back above `val existing` (the
    // pre-2026-08-27 order). A refused dial leaves a memo claiming its
    // address is reached, and every future sighting of that address is
    // damped against a peer whose link is elsewhere — hash=0 forever, no
    // audio, no error.
    const dedupe = kt.indexOf('val existing = voicePeers[sender]');
    const put = kt.indexOf('provenAddr.put');
    expect(dedupe).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(dedupe);
  });

  test('iOS stamps provenIdentity AFTER its own duplicate check', () => {
    // Mutation: the same reversal on the other phone. The two halves must
    // fail and heal together or the bug simply changes which handset it
    // lives on.
    const dedupe = swift.indexOf('if let existing = voicePeers[sender]');
    const put = swift.indexOf('provenIdentity[id] = sender');
    expect(dedupe).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(dedupe);
  });

  test('neither file stamps the memo anywhere else', () => {
    // Mutation: add a "helpful" early stamp at the dial or at discovery.
    // One writer, on the accepted path, is the whole invariant.
    expect(kt.match(/provenAddr\.put/g) ?? []).toHaveLength(1);
    expect(swift.match(/provenIdentity\[[a-z]+\] = /g) ?? []).toHaveLength(1);
  });
});

describe('"already reached" means reached, not dialling', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('both dampers judge liveness by ready alone', () => {
    // Mutation: restore `p.ready || p.connecting`. A dial in flight — which
    // has proved nothing and may be about to fail — suppresses the sighting
    // that would have healed it, on the one stream that can.
    expect(kt).toMatch(/val p = voicePeers\[known\]\s*\n\s*if \(p != null && p\.ready\)/);
    expect(kt).not.toMatch(/p\.ready \|\| p\.connecting/);
    expect(swift).toMatch(/let p = voicePeers\[known\], p\.ready \{/);
    expect(swift).not.toMatch(/p\.ready \|\| p\.connecting/);
  });

  test('the PROOF-time dedupe still refuses a second road to a live peer', () => {
    // The narrowing above is scoped to the damper on purpose. Mutation:
    // narrow this one too and a phone reached under one address is dialled
    // again under another while the first dial is still in flight —
    // two pipes to one podmate, which is what the damper was born for.
    expect(kt).toMatch(/existing\.ready \|\| existing\.connecting/);
    expect(swift).toMatch(/existing\.ready \|\| existing\.connecting/);
  });

  test('a concurrent dial of the SAME entry is still refused at the dial', () => {
    // Mutation: drop this guard while the damper no longer covers it, and
    // every sighting inside a 12 s setup opens another connection.
    expect(kt).toMatch(/if \(peer\.ready \|\| peer\.connecting\) \{\s*\n\s*return/);
    expect(swift).toMatch(/if peer\.ready \|\| peer\.connecting \{\s*\n\s*return/);
  });
});

describe('the iPhone can be read at all', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('iOS names the same decisions Android does', () => {
    // "No audio and NO ERRORS" was true by construction: this file logged
    // nothing whatsoever while its Kotlin mirror named a dozen decisions.
    // Mutation: delete any verb below and the next bench is back to
    // guessing from one side of a two-sided handshake.
    for (const verb of [
      'connect',
      'peer-ready',
      'peer-lost',
      'setup-timeout',
      'scan-drop',
      'ident-reject',
      // The ready-link watchdog's two verbs, on both phones since the
      // iPhone got a watchdog it can safely own (2026-08-27). Mutation:
      // ship the watchdog on one side and the pod's two halves demote on
      // different evidence with only one of them saying so.
      'liveness-busy',
      'liveness-lost',
    ]) {
      expect(kt).toContain(`voice//${verb}`);
      // The iOS logger prefixes "voice//" once, in vlog, so the verb is
      // the first thing in the line it is handed.
      expect(swift).toMatch(new RegExp(`vlog\\(\\s*\n?\\s*"${verb}[ "]`));
    }
  });

  test('iOS says the write budget it refused a link over', () => {
    // The one number the bench could not read. An iPhone whose negotiated
    // write is smaller than a frame drops the link before ident — silently,
    // which is indistinguishable from "the Android never advertised".
    // Mutation: drop the line and that failure is invisible again.
    expect(swift).toMatch(/vlog\(\s*\n?\s*"write-budget hash=/);
    expect(swift).toMatch(/granted=" \+ String\(budget\)/);
  });

  test('peer names off the wire reach OSLog as one public value, never a format string', () => {
    // Mutation: restore NSLog("voice//" + line). A podmate who names
    // themselves "%@ %n" now becomes a format string. Logger's typed
    // interpolation carries the whole already-built line as data instead.
    const code = swift
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/NSLog\(/);
    expect(code).toMatch(/wlog\.notice\("voice\/\/\\\(line, privacy: \.public\)"\)/);
  });
});

// ------------------------------------------------ the dialer names itself

/**
 * THE REVERSE-DIRECTION HANDSHAKE, and this is the round that made its
 * arms EXECUTE instead of describe.
 *
 * THE MEASUREMENT (2026-08-27 02:22): identity on this wire is proved ONE
 * DIRECTION PER LINK — the central reads the peripheral's IDENT, so a dial
 * proves the phone that was DIALLED. A Pixel dialled the iPhone and had
 * her named in nine seconds; the iPhone, holding no link of its own to the
 * Pixel yet, had nothing to read and spent one to four MINUTES playing
 * that Pixel's frames as an unnamed "someone is talking" while it waited
 * on its own sighting, its own backoff and its own dial. On the rung that
 * exists for two people in the dust with no Wi-Fi anywhere.
 *
 * af06a4e wrote it and was reverted (6ca686c). e4b0923 rebuilt it to a
 * reconciliation and was refused on two findings, and BOTH are cured here.
 *
 * F1 — A DEAD TRANSPORT IS NOT A REFUSAL. e4b0923 kept one retry behind
 * the one synchronous signal it believed was certain: `per.state !=
 * .connected`. Read as a refusal, that branch offered the SAME bytes down
 * the SAME dead pipe a second time and then settled `skipped` — the
 * read-only peer's voice-safe outcome, which publishes. So a link that had
 * ended between the setup read and the handshake was briefly markReady'd
 * and handed the module a writer. `per.state != .connected` says the
 * TRANSPORT HAS ENDED; a second identical offer cannot heal it, and
 * `skipped` belongs to one road only — a pipe that is up, serving an IDENT
 * that has no .write, which is every phone already in the dust. It now
 * settles `.dead` and leaves by generationFailed, the recursion is gone,
 * the offer count is 1 by construction and the constant with it, and the
 * publish door re-asks the pipe for the window that remains: an
 * acknowledgment or an error delivered after a disconnect our own guard
 * could not have seen.
 *
 * F2 — THE MODEL MUST DO THE ACCOUNTING. Deleting the identOutstanding
 * decrement left every committed arm green, while the real link kept
 * opsRemaining=1 and never published. So the machine below STEPS the
 * counter: it reads the increment and the decrement out of the Swift, runs
 * them, and the publish door asks the number it actually holds. Then the
 * three races that number exists for — a real completion, a duplicated
 * one, and the cap against a late acknowledgment — plus a compatibility
 * matrix that is four dials executed end to end rather than four claims.
 *
 * The model is told what the Swift DOES. It is never told what the answer
 * should be.
 */

/**
 * The text of a `{ … }` block, matched by COUNTING BRACES from the first
 * one at or after `needle`. The older reader here cut at a fixed
 * indentation, which only worked while every shape it read sat at one
 * nesting depth — and the shape this file reads has now MOVED depth twice.
 */
const braceBlock = (src: string, needle: string): string => {
  const at = src.indexOf(needle);
  if (at < 0) {
    return '';
  }
  const open = src.indexOf('{', at);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') {
      depth += 1;
    } else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(at, j + 1);
      }
    }
  }
  return '';
};

/** Comment lines dropped: this file's Swift NAMES what it must not do
 *  ("this must never reach generationFailed"), and a reader that cannot
 *  tell a warning from a call reads the warning as the bug. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\/\/\/)/.test(l))
    .join('\n');

/** Which outcome a block settles, '' if it settles none. */
const settledBy = (block: string): string =>
  /settle\((?:id|self\.id), \.(\w+)\)/.exec(codeOnly(block))?.[1] ?? '';

/** The outcomes the source itself calls NOT voice-safe. Read from the
 *  enum where it lives there, and from the settle's own expression where
 *  it does not — one reader for the cured file and the one it replaces. */
const unsafeOutcomes = (sw: string, settle: string): Set<string> => {
  const vs = braceBlock(braceBlock(sw, 'enum IdentOutcome: String {'), 'var voiceSafe: Bool {');
  const cases = /case ([^:\n]+): return false/.exec(vs)?.[1];
  if (cases !== undefined) {
    return new Set(cases.split(',').map((c) => c.trim().replace(/^\./, '')));
  }
  const legacy = /identVoiceSafe = outcome != \.(\w+)/.exec(settle)?.[1];
  return new Set(legacy === undefined ? [] : [legacy]);
};

/** EVERY RULE THE MACHINE RUNS ON, read out of the Swift and nothing
 *  invented. `air` is the whole road a byte can take to the wire — one
 *  function in the cured file, two in the one it replaces. */
const identRules = (sw: string) => {
  const begin = braceBlock(sw, 'func beginIdent(_ bytes: Data) {');
  const offer = braceBlock(sw, 'private func offerIdent(_ bytes: Data, _ ch: CBCharacteristic) {');
  // COMMENTS OUT BEFORE ANY INDEX IS TAKEN. This file's Swift NAMES the
  // API it is reasoning about — "CoreBluetooth's writeValue(_:for:type:)
  // returns Void" sits in a comment ABOVE the real call — and a reader
  // that measures where the first `writeValue(` appears in raw text
  // measures the prose.
  const air = codeOnly(`${begin}\n${offer}`);
  const settle = braceBlock(sw, 'private func settle(_ token: Int, _ outcome: IdentOutcome) {');
  const unsafeBranch = braceBlock(settle, 'guard identVoiceSafe else {');
  const wrote = braceBlock(sw, 'didWriteValueFor characteristic: CBCharacteristic, error: Error?');
  const errBranch = braceBlock(wrote, 'guard error == nil else {');
  const publish = braceBlock(sw, 'private func publish(_ gen: BleLinkGeneration, _ peer: VoicePeer) {');
  const capClosure = braceBlock(air, 'WalkieBleVoice.identSettleCap');
  const transportGuardHead = /guard [^\n]*per\.state == \.connected else \{/.exec(air)?.[0] ?? '';
  const transport = transportGuardHead === '' ? '' : braceBlock(air, transportGuardHead);
  const readOnly = braceBlock(air, 'guard ch.properties.contains(.write) else {');
  const acks = codeOnly(wrote).match(/settle\(id, \.(\w+)\)/g) ?? [];
  return {
    present: begin !== '' && settle !== '' && wrote !== '',
    capSeconds: Number(/static let identSettleCap: TimeInterval = (\d+)/.exec(sw)?.[1] ?? 0),
    /** The bound that used to be a number. Its ABSENCE is the cure. */
    offerConstant: /static let identWriteOffers/.test(sw),
    offerCap: Number(/static let identWriteOffers = (\d+)/.exec(sw)?.[1] ?? 1),
    /** How many writes the whole road can put on the air. */
    writeValues: (air.match(/\bwriteValue\(/g) ?? []).length,
    armsCapFirst:
      air.indexOf('identSettleCap') > -1 &&
      air.indexOf('identSettleCap') < air.indexOf('writeValue('),
    capChecksSettled: /!self\.identSettled/.test(capClosure),
    /** What a peripheral that is NOT connected gets, and whether the
     *  source turns round and offers it the same bytes again. */
    transportRefuses: transport !== '',
    transportOutcome: settledBy(transport),
    transportReoffers: /offerIdent\(|beginIdent\(/.test(codeOnly(transport)),
    /** What an IDENT with no .write gets — the compat road. */
    readOnlyRefuses: readOnly !== '',
    readOnlyOutcome: settledBy(readOnly),
    /** THE ACCOUNTING, both halves, and where each one sits. */
    incrementsBeforeWrite:
      air.indexOf('identOutstanding += 1') > -1 &&
      air.indexOf('identOutstanding += 1') < air.indexOf('writeValue('),
    decrements: /identOutstanding\s*(?:=\s*max\(0, identOutstanding - 1\)|-= 1)/.test(wrote),
    /** The framework write is FENCED — CoreBluetooth raises NSException
     *  synchronously on a too-large value or a torn-down characteristic,
     *  and a bare raise skips settle, strands the cap, and takes the
     *  process. */
    writeGuarded: /let raised = ObjCTry\.run \{/.test(air),
    raiseUnwinds:
      /identOutstanding = max\(0, identOutstanding - 1\)/.test(
        braceBlock(air, 'if raised != nil {'),
      ) && /settle\(id, \.dead\)/.test(braceBlock(air, 'if raised != nil {')),
    /** didWrite answers ONLY a live generation: after retirement the
     *  callback returns before the counter moves. */
    wroteChecksRetired: /guard !retired/.test(codeOnly(wrote)),
    decrementClamped: /identOutstanding = max\(0, identOutstanding - 1\)/.test(wrote),
    settleOnce: /guard token == id, !identSettled else \{/.test(settle),
    unsafe: unsafeOutcomes(sw, settle),
    tearsDownWhenUnsafe: /generationFailed\(/.test(codeOnly(unsafeBranch)),
    publishesWhenUnsafe: /publishIfSettled|publish\(/.test(codeOnly(unsafeBranch)),
    errorOutcome: settledBy(errBranch),
    errorTearsDown: /generationFailed/.test(codeOnly(errBranch)),
    ackOutcome: /\.(\w+)\)$/.exec(acks[acks.length - 1] ?? '')?.[1] ?? '',
    publishOnceGuard: /!gen\.ready/.test(publish),
    publishNeedsProof: /gen\.identProven/.test(publish),
    publishNeedsVoiceSafe: /gen\.identVoiceSafe/.test(publish),
    publishNeedsZeroOps: /gen\.identOpsRemaining == 0/.test(publish),
    publishNeedsTransport: /gen\.transportConnected/.test(publish),
    publishNeedsCurrentGen: /peer\.link === gen/.test(publish),
  };
};

/** What the far end and the local stack do to the one op. */
interface IdentWorld {
  /** the far end's IDENT carries .write (a build-46 iPhone) */
  writable: boolean;
  /** is the pipe up at the moment beginIdent runs */
  connected: boolean;
  /** …and at the moment an ASYNC completion arrives, which is a second
   *  moment: the disconnect callback can be queued behind our own. */
  connectedAtCompletion?: boolean;
  /** what the stack does with the write that went out */
  answer: 'ack' | 'error' | 'silence';
  /** the stack delivers didWriteValueFor twice for the one write */
  duplicate?: boolean;
  /** the cap fires BEFORE the answer arrives */
  capFirst?: boolean;
  /** the cap fires AFTER the answer settled it */
  capAfter?: boolean;
  /** the stack raises NSException synchronously inside writeValue */
  raises?: boolean;
}

interface IdentRun {
  /** times the road touched a pipe it had already found dead */
  deadPipeOffers: number;
  bytesOnAir: number;
  /** settles that actually TOOK — the once-only guard, counted */
  settles: number;
  settled: string;
  publishes: number;
  writer: boolean;
  tornDown: boolean;
  /** identOpsRemaining after every transition that moved it */
  opsSeen: number[];
  opsRemaining: number;
  opsFloor: number;
  /** 'proof' — listed in the instant the proof landed, nothing on the air;
   *  'settle' — listed when the exchange came back. */
  publishedAt: string;
}

/**
 * THE SETTLE MACHINE. It holds the counter the Swift holds, moves it where
 * the Swift moves it, and asks the publish door the same questions the
 * Swift's guard asks — so an arm dies when the accounting is wrong, not
 * only when a regex stops matching.
 */
const runIdent = (sw: string, w: IdentWorld): IdentRun => {
  const r = identRules(sw);
  const out: IdentRun = {
    deadPipeOffers: 0,
    bytesOnAir: 0,
    settles: 0,
    settled: '',
    publishes: 0,
    writer: false,
    tornDown: false,
    opsSeen: [],
    opsRemaining: 0,
    opsFloor: 0,
    publishedAt: '',
  };
  if (!r.present) {
    // No handshake at all — the reverted state. The link is listed with
    // nothing on the air and the far end waits on its own dial.
    out.settled = 'no-handshake';
    out.publishes = 1;
    out.writer = true;
    out.publishedAt = 'proof';
    return out;
  }
  let ops = 0;
  let live = w.connected;
  let proven = false;
  let voiceSafe = false;
  const move = (to: number): void => {
    ops = to;
    out.opsSeen.push(ops);
    out.opsRemaining = ops;
    out.opsFloor = Math.min(out.opsFloor, ops);
  };

  /** The publish guard, every condition, executed against live state. */
  const door = (why: string): void => {
    if (out.tornDown) {
      return; // !gen.retired
    }
    if (r.publishNeedsProof && !proven) {
      return;
    }
    if (r.publishNeedsVoiceSafe && !voiceSafe) {
      return;
    }
    if (r.publishOnceGuard && out.writer) {
      return; // !gen.ready — one door, and it opens once
    }
    if (r.publishNeedsZeroOps && ops !== 0) {
      return; // an acknowledged write is still unaccounted for
    }
    if (r.publishNeedsTransport && !live) {
      return; // the pipe went away while the settle was in flight
    }
    out.writer = true;
    out.publishes += 1;
    if (out.publishedAt === '') {
      out.publishedAt = why;
    }
  };

  /** settle(token:outcome:), once-only if the source says once-only. */
  const settle = (outcome: string, why: string): void => {
    if (r.settleOnce && out.settled !== '') {
      return;
    }
    out.settles += 1;
    out.settled = outcome;
    voiceSafe = !r.unsafe.has(outcome);
    if (!voiceSafe) {
      if (r.tearsDownWhenUnsafe) {
        out.tornDown = true;
      }
      if (r.publishesWhenUnsafe) {
        door(why);
      }
      return;
    }
    door(why);
  };

  proven = true; // identProven, set before every guard below it
  if (!live) {
    // THE NOT-CONNECTED ROAD, whatever the source makes of it — a
    // teardown, or a refusal that offers the same bytes down the same dead
    // pipe until a budget stops it.
    for (;;) {
      out.deadPipeOffers += 1;
      if (r.transportReoffers && out.deadPipeOffers < r.offerCap) {
        continue;
      }
      break;
    }
    if (r.transportOutcome !== '') {
      settle(r.transportOutcome, 'transport');
    }
    return out;
  }
  if (!w.writable && r.readOnlyRefuses) {
    // Nothing goes on the air, and the link is audible in the instant it
    // was proved.
    settle(r.readOnlyOutcome, 'proof');
    return out;
  }
  // THE ONE OFFER.
  if (r.incrementsBeforeWrite) {
    move(ops + 1);
  }
  if (w.raises === true) {
    // A synchronous NSException inside writeValue: nothing went on the
    // air. Fenced, the road unwinds its own increment and retires the
    // link; bare, there is no road left to model — the process is gone.
    if (!r.writeGuarded) {
      out.settled = 'process-crashed';
      return out;
    }
    if (r.raiseUnwinds) {
      move(Math.max(0, ops - 1));
    }
    settle('dead', 'raise');
    return out;
  }
  out.bytesOnAir += 1;
  if (w.capFirst) {
    settle('expired', 'cap');
  }
  const completion = (): void => {
    if (out.tornDown && r.wroteChecksRetired) {
      // guard !retired — a late answer to a retired link returns before
      // the counter moves. Production truth, measured at didWriteValueFor.
      return;
    }
    if (r.decrements) {
      move(r.decrementClamped ? Math.max(0, ops - 1) : ops - 1);
    }
    live = w.connectedAtCompletion ?? live;
    if (w.answer === 'error') {
      if (r.errorTearsDown) {
        // The outage: a link that carries our voice is torn down because a
        // peer declined an optional courtesy.
        out.settled = 'failed-teardown';
        out.settles += 1;
        out.tornDown = true;
        return;
      }
      settle(r.errorOutcome, 'settle');
      return;
    }
    settle(r.ackOutcome, 'settle');
  };
  if (w.answer !== 'silence') {
    completion();
    if (w.duplicate === true) {
      completion();
    }
  }
  if (w.capAfter === true && !(r.capChecksSettled && out.settled !== '')) {
    settle('expired', 'cap');
  }
  if (out.settled === '') {
    settle('expired', 'cap'); // identSettleCap, with nothing else to stop it
  }
  return out;
};

/** THE OTHER HALF OF THE WIRE: what OUR peripheral does for a phone that
 *  dialled US. Read from the two CBPeripheralManager handlers and the
 *  inbound hint, so a row that says "nothing publishes on their behalf" is
 *  a run and not a claim. */
const serveRules = (sw: string) => {
  const read = braceBlock(sw, 'func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {');
  const write = braceBlock(sw, 'func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {');
  const hint = braceBlock(sw, 'private func handleIdentWrite(_ id: UUID, _ value: Data) {');
  return {
    servesIdentRead:
      /request\.value = b\.subdata/.test(read) && /withResult: \.success/.test(read),
    routesIdentWrite:
      /request\.characteristic\.uuid == Self\.identChar/.test(write) &&
      /handleIdentWrite\(/.test(write),
    hintPresent: hint !== '',
    mintsRow: /onPeer\(|markReady|VoicePeer\(/.test(codeOnly(hint)),
    writesMemo: /provenIdentity/.test(codeOnly(hint)),
    dialsDirect: /BleLinkGeneration\(|\.connect\(/.test(codeOnly(hint)),
    triggersDial: /maybeConnect\(/.test(codeOnly(hint)),
  };
};

interface ServeRun {
  onTheWire: string[];
  rows: number;
  writers: number;
  memos: number;
  dialsOffered: number;
}

const runServe = (sw: string, events: Array<'read' | 'write'>): ServeRun => {
  const r = serveRules(sw);
  const out: ServeRun = { onTheWire: [], rows: 0, writers: 0, memos: 0, dialsOffered: 0 };
  for (const e of events) {
    if (e === 'read') {
      out.onTheWire.push(r.servesIdentRead ? 'ident-blob' : 'attribute-not-found');
      continue;
    }
    out.onTheWire.push('write-ack');
    if (!r.routesIdentWrite) {
      out.onTheWire.push('handed-to-the-audio-path');
      continue;
    }
    if (r.mintsRow) {
      out.rows += 1;
      out.writers += 1;
    }
    if (r.writesMemo) {
      out.memos += 1;
    }
    if (r.dialsDirect || r.triggersDial) {
      out.dialsOffered += 1;
    }
  }
  return out;
};

describe('the iPhone names itself on the link it just proved', () => {
  const swift = readSource(SWIFT);

  test('one logical op, ONE offer, and the cap is armed before it', () => {
    // Mutation: arm the cap after the offer and a write that never returns
    // strands a proven link with no writer and no row. Mutation: bring
    // back an offer budget — the second offer is what F1 was about, and
    // there is no longer a number for it to be greater than one.
    const r = identRules(swift);
    expect(r.present).toBe(true);
    expect(r.capSeconds).toBe(2);
    expect(r.armsCapFirst).toBe(true);
    expect(r.settleOnce).toBe(true);
    expect(r.writeValues).toBe(1);
    expect(r.offerConstant).toBe(false);
    // One token, and it is the generation's own immutable id — not a
    // counter on the peer entry, which is the shape four rounds died on.
    expect(swift).toMatch(
      /private func settle\(_ token: Int, _ outcome: IdentOutcome\) \{\n\s*guard token == id, !identSettled else \{/,
    );
    expect(swift).not.toMatch(/peer\.identEpoch|peer\.identPending|peer\.identWrites/);
  });

  // ---------------------------------------------------------------- F1

  test('a dead transport RETIRES the link — it never borrows the read-only skip', () => {
    // THE FINDING, EXECUTED. e4b0923 read `per.state != .connected` as a
    // refusal, offered the same bytes down the same dead pipe a second
    // time, and settled `skipped` — which publishes. Plant that shape back
    // and this arm dies three ways: two offers, a voice-safe settle, and a
    // writer for a link that had already ended.
    const dead = runIdent(swift, { writable: true, connected: false, answer: 'silence' });
    expect(dead.deadPipeOffers).toBe(1);
    expect(dead.bytesOnAir).toBe(0);
    expect(dead.settled).toBe('dead');
    expect(dead.tornDown).toBe(true);
    expect(dead.publishes).toBe(0);
    expect(dead.writer).toBe(false);
    // …and `skipped` is not merely unused here, it is UNREACHABLE from the
    // transport road: it means "the pipe is up and nothing needed to go
    // down it", which is the compat road every field phone takes.
    const r = identRules(swift);
    expect(r.transportOutcome).not.toBe(r.readOnlyOutcome);
    expect(r.transportReoffers).toBe(false);
    expect(r.unsafe.has(r.transportOutcome)).toBe(true);
    expect(r.unsafe.has(r.readOnlyOutcome)).toBe(false);
  });

  test('the publish door re-asks the pipe, for the flip our own guard could not see', () => {
    // THE WINDOW THAT SURVIVES THE ABOVE. beginIdent's guard is a moment;
    // the completion is a later one, and CoreBluetooth can deliver our
    // write's answer with the disconnect callback still queued behind it.
    // Mutation: drop gen.transportConnected from publish and the module
    // gets a writer for a pipe that is already gone.
    const flipped = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'error',
      connectedAtCompletion: false,
    });
    expect(flipped.settled).toBe('failed');
    expect(flipped.publishes).toBe(0);
    expect(flipped.writer).toBe(false);
    // …and the same link with the pipe still up IS published, so the arm
    // above is testing the recheck and not an accident of the model.
    const held = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'error',
      connectedAtCompletion: true,
    });
    expect(held.settled).toBe('failed');
    expect(held.writer).toBe(true);
  });

  // ---------------------------------------------------------------- F2

  test('the accounting is EXECUTED: one completion walks 1 -> 0 and the door opens', () => {
    // THE MUTATION THAT SURVIVED THE LAST ROUND. Delete the
    // identOutstanding decrement in didWriteValueFor and every committed
    // arm stayed green, while the real link kept opsRemaining=1 and never
    // published a writer. The model now HOLDS the counter: it increments
    // where the Swift increments, decrements where the Swift decrements,
    // and the publish door asks the number.
    const r = identRules(swift);
    expect(r.incrementsBeforeWrite).toBe(true);
    expect(r.decrements).toBe(true);
    expect(r.publishNeedsZeroOps).toBe(true);
    const run = runIdent(swift, { writable: true, connected: true, answer: 'ack' });
    expect(run.opsSeen).toEqual([1, 0]);
    expect(run.opsRemaining).toBe(0);
    expect(run.settled).toBe('acknowledged');
    expect(run.publishes).toBe(1);
    expect(run.publishedAt).toBe('settle');
  });

  test('a DUPLICATE completion decrements once, settles once, publishes once', () => {
    // One write, two callbacks — the stack's prerogative, and the reason
    // the decrement is clamped and the settle is once-only. Mutation: make
    // the decrement bare (`-= 1`) and the counter goes negative, which no
    // later publish door can ever satisfy. Mutation: drop the once-only
    // guard and the link settles twice.
    const run = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'ack',
      duplicate: true,
    });
    expect(run.opsFloor).toBe(0);
    expect(run.opsRemaining).toBe(0);
    expect(run.settles).toBe(1);
    expect(run.publishes).toBe(1);
    expect(run.writer).toBe(true);
    expect(identRules(swift).decrementClamped).toBe(true);
  });

  test('the cap and a late acknowledgment race: the first settles, the loser is a no-op', () => {
    // BOTH ORDERINGS, RUN. The cap is two seconds and an acknowledgment is
    // a radio away, so either can be first, and exactly one of them may
    // decide what becomes of the link.
    const capWon = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'ack',
      capFirst: true,
    });
    expect(capWon.settles).toBe(1);
    expect(capWon.settled).toBe('expired');
    expect(capWon.tornDown).toBe(true);
    expect(capWon.publishes).toBe(0);
    expect(capWon.writer).toBe(false);
    // The late answer still arrives and decides nothing — NOT EVEN THE
    // COUNTER: didWriteValueFor guards !retired before it touches
    // identOutstanding, so after the cap's teardown the callback returns
    // with the number untouched. Retirement made it moot; an earlier
    // version of this arm claimed the late ack "accounts for itself" and
    // that story was false against the shipped guard order.
    expect(capWon.opsRemaining).toBe(1);
    expect(capWon.opsFloor).toBe(0);

    const ackWon = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'ack',
      capAfter: true,
    });
    expect(ackWon.settles).toBe(1);
    expect(ackWon.settled).toBe('acknowledged');
    expect(ackWon.tornDown).toBe(false);
    expect(ackWon.publishes).toBe(1);
  });

  test('the framework write is fenced, and a synchronous raise retires exactly once', () => {
    // THE FINDING (cross-family, 08:47Z): the IDENT bytes carry displayName
    // with no withResponse length guard, and CoreBluetooth raises
    // NSException synchronously on a too-large value or a characteristic
    // the stack already tore down. Bare, that raise skips settle, strands
    // the cap, and takes the process — the removeTapOnBus SIGABRT class.
    // Mutation: unwrap either writeValue and this arm names the line.
    const r = identRules(swift);
    expect(r.writeGuarded).toBe(true);
    expect(r.raiseUnwinds).toBe(true);
    expect(r.wroteChecksRetired).toBe(true);
    // No writeValue in this file rides bare: every call sits within two
    // code lines of its ObjCTry fence — the frame writer included.
    const lines = codeOnly(swift).split('\n');
    lines.forEach((l, i) => {
      if (/\bper\.writeValue\(/.test(l)) {
        expect(lines.slice(Math.max(0, i - 2), i + 1).join('\n')).toContain(
          'ObjCTry.run',
        );
      }
    });
    // EXECUTED: the raise path leaves ops 0, publishes 0, retires once,
    // and puts nothing on the air.
    const raised = runIdent(swift, {
      writable: true,
      connected: true,
      answer: 'silence',
      raises: true,
    });
    expect(raised.settles).toBe(1);
    expect(raised.settled).toBe('dead');
    expect(raised.tornDown).toBe(true);
    expect(raised.publishes).toBe(0);
    expect(raised.writer).toBe(false);
    expect(raised.opsRemaining).toBe(0);
    expect(raised.bytesOnAir).toBe(0);
  });

  test('the 2 s cap TEARS DOWN and never publishes', () => {
    // THE RECONCILIATION'S STRICTEST LINE, and it supersedes 9218b79's cap
    // which published anyway. An unsettled op means an acknowledged write
    // may still be in flight; a link whose ordering we have lost is not a
    // link to put a camper's voice on. Mutation: publish on expiry and the
    // module gets a writer for a link mid-exchange — the collision this
    // whole machine exists to prevent, arriving through its own floor.
    const run = runIdent(swift, { writable: true, connected: true, answer: 'silence' });
    expect(run.settled).toBe('expired');
    expect(run.opsRemaining).toBe(1);
    expect(run.publishes).toBe(0);
    expect(run.tornDown).toBe(true);
    const r = identRules(swift);
    expect(r.publishesWhenUnsafe).toBe(false);
    expect(r.tearsDownWhenUnsafe).toBe(true);
  });

  test('an acknowledged write publishes, and an ERROR publishes too', () => {
    // THE OUTAGE ARM. A peer that answers "writing is not permitted" has a
    // perfectly good link — it carries our voice and its own read proved
    // us. Mutation: tear down on the error and an upgrade becomes an
    // outage on every phone that has not taken it.
    const bad = runIdent(swift, { writable: true, connected: true, answer: 'error' });
    expect(bad.settled).toBe('failed');
    expect(bad.publishes).toBe(1);
    expect(bad.tornDown).toBe(false);
    // ONCE ACCEPTED, NO RETRY. Mutation: retry the error and a second
    // write goes out to collide with whatever the first one provoked.
    expect(bad.bytesOnAir).toBe(1);
    expect(identRules(swift).errorTearsDown).toBe(false);
  });

  test('the writer is published BY the settle, on five conditions', () => {
    // ORDERING THE CALL IS NOT ORDERING THE EXCHANGE — 9218b79's finding,
    // and the reason the write cannot simply sit above onPeer. The write
    // is ACKNOWLEDGED and asynchronous: source order would put the CALL
    // first and leave the EXCHANGE running, and a camper already holding
    // the button gets their first frame onto the same link.
    // Mutation: call onPeer from handleIdent again.
    const ident = swift.slice(swift.indexOf('fileprivate func handleIdent'));
    expect(ident).toMatch(/gen\.beginIdent\(identBytes\(\)\)/);
    const publish = braceBlock(swift, 'private func publish(_ gen: BleLinkGeneration, _ peer: VoicePeer) {');
    expect(publish).not.toEqual('');
    for (const cond of [
      '!gen.retired',
      'peer.link === gen',
      '!gen.ready',
      'gen.identProven',
      'gen.identVoiceSafe',
      'gen.identOpsRemaining == 0',
      'gen.transportConnected',
    ]) {
      expect(`${cond}:${publish.includes(cond)}`).toBe(`${cond}:true`);
    }
    // Mutation: publish from anywhere else. One door, and the settle is
    // what opens it.
    expect((swift.match(/publish\(gen, peer\)/g) ?? []).length).toBe(1);
    expect(swift).toMatch(/owner\?\.publishIfSettled\(self\)/);
  });

  test('identity is acknowledged, audio is not — and neither may drift', () => {
    // Mutation: swap either write type. An acknowledged voice frame stalls
    // the pipe into late audio, which is the walkie's one unforgivable
    // failure; an unacknowledged ident never settles and every link waits
    // out the cap and is torn down.
    const voice = braceBlock(swift, 'func write(_ frame: Data) {');
    expect(voice).toMatch(/type: \.withoutResponse/);
    expect(voice).not.toMatch(/withResponse\b(?!\w)/);
    const begin = braceBlock(swift, 'func beginIdent(_ bytes: Data) {');
    expect(begin).toMatch(/type: \.withResponse/);
    // And the ident bytes are minted in ONE place, so the read this rung
    // serves and the write it sends can never say different things.
    expect((swift.match(/private func identBytes\(\)/g) ?? []).length).toBe(1);
    expect((swift.match(/identBytes\(\)/g) ?? []).length).toBe(3);
  });
});

// ------------------------------------------- old phones and new, together

/**
 * THE COMPATIBILITY MATRIX, RUN. Four dials, each one asking the two
 * questions a field pod actually cares about: WHAT REACHED THE WIRE, and
 * DOES THE MODULE END UP HOLDING A WRITER. The reviewer's word for the
 * arms this replaces was source-shape assertions; these are four
 * executions of the same machine the Swift describes, and every row dies
 * on a different mutation.
 */
describe('every pairing the dust can produce this week', () => {
  const swift = readSource(SWIFT);

  test('new iPhone dials an OLD Android: read-only IDENT, nothing on the air, listed at the proof', () => {
    // Every build-44 iPhone and every 0.8.6 Android serves IDENT
    // read-only, and they are the phones in the dust this week. Mutation:
    // drop the properties check and the write is attempted — provoking a
    // framework precondition this project cannot catch, and delaying the
    // listing of a perfectly good link.
    const run = runIdent(swift, { writable: false, connected: true, answer: 'silence' });
    expect(run.bytesOnAir).toBe(0);
    expect(run.settled).toBe('skipped');
    expect(run.opsRemaining).toBe(0);
    expect(run.writer).toBe(true);
    expect(run.publishes).toBe(1);
    expect(run.publishedAt).toBe('proof');
    expect(run.tornDown).toBe(false);
  });

  test('new dials NEW: one acknowledged write, listed at the settle', () => {
    const run = runIdent(swift, { writable: true, connected: true, answer: 'ack' });
    expect(run.bytesOnAir).toBe(1);
    expect(run.settled).toBe('acknowledged');
    expect(run.opsSeen).toEqual([1, 0]);
    expect(run.writer).toBe(true);
    expect(run.publishes).toBe(1);
    expect(run.publishedAt).toBe('settle');
  });

  test('new dials a DEAD transport: nothing on the air, no writer, the link retires', () => {
    const run = runIdent(swift, { writable: true, connected: false, answer: 'silence' });
    expect(run.bytesOnAir).toBe(0);
    expect(run.deadPipeOffers).toBe(1);
    expect(run.settled).toBe('dead');
    expect(run.writer).toBe(false);
    expect(run.publishes).toBe(0);
    expect(run.publishedAt).toBe('');
    expect(run.tornDown).toBe(true);
  });

  test('an OLD phone dials US: it reads our IDENT, writes nothing, and nothing is listed for it', () => {
    // The reverse pairing, and the one the whole feature exists to make
    // unnecessary — an old central still gets our name in nine seconds off
    // the read, and we get nothing back, because it has no write to send.
    // Our side must publish NOTHING on its behalf: §5 lists a phone only
    // after OUR OWN read came back on OUR OWN link.
    const run = runServe(swift, ['read']);
    expect(run.onTheWire).toEqual(['ident-blob']);
    expect(run.rows).toBe(0);
    expect(run.writers).toBe(0);
    expect(run.memos).toBe(0);
    expect(run.dialsOffered).toBe(0);
  });

  test('a NEW phone dials us and says who it is: one ack out, one dial OFFERED, still no row', () => {
    // The write is a hint. It buys the far end a dial attempt through
    // maybeConnect and nothing else — no row, no writer, no memo.
    const run = runServe(swift, ['read', 'write']);
    expect(run.onTheWire).toEqual(['ident-blob', 'write-ack']);
    expect(run.rows).toBe(0);
    expect(run.writers).toBe(0);
    expect(run.memos).toBe(0);
    expect(run.dialsOffered).toBe(1);
  });
});

describe('an ident WRITE is a hint, never a row', () => {
  const swift = readSource(SWIFT);
  const inbound = braceBlock(swift, 'private func handleIdentWrite(_ id: UUID, _ value: Data) {');

  test('the far end learns who dialled it, and gains no standing by saying so', () => {
    // §5 DOES NOT MOVE. Mutation: mint a peer, or hand the module a writer
    // from here — a phone would be listed on a link WE never proved, which
    // is the one thing this rung is not allowed to do.
    expect(inbound).not.toEqual('');
    expect(inbound).not.toMatch(/onPeer\(|markReady|VoicePeer\(/);
    // Mutation: write the proof memo here. provenIdentity may only record
    // a peripheral a link of OURS was established from, and this write
    // establishes nothing of ours.
    expect(inbound).not.toMatch(/provenIdentity/);
    // Mutation: dial past maybeConnect. It owns every reason not to —
    // already ready, already dialling, inside the backoff, at the ceiling
    // — and this is a TRIGGER, never an exemption.
    expect(inbound).toMatch(/maybeConnect\(sender, id\)/);
    expect(inbound).not.toMatch(/BleLinkGeneration\(|\.connect\(/);
  });

  test('every gate the read path has, because a stranger can forge these bytes', () => {
    // Mutation: drop any one. The pod header is what keeps another camp's
    // walkie out; the self-check is our own reflection off a second radio
    // path; unknownSender names nobody and must not become a dial.
    expect(inbound).toMatch(/b\[0\] == 0x50, b\[1\] == 0x56,\n\s*be32\(b, 2\) == podHash/);
    expect(inbound).toMatch(/sender != senderHash, sender != Self\.unknownSender/);
    // A WRITTEN HASH MAY NEVER OVERRULE A PROVEN ONE. Mutation: drop this
    // and any central on that address can rename a peer OUR read proved.
    expect(inbound).toMatch(/\$0\.ready && \$0\.hash != sender/);
    expect(inbound).toContain('ident-write-reject');
  });

  test('our IDENT gains a write permission, and the READ is untouched', () => {
    // Mutation: drop the permission and every peer's write is refused —
    // the handshake exists on one side only, which is the shape that
    // teaches a bench the feature is broken when it is merely absent.
    // Mutation: change the read and every phone in the field goes dark.
    expect(swift).toMatch(
      /properties: \[\.read, \.write\],\n\s*value: nil,\n\s*permissions: \[\.readable, \.writeable\]/,
    );
    expect(swift).toMatch(/request\.value = b\.subdata\(in: request\.offset \.\.< b\.count\)/);
    // Mutation: let an ident write fall through to the frame path. A
    // 10-byte PV blob would be handed to the receive path as audio.
    expect(swift).toMatch(
      /if request\.characteristic\.uuid == Self\.identChar \{[\s\S]{0,300}handleIdentWrite\(request\.central\.identifier, v\)[\s\S]{0,60}continue/,
    );
  });

  test('the handshake names its decisions, on the phone that used to name none', () => {
    // Mutation: delete a verb and the next bench cannot tell a read-only
    // peer from a wedged one from a link torn down by its own cap, or from
    // one whose pipe was gone before a byte went out. iOS-only by design:
    // Android has no ident write to log.
    for (const verb of [
      'ident-write-in',
      'ident-write-out',
      'ident-write-fail',
      'ident-write-reject',
      'ident-settle',
      'ident-cap',
    ]) {
      expect(swift).toMatch(new RegExp(`vlog\\(\\s*\n?\\s*"${verb}[ "]`));
    }
    // The settle says WHICH outcome, or the line is a shrug — and the two
    // teardown roads are told apart at generationFailed, because "the cap
    // fired" and "the pipe was gone" are different benches.
    expect(swift).toMatch(/outcome=" \+ outcome\.rawValue/);
    expect(swift).toMatch(/reason=read-only/);
    expect(swift).toMatch(/reason=transport-dead/);
    expect(swift).toMatch(/outcome == \.expired \? "ident-cap" : "ident-transport"/);
  });
});

export {};
