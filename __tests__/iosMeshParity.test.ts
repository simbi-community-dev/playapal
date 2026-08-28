/**
 * iOS MESH FAST-PATH PARITY.
 *
 * The delivery clock in meshResponsiveness.test.ts is asserted entirely in
 * JS, against a radio.ts that calls BOTH of the fast-path hooks through
 * OPTIONAL guards. Guards are exactly the shape that passes a green suite
 * while one platform quietly keeps the slow cadence: `native?.setScanMode`
 * on a module that never exported it is not a failure, it is a no-op, and
 * an iPhone whose Swift server never emits CrewSyncServed simply waits out
 * its cooldown while the Android phone next to it does not. Nothing in a JS
 * harness can see either.
 *
 * So this suite reads the native sources, in the walkieCap idiom, and holds
 * the two modules to ONE contract:
 *
 *  - the reciprocity event exists, is named identically on both sides, is
 *    emitted at the same moment (the last digest frame, once per pull,
 *    after the response), and is a name JS actually listens for;
 *  - the scan posture is a stored, two-way knob on both sides — the frugal
 *    return arc asserted as hard as the fast direction, because that is the
 *    battery half of the bargain and the half a mutation deletes first;
 *  - and the iOS bridge's exported surface satisfies every call site radio.ts
 *    and meshSync.ts aim at the module, with zero JS changes.
 *
 * Each assertion names the mutation it dies on.
 */

// Suites are SCRIPTS, not modules: a top-level const is GLOBAL to the tsc
// program, so these names carry the suite prefix (see advertiserInPlace).
const readParitySrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const PARITY_KT = 'android/app/src/main/java/com/playapal/CrewBeaconModule.kt';
const PARITY_SWIFT = 'ios/PlayaPal/CrewBeacon.swift';
const PARITY_BRIDGE = 'ios/PlayaPal/CrewBeaconBridge.m';
const PARITY_RADIO = 'src/crews/radio.ts';
const PARITY_MESH = 'src/crews/meshSync.ts';
const PARITY_SHARE = 'src/crews/share.ts';

/**
 * THE CANONICAL SOURCE STRINGS, read ONCE.
 *
 * Every describe below used to open its own `readFileSync` of the same two
 * files — nine synchronous reads of CrewBeacon.swift in one suite, all of
 * them the same bytes, and each one a place where a describe could silently
 * end up measuring a different file from its neighbours. They are read here
 * and shared; a describe that needs something else still reads it itself.
 */
const PARITY_SWIFT_SRC = readParitySrc(PARITY_SWIFT);
const PARITY_KT_SRC = readParitySrc(PARITY_KT);

/**
 * A BRACE-MATCHED BODY — the signature (or any opening marker) through the
 * `}` that closes it, in Swift and Kotlin alike.
 *
 * WHY THIS EXISTS, and it is the reviewer's proof-hygiene finding on this
 * file. Every read below used to be a regex with a MAGIC CHARACTER WINDOW —
 * `[\s\S]{0,1400}`, `{0,2600}`, and one that was not bounded at all — and
 * both failure directions are silent:
 *
 *  - TOO SHORT and the reader stops before the sentence it is looking for.
 *    The Kotlin digest branch was already ~1361 characters against a 1400
 *    window; one more line of logging and a cured file reports as a file
 *    with no cure in it.
 *  - TOO LONG and the reader runs PAST the end of the thing it names. The
 *    `{0,2600}` window on `func endSession(` crossed into the next method,
 *    and the unbounded `[\s\S]*?` on Kotlin's `provideSyncMessages` could
 *    match a `promise.resolve` in a LATER function entirely — so the arm
 *    would pass on a file where the sentence had moved out of the body it
 *    is supposed to be in.
 *
 * Counting braces has neither failure. A MISSED marker returns the empty
 * string, on which every `toContain` passes happily, so every caller asserts
 * the body is non-empty first — that check is the reader's own liveness.
 */
const parityBody = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  if (at < 0) {
    return '';
  }
  const open = src.indexOf('{', at);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  return '';
};

/**
 * A SECTION BETWEEN TWO MARKERS, for the places a body is not brace-
 * delimited — a `switch` case, or the span between two `case` labels. Same
 * discipline: an unfound start or end returns empty, and callers check.
 */
const paritySection = (src: string, from: string, to: string, at = 0): string => {
  const start = src.indexOf(from, at);
  if (start < 0) {
    return '';
  }
  const end = src.indexOf(to, start + from.length);
  return end < 0 ? '' : src.slice(start, end);
};


/**
 * COMMENT-STRIPPED SOURCE, and this is the reader every structural claim
 * about the radio road is now built on.
 *
 * WHY, and it is the ruling's own finding on this file. `toContain('scanning
 * = false')` passes on a file where that text appears only inside the essay
 * ABOVE the line it describes — and this module's essays quote their own
 * code constantly, on purpose. A generic substring is therefore satisfiable
 * by a comment, which makes it a reader that cannot tell a cure from a
 * sentence about a cure. Deleting the real statement while leaving the
 * paragraph that explains it is not a hypothetical mutation; it is what
 * plant 77 does, one line further down.
 *
 * So: strip `//` and `/* … *\/` (nested), tracking string literals so that
 * `"crew//retire-step-raised"` and `"gatt-server//read-ok"` — this file is
 * full of them — are not mistaken for comments and eaten.
 */
const parityStrip = (src: string): string => {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
};

/** The real STATEMENTS of a span: comment-free, trimmed, blank lines gone. */
const parityStatements = (src: string): string[] =>
  parityStrip(src)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');

/**
 * A BODY's own statements — signature and closing brace removed. The first
 * statement ending in `{` is the line that OPENS the body (a one-line
 * signature, or the `) {` of a wrapped one); everything after it up to the
 * final `}` is what the function actually does.
 */
const parityBodyStatements = (body: string): string[] => {
  const stmts = parityStatements(body);
  const open = stmts.findIndex(line => line.endsWith('{'));
  return open < 0 ? [] : stmts.slice(open + 1, -1);
};

/** EXACTLY this statement, as a whole line of real code — never a substring
 *  and never a comment. */
const parityHasStatement = (body: string, statement: string): boolean =>
  parityStatements(body).includes(statement);

/**
 * THE RADIO ROAD, EXTRACTED ONCE.
 *
 * Six arms used to re-derive the same spans by hand — `paritySections(swift,
 * 'case .poweredOff:', 'emitState("Bluetooth is off")')` appeared four times,
 * character for character, and each copy was a place the next refactor could
 * rot independently. It is one function now, and the arms read fields off it.
 */
const parityRadioRoad = (swift: string) => {
  const reconcile = parityBody(swift, '  private func reconcileRadioState(');
  const retire = parityBody(swift, '  private func retireMeshScope(');
  return {
    reconcile,
    /** Where the shared radio fact is applied — exactly once, under a latch. */
    radioDown: parityBody(reconcile, 'if radioDown {'),
    retire,
    radioBranch: parityBody(retire, 'if scope != .mesh {'),
    everythingBranch: parityBody(retire, 'if scope == .everything {'),
    central: parityBody(swift, '  func centralManagerDidUpdateState('),
    peripheral: parityBody(swift, '  func peripheralManagerDidUpdateState('),
    driveScan: parityBody(swift, '  private func driveScan('),
    driveAdvertise: parityBody(swift, '  private func driveAdvertise('),
    policy: parityBody(swift, '  private static func radioPolicy(for state: CBManagerState)'),
    settleScan: parityBody(swift, '  private func settleScan('),
    settleAdvertise: parityBody(swift, '  private func settleAdvertise('),
  };
};

/** Every bridge entry that touches scan or advertise state. */
const PARITY_RADIO_BRIDGE = [
  '  func startScan(',
  '  func stopScan(',
  '  func setScanMode(',
  '  func startAdvertising(',
  '  func stopAdvertising(',
  '  func setPayload(',
];

/** A statement with its string literals blanked — a field NAME quoted
 *  inside a log line or a reject code is not a field ACCESS. */
const parityCode = (line: string): string => line.replace(/"(?:[^"\\]|\\.)*"/g, '""');

/**
 * EVERY FIELD ONE QUEUE OWNS. A bridge method that touches any of these
 * before it hops has already raced the CoreBluetooth callbacks.
 */
const PARITY_CONFINED_FIELD =
  /\b(wantScanning|wantAdvertising|scanning|advertising|startScanPromise|startAdvertisePromise|centralManager|peripheralManager|payload|serviceAdded|scanLowLatency|rescanTimer|clearRetired|reconcileRadioState|beginScan|settleScan|settleAdvertise|emitState)\b/;

/**
 * IS EVERY BRIDGE ENTRY A SHELL OVER THE OWNER QUEUE?
 *
 * Not "does the file mention onBle somewhere near it": the hop must come
 * before any statement that reads or writes confined state. What is allowed
 * to precede it is argument validation — decoding the caller's own base64,
 * rejecting a malformed one — because those statements touch nothing the
 * radio owns and hopping to reject a typo would be ceremony. Anything else
 * before the hop is a write on React Native's `_sharedModuleQueue` while
 * the callbacks are writing the same field on main, which is the race.
 */
const parityBridgeIsConfined = (swift: string): boolean =>
  PARITY_RADIO_BRIDGE.every(sig => {
    const stmts = parityBodyStatements(parityBody(swift, sig));
    const at = stmts.indexOf('onBle { [weak self] in');
    return at >= 0 && stmts.slice(0, at).every(line => !PARITY_CONFINED_FIELD.test(parityCode(line)));
  });

/**
 * IS THE PROMISE SETTLED ONLY FROM THE OWNER'S HELPERS?
 *
 * Returns every statement that settles one of the two bridge promises by
 * hand. It must be empty: `settleScan` / `settleAdvertise` are the only two
 * roads, both run on the owner queue, and both clear the record before they
 * call out. A settlement written anywhere else is a settlement on whatever
 * queue that line happens to run on.
 */
const parityDirectSettles = (swift: string): string[] =>
  parityStatements(swift).filter(line =>
    /^start(Scan|Advertise)Promise\?\.(resolve|reject)\(/.test(line),
  );

/**
 * IS EACH MANAGER CALLBACK A TRIGGER AND NOTHING ELSE?
 *
 * The exact statement list, because "contains reconcileRadioState" would
 * pass on a callback that ALSO retires the radio out of its own stale event
 * body — which is the cross-manager defect itself.
 */
const parityCallbackIsTrigger = (body: string, manager: string, arg: string): boolean => {
  const stmts = parityBodyStatements(body);
  return (
    stmts.length === 3 &&
    stmts[0] === `let name = Self.stateName(${arg}.state)` &&
    stmts[1] === `NSLog("crew//radio-event manager=${manager} state=\\(name)")` &&
    stmts[2] === `reconcileRadioState("${manager}:\\(name)")`
  );
};

/**
 * THE STATE TABLE, READ OUT OF THE SOURCE.
 *
 * Every `case` in `radioPolicy` maps to what it returns. An absent state is
 * the `default: break` shape — the road on which a promise is never
 * settled at all — so the arms below drive their model from THIS map rather
 * than from a boolean saying the table "looks complete".
 */
const parityStateTable = (swift: string): Record<string, string> => {
  const stmts = parityBodyStatements(parityBody(swift, '  private static func radioPolicy(for state: CBManagerState)'));
  const table: Record<string, string> = {};
  let at = '';
  for (const line of stmts) {
    const label = /^case \.([A-Za-z]+):$/.exec(line);
    if (label) {
      at = label[1];
      continue;
    }
    if (line === '@unknown default:') {
      at = 'unrecognised';
      continue;
    }
    if (at === '' || !line.startsWith('return ')) {
      continue;
    }
    if (line === 'return .run') {
      table[at] = 'run';
    } else if (line === 'return .hold') {
      table[at] = 'hold';
    } else {
      const code = /^return \.terminal\(code: "([a-z-]+)"/.exec(line);
      table[at] = code ? `reject:${code[1]}` : 'reject:?';
    }
    at = '';
  }
  return table;
};

/**
 * The iOS module's real JS-visible surface: RCT_EXTERN_METHOD is what
 * actually reaches NativeModules.CrewBeacon, so the bridge file — not a
 * hand-written mock, and not the Swift @objc annotations — is the honest
 * source for "what an iPhone answers to".
 */
const paritySwiftExports = (src: string): string[] => {
  const re = /RCT_EXTERN_METHOD\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(src);
  while (m) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
};

/** Every method the crew JS calls on the native module. */
const parityCallSites = (src: string): string[] => {
  const re = /\bnative[?]?\.([A-Za-z][A-Za-z0-9]*)\s*\(/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(src);
  while (m) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
};

describe('CrewSyncServed is one event with one meaning on both phones', () => {
  const kt = readParitySrc(PARITY_KT);
  const swift = readParitySrc(PARITY_SWIFT);
  const radio = readParitySrc(PARITY_RADIO);

  test('both servers declare the same event name JS listens for', () => {
    // Mutation: rename either constant. The emitter keeps emitting, the
    // listener keeps listening, and they never meet — a dial-back that
    // silently never happens on one platform.
    expect(kt).toMatch(/SYNC_SERVED_EVENT = "CrewSyncServed"/);
    expect(swift).toMatch(/syncServedEvent = "CrewSyncServed"/);
    expect(radio).toMatch(/'CrewSyncServed'/);
  });

  test('the Swift emitter declares the event, or RN drops it on the floor', () => {
    // Mutation: leave syncServedEvent out of supportedEvents(). RCTEventEmitter
    // warns once into a device log nobody is reading at 3am and discards
    // every send — the hook looks implemented and does nothing.
    const supported = parityBody(swift, 'override func supportedEvents(');
    expect(supported).not.toBe('');
    expect(supported).toMatch(/Self\.syncServedEvent/);
  });

  test('both fire on the LAST digest frame, once per completed pull', () => {
    // Mutation: emit on every read instead of at the end of the stream.
    // A multi-frame digest becomes a burst of dial-backs at whoever is
    // pulling from us — the connect storm NUDGE_MIN_GAP_MS exists to
    // prevent, arriving from below it.
    expect(kt).toMatch(/digestServed = cur \+ 1 >= total/);
    expect(swift).toMatch(/digestServed = cur \+ 1 >= total/);
    // ...and both compute it inside the offset==0 build, so the MTU
    // continuations of one frame never re-fire it. iOS negotiates a ~185
    // byte MTU against our 484-byte frames, so this is three chances to
    // double-fire on every single pull.
    //
    // READ AS THE BRANCH IT IS rather than through a character window: the
    // Kotlin body was already 1361 characters against a 1400-character
    // window, so the next line of logging would have reported the cured
    // file as one with no cure in it.
    const ktDigest = parityBody(kt, 'DIGEST_CHAR -> synchronized(syncLock) {');
    expect(ktDigest).not.toBe('');
    expect(parityBody(ktDigest, 'if (offset == 0) {')).toContain(
      'digestServed = cur + 1 >= total',
    );
    const swiftDigest = paritySection(swift, 'case Self.digestChar:', 'case Self.msgChar:');
    expect(swiftDigest).not.toBe('');
    expect(parityBody(swiftDigest, '} else if request.offset == 0 {')).toContain(
      'digestServed = cur + 1 >= total',
    );
  });

  test('both emit AFTER answering the read, never before', () => {
    // Mutation: emit before sendResponse/respond. The bridge hop now sits
    // in front of the GATT response, so the reciprocity optimisation makes
    // the very read it is optimising slower — and on iOS a peripheral that
    // dawdles inside didReceiveRead is the one that gets timed out.
    const ktResponse = kt.indexOf('GATT_SUCCESS, offset, value');
    const ktEmit = kt.indexOf('emit(SYNC_SERVED_EVENT');
    expect(ktResponse).toBeGreaterThan(-1);
    expect(ktEmit).toBeGreaterThan(ktResponse);

    const swiftResponse = swift.indexOf('respond(to: request, withResult: .success)');
    const swiftEmit = swift.indexOf('withName: Self.syncServedEvent');
    expect(swiftResponse).toBeGreaterThan(-1);
    expect(swiftEmit).toBeGreaterThan(swiftResponse);
  });

  test('the event carries an id and a routing flag, and no content', () => {
    // Mutation: attach digest bytes or message ids "for debugging". This
    // event crosses no consent boundary today precisely because it is a
    // bare peer id plus one boolean; content on it would leak a mailbox to
    // any stranger who can read a characteristic.
    // The emit moved OUT of the send's critical section when the send became
    // retirement-atomic (the bridge rule: nothing crosses to JS under
    // syncLock), so the block is named by the flag the send carries out.
    const ktServed = parityBody(kt, 'if (servedDialable) {');
    expect(ktServed).not.toBe('');
    expect(ktServed).toContain('m.putString("peerId", addr)');
    expect(ktServed).toMatch(
      /m\.putBoolean\("dialable", true\)\s*\n\s*emit\(SYNC_SERVED_EVENT, m\)/,
    );
    // Nothing else rides it. A body assertion cannot say "and no more
    // fields", so the field list is read out of the block itself.
    expect(ktServed.match(/m\.put[A-Za-z]+\(/g)).toEqual(['m.putString(', 'm.putBoolean(']);
    expect(swift).toMatch(
      /withName: Self\.syncServedEvent,\s*\n\s*body: \["peerId": central\.uuidString, "dialable": false\]\s*\n\s*\)/,
    );
  });

  test('only the platform whose served id IS an address claims dialable', () => {
    // THE ONE-WAY MIRROR (mesh lane, 2026-08-26). An iPhone holding its
    // crew beacon for the walkie is undiscoverable, so the address it
    // connects FROM is the only route an Android has to its mailbox — and
    // on Android that address is dialable, in the same space the scanner
    // reports. On iOS the same field is a CBCentral identifier, which
    // retrievePeripherals cannot take.
    //
    // Mutation: flip either literal. Setting iOS true makes meshSync queue
    // an undialable UUID and burn the native sync mutex on it; setting
    // Android false restores the eight-minute mail exactly.
    expect(kt).toMatch(/putBoolean\("dialable", true\)/);
    expect(kt).not.toMatch(/putBoolean\("dialable", false\)/);
    expect(swift).toMatch(/"dialable": false/);
    expect(swift).not.toMatch(/"dialable": true/);
  });
});

describe('the scan posture is a two-way knob on both phones', () => {
  const kt = readParitySrc(PARITY_KT);
  const swift = readParitySrc(PARITY_SWIFT);

  test('both modules default to the FRUGAL posture', () => {
    // Mutation: default either to the fast posture. A phone that never
    // hears from JS — sharing off, a build where the guard is dropped —
    // then burns the low-latency duty cycle forever, which at BRC is the
    // battery the owner needs at 3am, spent on nobody.
    expect(kt).toMatch(/private var scanLowLatency = false/);
    expect(swift).toMatch(/private var scanLowLatency = false/);
  });

  test('the duty cycle READS the stored posture instead of a literal', () => {
    // Mutation: hardcode the fast setting back into the scan call. The
    // stored posture becomes decoration, and setScanMode(false) — the
    // background and stop arcs both — quietly does nothing.
    expect(kt).toMatch(
      /if \(scanLowLatency\) ScanSettings\.SCAN_MODE_LOW_LATENCY[\s\S]{0,80}SCAN_MODE_BALANCED/,
    );
    expect(swift).toMatch(
      /CBCentralManagerScanOptionAllowDuplicatesKey: self\.scanLowLatency/,
    );
    // The literal `true` this replaced must not survive anywhere: the
    // module scanned with duplicates unconditionally on before this lane.
    expect(swift).not.toMatch(/CBCentralManagerScanOptionAllowDuplicatesKey: true/);
  });

  test('one scan bring-up serves both the start path and the flip', () => {
    // Mutation: give the posture flip its own scanForPeripherals call. The
    // two copies drift, and the one nobody is testing is the one that runs
    // for the twelve hours the phone is in a pocket.
    expect(kt).toMatch(/private fun startScanInternal\(/);
    expect(swift).toMatch(/private func beginScan\(_ central: CBCentralManager\)/);
    const flipBody = parityBody(swift, '  func setScanMode(');
    expect(flipBody).not.toBe('');
    expect(flipBody).toContain('self.beginScan(central)');
    // The CENTRAL's `.run` road, which is the one that owns the scan. It is
    // no longer a branch of the callback — the callback is a trigger and the
    // effect lives in the reconciler's scan half — so it is read there.
    const centralOn = parityRadioRoad(swift).driveScan;
    expect(centralOn).not.toBe('');
    // …and it INSPECTS what the bring-up returned. `beginScan` reports the
    // ObjCTry raise rather than swallowing it, so the statement that calls
    // it is the statement that binds it; a driveScan that went back to a
    // bare call would be resolving the asker over a scan that never started.
    expect(parityHasStatement(centralOn, 'if let raised = beginScan(central) {')).toBe(true);
  });

  test('a flip while scanning does not report the radio as interrupted', () => {
    // Mutation: emitState() between the stop and the restart. `scanning`
    // is momentarily false, session.ts's honesty machine reads a radio
    // interruption, and the pod card tells the truth about a lie — the
    // "knows and does not say" bug's mirror image.
    const flip = parityBody(swift, '  func setScanMode(');
    expect(flip).not.toBe('');
    expect(flip).not.toMatch(/emitState\(/);
  });

  test('iOS keeps re-reporting peers in the frugal posture', () => {
    // THE PLATFORM ASYMMETRY, and the mutation that looks like a cleanup:
    // delete the rescan tick and let frugal be a plain `allowDuplicates:
    // false`. Android's BALANCED still reports a peer it has already seen;
    // CoreBluetooth's duplicates-off reports each peripheral ONCE per scan
    // session and then never again. Every backgrounded iPhone's podmates
    // would age out of presence's live window while the radio was still
    // hearing them perfectly — fidelity degrading into MEMBERSHIP, which
    // docs/WALKIE-LADDER.md §1 forbids in as many words.
    expect(swift).toMatch(/private static let frugalRescanInterval: TimeInterval = 30/);
    expect(swift).toMatch(/private func armRescan\(\)/);
    expect(swift).toMatch(/guard !scanLowLatency else \{ return \}/);
    // It re-reports by stop+start, because that is the only thing that
    // makes CoreBluetooth surface an already-discovered peripheral again.
    const arm = parityBody(swift, '  private func armRescan(');
    expect(arm).not.toBe('');
    // Stop then start, in that order, each under its own ObjCTry step (the
    // transitive-coverage rule: a tick is reachable from a live radio).
    const tick = parityStatements(arm);
    expect(tick).toContain('self.guardedStep("stopScan", "rescan-tick") { central.stopScan() }');
    expect(tick.indexOf('self.guardedStep("scanForPeripherals", "rescan-tick") {')).toBeGreaterThan(
      tick.indexOf('self.guardedStep("stopScan", "rescan-tick") { central.stopScan() }'),
    );
  });

  test('the tick dies with the scan on every arc that stops it', () => {
    // Mutation: forget one cancelRescan(). A repeating timer outlives the
    // session that justified it and pokes a stopped — or powered-off —
    // central twice a minute for as long as the app lives.
    // A LENGTH-BOUNDED READER IS A READER THAT GOES SILENT WHEN THE BODY
    // GROWS — and this arm was already living on borrowed time: `stopAll`
    // grew into the sharing session's barrier and its bound had to be
    // guessed upward once, and the retirement has since moved OUT of it
    // into the one function every death road calls. A guessed bound's next
    // miss reports the cured file as one with no cancel in it at all, so
    // the bodies are brace-matched now.
    const stopScan = parityBody(swift, '  func stopScan(');
    expect(stopScan).not.toBe('');
    expect(stopScan).toMatch(/cancelRescan\(\)/);
    // stopAll cancels the tick THROUGH the retirement, which is the point
    // of there being one list: a road that forgets a step is now a road
    // that forgot to retire at all, which is a much louder mistake.
    const stopAll = parityBody(swift, '  func stopAll(');
    expect(stopAll).not.toBe('');
    expect(stopAll).toContain('retireBeforeReturning(');
    const retire = parityBody(swift, '  private func retireMeshScope(');
    expect(retire).not.toBe('');
    expect(retire).toMatch(/cancelRescan\(\)/);
    // …and the RADIO road cancels it too. There are no longer two poweredOff
    // arcs to enumerate: both managers' callbacks are triggers, and the ONE
    // place the radio's death is acted on is the reconciler — which cancels
    // the tick off the CENTRAL's own state, never off the other manager's
    // stale event.
    const road = parityRadioRoad(swift);
    expect(road.reconcile).not.toBe('');
    expect(parityHasStatement(road.radioDown, 'retireMeshScope(reason: "radio down", scope: .radio)')).toBe(
      true,
    );
    expect(parityHasStatement(road.reconcile, 'if !centralUp {')).toBe(true);
    expect(parityHasStatement(road.reconcile, 'cancelRescan()')).toBe(true);
  });

  test('the tick is cancelled on the thread that installed it', () => {
    // Mutation: collapse cancelRescan to a bare invalidate(). The timer is
    // installed on main (beginScan runs on the CoreBluetooth queue) but
    // stopScan and stopAll arrive on React Native's method queue, and
    // Foundation's contract is that a Timer is invalidated from its own
    // thread or not at all. The failure is silent and is exactly the leak
    // the test above believes it already closed.
    const cancel = parityBody(swift, '  private func cancelRescan(');
    expect(cancel).not.toBe('');
    expect(cancel).toContain('Thread.isMainThread');
    // armRescan cancels INLINE — it is already on main, so the guard above
    // takes the synchronous path. Defer it and the cancel would land after
    // the scheduledTimer below and kill the timer it had just installed.
    expect(swift).toMatch(/private func armRescan\(\) \{\n {4}cancelRescan\(\)/);
  });
});

describe('the iOS module satisfies the JS call sites with zero JS changes', () => {
  const bridge = readParitySrc(PARITY_BRIDGE);
  const exported = paritySwiftExports(bridge);

  test('every crew call site is an exported iOS method', () => {
    // Mutation: implement setScanMode in Swift and forget the bridge line.
    // @objc alone does not reach JS — the module answers to nothing new,
    // radio.ts's optional guard swallows it, and the iPhone keeps the slow
    // cadence exactly as it did before the work.
    const wanted = new Set([
      ...parityCallSites(readParitySrc(PARITY_RADIO)),
      ...parityCallSites(readParitySrc(PARITY_MESH)),
    ]);
    // Phase C's foreground service is Android's; the iOS module keeps
    // no-op twins so JS can call them unconditionally, and they ARE
    // exported — so nothing is exempt here.
    const missing = [...wanted].filter(n => !exported.includes(n));
    expect(missing).toEqual([]);
    expect(wanted.has('setScanMode')).toBe(true);
  });

  test('the posture knob is bridged as a BOOL, matching Kotlin', () => {
    // Mutation: bridge it as NSNumber/NSString. RN would hand Swift a type
    // it cannot coerce and the call rejects at runtime — inside a try/catch
    // that exists to survive a dead radio, so the failure is invisible.
    expect(bridge).toMatch(/RCT_EXTERN_METHOD\(setScanMode:\(BOOL\)lowLatency/);
    expect(readParitySrc(PARITY_KT)).toMatch(/fun setScanMode\(lowLatency: Boolean/);
  });
});

// ---------------------------------------------------------------- the answer
//
// THE ANSWER IS MATCHED TO ITS QUESTION, ON BOTH PHONES.
//
// A want's answer used to be addressed to a PEER. A peer is a name and the
// name outlives the ask, so a reply computed for one request installed
// against whatever that central had open when it finally arrived — its own
// next want, or a want belonging to the session that replaced the one being
// answered. iOS installed by peer with nothing consulted at all; Android
// matched by ARRIVAL ORDER, which reads as the right answer exactly while
// every want is answered, in order, by a session that is still alive.
//
// Neither half can be driven from a JS harness — one is Swift, the other
// Kotlin — so they are held here the way this file holds every other
// cross-platform contract: by reading both modules and requiring the same
// sentence out of each. Each assertion names the mutation it dies on, and
// every one of them is a real plant under tools/plants/airtime.

describe('a want is answered by name, on both phones', () => {
  const kt = readParitySrc(PARITY_KT);
  const swift = readParitySrc(PARITY_SWIFT);
  const bridge = readParitySrc(PARITY_BRIDGE);
  const mesh = readParitySrc(PARITY_MESH);

  test('the event carries the request identity on both servers', () => {
    // Mutation: emit peer and bytes only. Everything below is then a match
    // against a value JS never had, which is a match that cannot be made.
    expect(kt).toMatch(/m\.putDouble\("requestId", ready\.requestId\.toDouble\(\)\)/);
    expect(kt).toMatch(/m\.putDouble\("serverEpoch", ready\.serverEpoch\.toDouble\(\)\)/);
    expect(swift).toMatch(/"requestId": NSNumber\(value: wantTicketSeq\)/);
    expect(swift).toMatch(/"serverEpoch": NSNumber\(value: digestEpoch\)/);
  });

  test('the answering verb takes the identity on both natives', () => {
    // THE 4-ARG CALL SITE, on the JS side and on both native surfaces, in
    // the SAME argument order — RN maps the call positionally, so a Kotlin
    // module that declared (peerId, b64, requestId, serverEpoch) would take
    // the bytes as an id and the id as the bytes, silently.
    //
    // Mutation: restore the two-argument shape on either side. JS then has
    // nowhere to put the identity it carried, and the server has nothing to
    // match with.
    expect(mesh).toMatch(
      /native\.provideSyncMessages\(\s*peerId,\s*requestId,\s*serverEpoch,\s*bytesToB64\(bytes\),\s*\)/,
    );
    expect(kt).toMatch(
      /fun provideSyncMessages\(\s*peerId: String,\s*requestId: Double,\s*serverEpoch: Double,\s*b64: String,/,
    );
    expect(bridge).toMatch(
      /RCT_EXTERN_METHOD\(provideSyncMessages:\(NSString \*\)peerId\s*\n\s*requestId:\(nonnull NSNumber \*\)requestId\s*\n\s*serverEpoch:\(nonnull NSNumber \*\)serverEpoch\s*\n\s*payload:\(NSString \*\)b64/,
    );
    // …and the Swift selector must agree with the bridge line above, or the
    // module answers to a selector nothing sends.
    expect(swift).toMatch(
      /@objc\(provideSyncMessages:requestId:serverEpoch:payload:resolver:rejecter:\)/,
    );
    // The bridge is also the JS-visible surface this suite already checks
    // for every call site: the verb must still be exported at all.
    expect(paritySwiftExports(bridge)).toContain('provideSyncMessages');
  });

  test('the install matches the EXACT open request, never the peer', () => {
    // PLANT (a)'s NATIVE HALF. Mutation: install by peer again
    // (`msgBuffers[id] = data` with nothing consulted on iOS; the oldest
    // ticket popped positionally on Android). A delayed answer then fills
    // whatever that central has open now — including a request belonging to
    // the session that replaced the one being answered.
    //
    // iOS: one open request per central, compared by id.
    expect(swift).toMatch(/private var openWant: \[UUID: OpenWant\] = \[:\]/);
    expect(swift).toMatch(/openWant\[central\] = OpenWant\(id: wantTicketSeq,/);
    expect(swift).toMatch(/refusal = "no-open-request"/);
    expect(swift).toMatch(/open!\.id != askedId \{?\s*\n?\s*refusal = "stale-request"/);
    // …and the install is REACHED only past that ladder, never before it.
    const swiftInstall = swift.indexOf('self.msgBuffers[id] = data');
    const swiftMatch = swift.indexOf('refusal = "stale-request"');
    expect(swiftMatch).toBeGreaterThan(-1);
    expect(swiftInstall).toBeGreaterThan(swiftMatch);

    // Android: the ticket is found BY ID, and the match is refused unless it
    // is the newest outstanding one for that central.
    expect(kt).toMatch(/return tickets\.indexOfFirst \{ it\.id == requestId \}/);
    expect(kt).toMatch(/val at = wantTicketIndex\(peerId, askedId\)/);
    expect(kt).toMatch(/at < 0 \|\| tickets == null -> "unsolicited"/);
    expect(kt).toMatch(/at != tickets\.size - 1 -> \{[\s\S]{0,120}"superseded"/);
    // The positional pop is GONE from the answering path, not merely
    // unused: a helper left standing is a road back. (`removeAt(0)` still
    // has one honest home — the outstanding-wants cap, which drops the
    // OLDEST ask when a central banks more than four. That one is about how
    // many questions a peer may hold open, not about which one an answer
    // belongs to.)
    expect(kt).not.toMatch(/fun takeWantTicket\(/);
    // BRACE-MATCHED, not `[\s\S]*?`. The unbounded lazy window this
    // replaced would happily run past the end of provideSyncMessages to
    // find a `promise.resolve` in some LATER function — so the arm passed
    // on a file where the sentence it names had moved out of the body it is
    // supposed to be in, which is the failure this whole suite exists to
    // catch on the other side of a bridge.
    const ktProvide = parityBody(kt, '  fun provideSyncMessages(');
    expect(ktProvide).not.toBe('');
    expect(ktProvide).toContain('promise.resolve(refusal)');
    expect(ktProvide).not.toMatch(/removeAt\(0\)/);
    expect(ktProvide).toMatch(/wantTicketIndex\(peerId, askedId\)/);
  });

  test('the answer must name the epoch this phone publishes NOW', () => {
    // PLANT (c). Mutation: drop the epoch comparison and keep only the id.
    // Ids are per-process and a restart does not reset them, so an answer
    // from before a restart still names an id — the epoch is what says
    // WHICH OFFER it was computed against, and a want built from a digest
    // this phone has since replaced is answering a question nobody asked.
    expect(swift).toMatch(/askedEpoch != self\.digestEpoch \|\|/);
    expect(swift).toMatch(/open!\.epoch != self\.digestEpoch \|\|/);
    expect(swift).toMatch(/open!\.rev != self\.digestRev \{?\s*\n?\s*refusal = "stale-epoch"/);
    expect(kt).toMatch(/tickets\[at\]\.epoch != digestEpoch \|\|/);
    expect(kt).toMatch(/tickets\[at\]\.rev != digestRev \|\|/);
    expect(kt).toMatch(/askedEpoch != digestEpoch ->/);
  });

  test('a stop invalidates every outstanding request id, permanently', () => {
    // PLANT (b). Mutation: clear the outstanding requests without the
    // watermark. That refusal lasts only until the same central asks again
    // — then there IS an open request, and the reply that has been sitting
    // on the bridge since before the stop takes it. The line is what makes
    // the refusal a property of the ID rather than of what happens to be
    // outstanding, and both counters are monotonic over the PROCESS so a
    // pre-stop id can never be minted again.
    expect(swift).toMatch(/private var wantInvalidBefore: Int64 = 0/);
    expect(swift).toMatch(
      /private func invalidateOpenWants\(\) \{\n {4}wantInvalidBefore = wantTicketSeq\n {4}openWant\.removeAll\(\)\n {2}\}/,
    );
    expect(swift).toMatch(/askedId <= self\.wantInvalidBefore \{\n\s*refusal = "invalidated"/);
    expect(kt).toMatch(/private var wantInvalidBefore = 0L/);
    expect(kt).toMatch(
      /private fun invalidateWantTickets\(\) \{\n {4}wantInvalidBefore = wantTicketSeq\n {4}wantTickets\.clear\(\)\n {2}\}/,
    );
    expect(kt).toMatch(/askedId <= wantInvalidBefore -> "invalidated"/);
    // …and it is what BOTH stop verbs do, on both phones. endSession is the
    // one a walkie open/close fires dozens of times an evening; the other is
    // the sharing barrier.
    //
    // BRACE-MATCHED, and the old windows were wrong in BOTH directions: the
    // `{0,2600}` on `func endSession(` ran past the end of that method into
    // the next one, so it was reading a neighbour's sentences as endSession's
    // own. On iOS the list now lives in the one retirement function every
    // death road calls, so the read is: endSession routes there, and there
    // is where the invalidation happens.
    const swiftEnd = parityBody(swift, '  func endSession(');
    expect(swiftEnd).not.toBe('');
    expect(swiftEnd).toContain('retireBeforeReturning(reason: "session ended", scope: .mesh)');
    const swiftRetire = parityBody(swift, '  private func retireMeshScope(');
    expect(swiftRetire).not.toBe('');
    expect(swiftRetire).toContain('dropAllCentralState()');
    const swiftDropAll = parityBody(swift, '  private func dropAllCentralState(');
    expect(swiftDropAll).not.toBe('');
    expect(swiftDropAll).toContain('invalidateOpenWants()');
    const ktEnd = parityBody(kt, '  fun endSession(');
    expect(ktEnd).not.toBe('');
    expect(ktEnd).toContain('invalidateWantTickets()');
    const ktStopServer = parityBody(kt, '  private fun stopGattServer(');
    expect(ktStopServer).not.toBe('');
    expect(ktStopServer).toContain('invalidateWantTickets()');
    // …and the bare clear is not still the thing a stop does INSTEAD: the
    // only place the ticket book is emptied is inside the helper that draws
    // the line. A second clear anywhere else is a stop that forgets without
    // invalidating, which is the defect wearing the cure's clothes.
    expect((kt.match(/wantTickets\.clear\(\)/g) ?? []).length).toBe(1);
    expect((swift.match(/openWant\.removeAll\(\)/g) ?? []).length).toBe(1);
  });

  test('the message characteristic cannot serve a buffer from before a stop', () => {
    // PLANT (d). The refusal above stops a stale answer being INSTALLED;
    // this is the other end — the bytes a previous answer already installed
    // must not still be readable once the requests they answered are dead.
    // Mutation: leave the served buffers standing through the stop and the
    // central's next MSG_CHAR read is answered from the dead session's
    // mailbox, which is the exact thing the not-ready frame exists to
    // prevent it doing.
    // Brace-matched bodies, in the order the clearing has to happen: the
    // buffers go, and the questions they answered are invalidated with them.
    const swiftDrop = parityBody(swift, '  private func dropAllCentralState(');
    expect(swiftDrop).not.toBe('');
    expect(swiftDrop.indexOf('msgBuffers.removeAll()')).toBeGreaterThan(-1);
    expect(swiftDrop.indexOf('invalidateOpenWants()')).toBeGreaterThan(
      swiftDrop.indexOf('msgBuffers.removeAll()'),
    );
    // …and the frame each read hands back is cleared with them, or the last
    // frame of a dead stream is still sitting in the characteristic.
    expect(swiftDrop).toContain('msgFrame.removeAll()');
    // On iOS every stop road reaches that helper through the one retirement.
    expect(parityBody(swift, '  private func retireMeshScope(')).toContain(
      'dropAllCentralState()',
    );
    const ktEndBody = parityBody(kt, '  fun endSession(');
    expect(ktEndBody).not.toBe('');
    expect(ktEndBody.indexOf('msgBuffers.clear()')).toBeGreaterThan(-1);
    expect(ktEndBody.indexOf('invalidateWantTickets()')).toBeGreaterThan(
      ktEndBody.indexOf('msgBuffers.clear()'),
    );
    expect(ktEndBody).toContain('msgFrame.clear()');
    const ktStop = parityBody(kt, '  private fun stopGattServer(');
    expect(ktStop).not.toBe('');
    expect(ktStop.indexOf('msgBuffers.clear()')).toBeGreaterThan(-1);
    expect(ktStop.indexOf('invalidateWantTickets()')).toBeGreaterThan(
      ktStop.indexOf('msgBuffers.clear()'),
    );
  });

  test('a refusal is a named reason both phones hand back to JS', () => {
    // A refusal nothing can read is a want that went unserved in silence,
    // which is the shape this whole class hid in. Both modules resolve the
    // reason rather than resolving null; meshSync logs it against the want.
    // Mutation: resolve null on refusal and the seam goes quiet again.
    expect(kt).toMatch(/promise\.resolve\(refusal\)/);
    expect(swift).toMatch(/guard refusal == nil else \{\n\s*resolve\(refusal\)/);
    expect(mesh).toMatch(/want-refused \$\{peerId\} req=\$\{requestId\} reason=\$\{refusal\}/);
  });
});

// -------------------------------------------------- the world going away
//
// A PRODUCTION APPEARANCE CHANGE IS A BRIDGE TEARDOWN, and no JS runs on it.
//
// SettingsScreen's theme control reloads the React instance (ThemeReload).
// Every module is invalidated; `stopMeshSync`, `endSession` and `stopAll` are
// not called, because there is nobody left to call them. So whatever the
// native module leaves standing on that road is what a stranger can still
// read while the replacement JS world boots — and on 18758e8 iOS left
// everything standing but the sync client: the peripheral manager, the
// published services, the payload, the offer, every per-central cursor, and
// the answer this phone had already assembled for central C under the
// session that just died. Android's `invalidate` has always torn its server
// down. That asymmetry is the blocker this section closes.
//
// The trace, verbatim: session A's accepted reply leaves msgBuffers[C]=A ->
// the appearance bridge reload invalidates JS with no stopMeshSync/endSession
// -> the old peripheral manager and services remain callback-capable during
// and after invalidate returns -> C reads MSG_CHAR and receives A while the
// replacement JS world starts.

/** Does iOS's `invalidate` retire the whole scope, or only the sync client
 * (the 18758e8 shape)? Read from the source, so the model below dies with
 * the file rather than agreeing with it. */
const parityInvalidateRetires = (src: string): boolean => {
  const body = parityBody(src, '  override func invalidate()');
  return body.includes('retireBeforeReturning(reason: "bridge invalidated", scope: .everything)');
};

/**
 * Is the retirement a TRUE SYNCHRONOUS BARRIER for an off-main caller?
 *
 * React Native runs `invalidate` on `_sharedModuleQueue` — this module
 * declares no methodQueue and requiresMainQueueSetup is false — so an
 * `onBle`/`DispatchQueue.main.async` enqueue RETURNS with everything still
 * live and still callback-capable, which is the bug reproduced inside its own
 * fix. The barrier must (1) publish the gate from the CALLING queue, before
 * any hop, so the retirement is effective at the return; (2) run inline when
 * already on main, never `main.sync` onto itself; (3) bound the hop rather
 * than block on main unprovably; and (4) hold `self` STRONGLY, because a weak
 * cleanup queued during teardown can simply disappear.
 */
const parityBarrierIsSynchronous = (src: string): boolean => {
  const body = parityBody(src, '  private func retireBeforeReturning(');
  if (body === '') {
    return false;
  }
  const gateBeforeHop =
    body.indexOf('publishRetired(') > -1 &&
    body.indexOf('publishRetired(') < body.indexOf('Self.bleQueue.async');
  return (
    gateBeforeHop &&
    body.includes('Thread.isMainThread') &&
    body.includes('DispatchSemaphore(value: 0)') &&
    !body.includes('[weak self]')
  );
};

/**
 * A STEPPABLE MODEL OF THE SERVER, whose RULES are read out of the Swift
 * source above rather than written here. A model that agrees with itself
 * proves nothing; this one goes red when the file changes shape, which is
 * what makes the plants below able to kill it.
 */
class ParityIosServer {
  msgBuffers = new Map<string, string>();

  meshRetired = false;

  surfaceRetired = false;

  /** Work the retirement deferred onto main instead of completing it. */
  private pendingMain: Array<() => void> = [];

  /** JS answered a want: these bytes are readable by that central. */
  acceptReply(central: string, bytes: string): void {
    this.msgBuffers.set(central, bytes);
  }

  /** A fresh world publishes; the offer re-opens (installDigest). */
  publish(): void {
    this.meshRetired = false;
  }

  /** A fresh world sets its payload; the surface re-opens (setPayload). */
  setPayload(): void {
    this.surfaceRetired = false;
  }

  /** THE BRIDGE TEARDOWN ROAD — off-main, with no JS stop in front of it. */
  bridgeInvalidate(): void {
    if (!parityInvalidateRetires(parityIosSrc)) {
      // The 18758e8 shape: the sync client dies and nothing else does.
      return;
    }
    const clear = (): void => {
      this.msgBuffers.clear();
    };
    if (parityBarrierIsSynchronous(parityIosSrc)) {
      // The gate is published from the calling queue BEFORE the hop, so the
      // retirement is in force at the return whatever main is doing.
      this.meshRetired = true;
      this.surfaceRetired = true;
      clear();
      return;
    }
    // Another async enqueue: nothing is in force until main gets round to it.
    this.pendingMain.push(() => {
      this.meshRetired = true;
      this.surfaceRetired = true;
      clear();
    });
  }

  /** Whatever the retirement deferred, later. */
  drainMain(): void {
    const work = this.pendingMain;
    this.pendingMain = [];
    for (const w of work) {
      w();
    }
  }

  /** A MSG_CHAR read arriving on main. */
  readMsg(central: string): string {
    if (this.surfaceRetired) {
      return 'read-not-permitted';
    }
    if (this.meshRetired) {
      return 'not-ready';
    }
    return this.msgBuffers.get(central) ?? 'not-ready';
  }
}

const parityIosSrc = readParitySrc(PARITY_SWIFT);

describe('a bridge teardown retires everything the module was serving', () => {
  const swift = readParitySrc(PARITY_SWIFT);
  const kt = readParitySrc(PARITY_KT);

  test('there is ONE retirement, and every death road goes through it', () => {
    // Mutation: give any road its own copy of the list. That is exactly how
    // this defect was born — stopAll spelled the retirement out inline and
    // invalidate had a shorter copy that had drifted to one line.
    const retire = parityBody(swift, '  private func retireMeshScope(');
    expect(retire).not.toBe('');
    const roads: Array<[string, string]> = [
      ['invalidate', '  override func invalidate()'],
      ['endSession', '  func endSession('],
      ['stopAll', '  func stopAll('],
    ];
    for (const [, sig] of roads) {
      const body = parityBody(swift, sig);
      expect(body).not.toBe('');
      expect(body).toContain('retireBeforeReturning(reason:');
    }
    // …and the radio's own death road, which is already on the confined
    // queue and so calls the retirement directly rather than through the
    // barrier.
    // …and the RADIO road is ONE road, not two arcs. Both managers'
    // callbacks are triggers now; the reconciler is the only caller of the
    // `.radio` scope, and a latch means one outage retires once however
    // many events the two streams happen to deliver.
    const road = parityRadioRoad(swift);
    expect(road.radioDown).not.toBe('');
    expect(
      parityHasStatement(road.radioDown, 'retireMeshScope(reason: "radio down", scope: .radio)'),
    ).toBe(true);
    expect(
      parityStatements(swift).filter(line => line.includes('scope: .radio)')),
    ).toEqual(['retireMeshScope(reason: "radio down", scope: .radio)']);
    // The old inline lists are GONE, not merely unused: a second copy left
    // standing is the road back. `removeAllServices` is the sentence that
    // used to live in stopAll's body, and it now has exactly one home.
    expect((swift.match(/removeAllServices\(\)/g) ?? []).length).toBe(1);
    expect((swift.match(/dropAllCentralState\(\)/g) ?? []).length).toBe(2); // decl + the one call
  });

  test('the retirement list is complete, and the epoch floor is NOT on it', () => {
    // The reviewer's list, item by item. Mutation: drop any line and the
    // thing it names survives a teardown that claims to have taken it.
    const retire = parityBody(swift, '  private func retireMeshScope(');
    expect(retire).not.toBe('');
    // stops advertising, removes services
    expect(retire).toContain('peripheralManager?.stopAdvertising()');
    expect(retire).toContain('peripheralManager?.removeAllServices()');
    expect(retire).toContain('serviceAdded = false');
    // clears openWant / msgBuffers / msgFrame and every per-central cursor,
    // and invalidates the outstanding tickets through the watermark — all of
    // it inside the one helper that already does exactly that list.
    expect(retire).toContain('dropAllCentralState()');
    const drop = parityBody(swift, '  private func dropAllCentralState(');
    for (const line of [
      'centralSeen.removeAll()',
      'digestCursor.removeAll()',
      'digestStreamGen.removeAll()',
      'digestFrame.removeAll()',
      'msgCursor.removeAll()',
      'msgFrame.removeAll()',
      'msgBuffers.removeAll()',
      'wantAssembly.removeAll()',
      'invalidateOpenWants()',
    ]) {
      expect(drop).toContain(line);
    }
    // …and NOT a per-central record of the offer each central last read.
    // That map was deleted with the authority it could not hold (row 120):
    // the ask carries its own offer now, so there is nothing here to clear
    // and no road that can forget to.
    expect(swift).not.toContain('digestScope');
    // withdraws the digest offer — three facts, one shape, said once.
    for (const line of [
      'digestReady = false',
      'syncDigest = Data()',
      'digestGeneration += 1',
    ]) {
      expect(retire).toContain(line);
    }
    // …and the op on the radio dies with it.
    expect(retire).toContain('syncOwner?.cancel(reason)');
    // …AND THE (epoch, rev) FLOOR STAYS. Clearing it is what would let a
    // dying world's own last publish — already in flight across the bridge
    // when this ran — land afterwards and reinstall a dead pod's offer. This
    // is the M5 rule, and it is the one line of the "clear everything"
    // instinct that must be refused.
    expect(retire).not.toMatch(/digestEpoch = 0/);
    expect(retire).not.toMatch(/digestRev = 0/);
  });

  test('invalidate is a SYNCHRONOUS barrier despite being called off-main', () => {
    // THE BINDING NO-GO MECHANICS. Mutation: any of these four, and the
    // module returns from invalidate with the services live.
    expect(parityInvalidateRetires(swift)).toBe(true);
    expect(parityBarrierIsSynchronous(swift)).toBe(true);
    const body = parityBody(swift, '  override func invalidate()');
    // Not another enqueue. `onBle { … }` here is the defect, not the cure.
    expect(body).not.toContain('onBle {');
    // Not a weak cleanup: a queued weak-self block can disappear once the
    // module cache is cleared, which is why "it deallocates eventually" was
    // never a barrier.
    expect(body).not.toContain('[weak self]');
    // …and the barrier itself never blocks main on itself.
    const barrier = parityBody(swift, '  private func retireBeforeReturning(');
    expect(barrier).not.toContain('DispatchQueue.main.sync');
    expect(barrier).toContain('Self.retirementBarrierTimeout');
    expect(swift).toMatch(
      /private static let retirementBarrierTimeout: TimeInterval = \d+/,
    );
  });

  test('THE PRODUCTION TRACE — a read after invalidate returns never gets A', () => {
    // The blocker, stepped. Mutation (plant 65): invalidate goes back to
    // cancelling syncOwner and nothing else, which is the 18758e8 shape.
    const server = new ParityIosServer();
    // Session A accepted a reply for central C.
    server.acceptReply('C', 'A-mail');
    expect(server.readMsg('C')).toBe('A-mail');
    // The appearance change reloads the bridge. NO stopMeshSync, NO
    // endSession, NO stopAll — that is the whole point of this road.
    server.bridgeInvalidate();
    // C reads MSG_CHAR the instant invalidate has returned, with the
    // replacement JS world still booting. There must be NO async window at
    // all: this read is answered before anything drains.
    expect(server.readMsg('C')).not.toBe('A-mail');
    expect(['not-ready', 'read-not-permitted']).toContain(server.readMsg('C'));
    // …and it stays refused once the queue does drain.
    server.drainMain();
    expect(server.readMsg('C')).not.toBe('A-mail');
    // The replacement world then starts clean: it sets a payload and
    // publishes an offer, and only THEN does this phone serve again — and
    // never A's bytes, which the retirement freed.
    server.setPayload();
    server.publish();
    expect(server.readMsg('C')).toBe('not-ready');
  });

  test('the per-road scope table: what each road retires, and why', () => {
    // endSession is the MESH session's barrier and must not cost the camper
    // their discoverability; stopAll and invalidate take the surface too.
    // Mutation: give endSession `.everything` and every walkie open/close —
    // dozens an evening — silently un-publishes this phone's services.
    const end = parityBody(swift, '  func endSession(');
    expect(end).toContain('scope: .mesh');
    expect(end).not.toContain('.everything');
    for (const sig of ['  func stopAll(', '  override func invalidate()']) {
      expect(parityBody(swift, sig)).toContain('scope: .everything');
    }
    // The surface half is fenced inside the `.everything` branch, so the
    // mesh scope structurally cannot reach it.
    const retire = parityBody(swift, '  private func retireMeshScope(');
    const everything = parityBody(retire, 'if scope == .everything {');
    expect(everything).not.toBe('');
    expect(everything).toContain('peripheralManager?.removeAllServices()');
    expect(everything).toContain('payload = Data()');
    // …and a power cycle keeps the payload, or the automatic restart would
    // come back advertising in front of nothing.
    const radio = parityBody(retire, 'if scope != .mesh {');
    expect(radio).not.toBe('');
    expect(radio).not.toContain('payload = Data()');
    expect(radio).toContain('serviceAdded = false');
  });

  test('every main-confined read gates on the published retirement', () => {
    // Finding 109's cure, at the read. Mutation: consult the gate after the
    // buffers instead of before, and a read already queued on main when the
    // stop ran still serves the dead session's mail.
    const read = parityBody(swift, '  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead');
    expect(read).not.toBe('');
    const gateAt = read.indexOf('let gate = retirementGate()');
    expect(gateAt).toBeGreaterThan(-1);
    for (const served of ['value = payload', 'digestFrame[central]', 'msgBuffers[central]']) {
      expect(read.indexOf(served)).toBeGreaterThan(gateAt);
    }
    // …and the write side too, or a want admitted after the retirement
    // recreates the per-central state it just cleared.
    const write = parityBody(swift, '  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite');
    expect(write).not.toBe('');
    expect(write.indexOf('retirementGate()')).toBeLessThan(write.indexOf('assembled[central]'));
    // The gate is published under a lock, so it can be written from the
    // calling queue and read on main without being a data race — which is
    // the whole reason it is a flag and not a dictionary clear.
    expect(swift).toContain('private let retiredLock = NSLock()');
    const publish = parityBody(swift, '  private func publishRetired(');
    expect(publish).toContain('retiredLock.lock()');
    expect(publish).toContain('retiredLock.unlock()');
  });

  test('the gate re-opens only for the verb that re-opens what it closed', () => {
    // Mutation: clear the gate on startAdvertising, or on any tick. A live
    // session must PUBLISH before this phone serves anybody again, or the
    // refusal is a moment rather than a barrier.
    expect(parityBody(swift, '  private func installDigest(')).toContain(
      'clearRetired(mesh: true, surface: false)',
    );
    expect(parityBody(swift, '  func setPayload(')).toContain(
      'clearRetired(mesh: false, surface: true)',
    );
    expect((swift.match(/clearRetired\(/g) ?? []).length).toBe(3); // decl + the two verbs
  });

  test('iOS invalidate now retires the list Android has always retired', () => {
    // THE PARITY ARM. Android's invalidate goes
    // stopAdvertisingInternal(keepServer = false) -> stopGattServer, which
    // closes the server and frees everything behind it. iOS reaches the same
    // list through its own one function. Mutation: drop either side's road
    // and the two platforms leak differently on the SAME user gesture.
    const ktInvalidate = parityBody(kt, '  override fun invalidate()');
    expect(ktInvalidate).not.toBe('');
    expect(ktInvalidate).toContain('stopAdvertisingInternal(keepServer = false)');
    const ktStopAdv = parityBody(kt, '  private fun stopAdvertisingInternal(');
    expect(ktStopAdv).toContain('stopGattServer()');
    const ktStop = parityBody(kt, '  private fun stopGattServer(');
    const iosRetire = parityBody(swift, '  private func retireMeshScope(');
    const iosDrop = parityBody(swift, '  private func dropAllCentralState(');
    const ios = `${iosRetire}\n${iosDrop}`;
    // The same eight facts, said in each language.
    const both: Array<[string, string, string]> = [
      ['the server/services go', 'gattServer?.close()', 'peripheralManager?.removeAllServices()'],
      ['the roster goes', 'centralSeen.clear()', 'centralSeen.removeAll()'],
      ['the digest cursors go', 'digestCursor.clear()', 'digestCursor.removeAll()'],
      ['the stream generations go', 'digestStreamGen.clear()', 'digestStreamGen.removeAll()'],
      ['the message cursors go', 'msgCursor.clear()', 'msgCursor.removeAll()'],
      ['the served buffers go', 'msgBuffers.clear()', 'msgBuffers.removeAll()'],
      ['the want assemblies go', 'wantAssembly.clear()', 'wantAssembly.removeAll()'],
      // The 'recorded offers go' row is DELETED with the map it named (row
      // 120). Both files are held to its absence instead — see 'the ask
      // carries its own offer' below — because a row asserting that a
      // deleted map is cleared is a row that passes on any file.
      ['the tickets die permanently', 'invalidateWantTickets()', 'invalidateOpenWants()'],
      ['the offer is withdrawn', 'digestReady = false', 'digestReady = false'],
    ];
    for (const [, ktLine, swiftLine] of both) {
      expect(ktStop).toContain(ktLine);
      expect(ios).toContain(swiftLine);
    }
  });
});

// ------------------------------------------- the offer the ask was built on
//
// A WANT IS MINTED AGAINST THE OFFER IT NAMES, and TWO earlier shapes are
// refuted here — each of which looked like the cure for the one before it.
//
// SHAPE ONE, stamped from the globals: the ticket took whatever (epoch, rev)
// the phone published at the instant the want completed. C pulls digest A,
// this phone publishes B, C writes its A-derived want, the server stamps it
// B, and every later check agrees with itself.
//
// SHAPE TWO, the per-central last-read record: {epoch, rev, generation}
// written at the handover of the final digest frame, compared with the live
// offer when the want arrived. It READS like the invariant. It is still
// self-satisfying, and the counterexample needs no concurrency at all —
// pass 2 of the exchange ALWAYS re-reads the digest before it writes the
// want (Android's SyncClient: onServicesDiscovered -> phase digest ->
// readChar; iOS's SyncOp does the same). So the reread overwrites the record
// with B, the want carrying A-derived ids is compared against B, matches,
// and is minted, stamped and served as a B ask.
//
// THE SHAPE THAT HOLDS: the ASK CARRIES THE OFFER IT WAS DERIVED FROM, and
// the server matches that against what it publishes NOW. The identity rides
// every non-empty digest frame (so a client can only learn a live triple by
// reading the live offer), JS holds it beside the ids the moment the digest
// bytes arrive, and it is the first twenty bytes of the WANT payload. The
// per-central map is DELETED rather than demoted: a weaker second copy of a
// fact the wire carries is a copy a future edit re-promotes.

/** [epoch: 8][rev: 8][generation: 4] — the block both natives write. */
const PARITY_OFFER_BYTES = 20;

/**
 * DOES THIS SOURCE STILL MAKE A PER-CENTRAL LAST READ THE AUTHORITY? Read
 * from the file rather than assumed, in the idiom this suite already uses
 * for the scope fields: the model below is built from the answer, so the
 * plant that restores the map turns the conductor arm red instead of
 * quietly measuring a model nobody mutated.
 */
const parityLastReadAuthority = (src: string): boolean =>
  /digestScope/.test(src);

type ParityOffer = { epoch: number; rev: number; generation: number };

/**
 * A SERVER AND THE TWO-PASS CLIENT THAT TALKS TO IT. Every method here is
 * one thing that really happens on the wire, in the order the clients really
 * do it — including the second pass's digest reread, which is the step the
 * old arms omitted and which is the whole of the finding.
 */
class ParityOfferServer {
  epoch = 1;

  rev = 1;

  generation = 1;

  /** Only populated when the source still keeps the refuted map. */
  private lastRead = new Map<string, ParityOffer>();

  constructor(private readonly lastReadIsAuthority: boolean) {}

  publishNewSession(): void {
    this.epoch += 1;
    this.rev = 1;
    this.generation += 1;
  }

  /** The common case: pushDigest fires on every message-store change. */
  republishSameSession(): void {
    this.rev += 1;
    this.generation += 1;
  }

  /** A client completes a digest pull. The frame names the offer it is of,
   * so the client leaves holding that identity. */
  readDigest(central: string): ParityOffer {
    const id = { epoch: this.epoch, rev: this.rev, generation: this.generation };
    this.lastRead.set(central, id);
    return id;
  }

  /** The WANT write, carrying the identity JS derived its ids from. */
  want(
    central: string,
    carried: ParityOffer | null,
  ): 'stale-offer' | 'no-offer-identity' | ParityOffer {
    const live = { epoch: this.epoch, rev: this.rev, generation: this.generation };
    const authority = this.lastReadIsAuthority
      ? (this.lastRead.get(central) ?? null)
      : carried;
    if (!authority) {
      return 'no-offer-identity';
    }
    if (
      authority.epoch !== live.epoch ||
      authority.rev !== live.rev ||
      authority.generation !== live.generation
    ) {
      return 'stale-offer';
    }
    return { ...authority };
  }
}

describe('a want is minted against the offer it names', () => {
  const swift = readParitySrc(PARITY_SWIFT);
  const kt = readParitySrc(PARITY_KT);
  const mesh = readParitySrc(PARITY_MESH);
  const link = readParitySrc('src/crews/syncLink.ts');

  test('the offer identity rides every non-empty digest frame, both phones', () => {
    // Mutation: build the digest frame with the ordinary frame builder
    // again. The client then has no way to learn which offer it assembled,
    // so every ask it writes is unattributable — and the not-ready frame
    // deliberately stays bare, because a total=0 answer names no offer.
    expect(swift).toContain('fileprivate static let offerIdentityBytes = 20');
    expect(kt).toContain('private const val OFFER_IDENTITY_BYTES = 20');
    const swiftDigestFrame = parityBody(swift, '  private static func digestFrame(');
    expect(swiftDigestFrame).not.toBe('');
    expect(swiftDigestFrame).toContain('guard frameTotal(f) > 0 else { return f }');
    expect(swiftDigestFrame).toContain('offerIdentityBlock(identity)');
    const ktDigestFrame = parityBody(kt, '  private fun digestFrameFor(');
    expect(ktDigestFrame).not.toBe('');
    expect(ktDigestFrame).toContain('if (total == 0) {');
    expect(ktDigestFrame).toContain('offerIdentityBlock(digestEpoch, digestRev, digestGeneration)');
    // …and the serving read actually uses it.
    const swiftDigest = paritySection(swift, 'case Self.digestChar:', 'case Self.msgChar:');
    expect(swiftDigest).toContain('Self.digestFrame(of: syncDigest, cursor: cur, identity: liveOffer)');
    const ktDigest = parityBody(kt, 'DIGEST_CHAR -> synchronized(syncLock) {');
    expect(ktDigest).toContain('digestFrameFor(syncDigest, cur)');
    // The MESSAGE stream keeps the bare four-byte header: it is not an
    // offer, and widening it would break the not-ready protocol for nothing.
    const ktMsg = parityBody(kt, 'MSG_CHAR -> synchronized(syncLock) {');
    expect(ktMsg).toContain('frameFor(buf, cur)');
    expect(ktMsg).not.toContain('digestFrameFor(');
  });

  test('the ask carries its own offer, and the last-read map is GONE', () => {
    // Mutation (the last-read plant): put the per-central record back and
    // guard on it. Both files must hold the same sentence, or the two
    // platforms disagree about which asks they will serve.
    expect(parityLastReadAuthority(swift)).toBe(false);
    expect(parityLastReadAuthority(kt)).toBe(false);
    const swiftWant = parityBody(swift, '  private func handleWantFrame(');
    expect(swiftWant).not.toBe('');
    expect(swiftWant).toContain('Self.offerIdentity(from: full, at: 0)');
    expect(swiftWant).toContain('guard carried == live else {');
    // …and the ticket is stamped from the CARRIED identity, never from the
    // globals: they are equal by the guard, and writing it this way is what
    // keeps a loosened guard from silently going back to stamping now.
    expect(swiftWant).toContain(
      'OpenWant(id: wantTicketSeq, epoch: carried.epoch, rev: carried.rev)',
    );
    const ktWant = parityBody(kt, '  private fun handleWantFrame(');
    expect(ktWant).toContain('readBE64(full, 0)');
    expect(ktWant).toContain(
      'if (askedEpoch != digestEpoch || askedRev != digestRev || askedGen != digestGeneration)',
    );
    expect(ktWant).toContain('WantTicket(wantTicketSeq, askedEpoch, askedRev)');
    // The ids handed to JS are the payload MINUS the identity, on both.
    expect(swiftWant).toContain('full.subdata(in: (full.startIndex + Self.offerIdentityBytes)');
    expect(ktWant).toContain('full.copyOfRange(OFFER_IDENTITY_BYTES, full.size)');
  });

  test('THE CONDUCTOR ARM — pass 2 rereads B and the A-derived want is refused', () => {
    // THE REAL SEQUENCE, and it is entirely sequential: no concurrency is
    // needed to reach it, which is why the previous arms — which modelled
    // A-read -> B-publish -> A-WANT and omitted the reread — proved a shape
    // production never runs.
    for (const variant of ['new session', 'same epoch, new rev'] as const) {
      const s = new ParityOfferServer(parityLastReadAuthority(swift));
      // PASS 1: read digest A. JS derives its want ids from THESE bytes and
      // holds the identity beside them.
      const offerA = s.readDigest('C');
      // The server publishes B while JS is computing the want list.
      if (variant === 'new session') {
        s.publishNewSession();
      } else {
        s.republishSameSession();
      }
      // PASS 2, EXACTLY AS BOTH CLIENTS RUN IT: connect, RE-READ THE DIGEST
      // (this is the read that overwrote the old per-central record with B),
      // and only then write the want built from A.
      const reread = s.readDigest('C');
      expect(reread).not.toEqual(offerA);
      // The ask names A. It must be refused, and above all never stamped B.
      expect(s.want('C', offerA)).toBe('stale-offer');
      // THE RETRY ROAD: the central re-runs the exchange, derives under B
      // and names B, and is served under the offer it was truly built from.
      const offerB = s.readDigest('C');
      expect(s.want('C', offerB)).toEqual(offerB);
    }
  });

  test('an ask that names no offer is refused, never attributed', () => {
    // Mutation: treat a missing identity as "whatever we publish now" — the
    // globals stamp, wearing a nullish-coalesce. A transport that cannot
    // name an offer must be refused, because attributing it is precisely
    // the defect.
    const s = new ParityOfferServer(false);
    s.readDigest('C');
    expect(s.want('C', null)).toBe('no-offer-identity');
    const swiftWant = parityBody(swift, '  private func handleWantFrame(');
    expect(swiftWant).toContain('reason=no-offer-identity');
    const ktWant = parityBody(kt, '  private fun handleWantFrame(');
    expect(ktWant).toContain('reason=no-offer-identity');
  });

  test('the identity pipeline is threaded end to end in JS', () => {
    // digest read -> JS -> want-write -> wire. Mutation (plant): read the
    // offer inside fetchMessages instead of on the line after the digest
    // await, and the identity names pass 2's reread rather than the read the
    // ids came from — the finding, re-created one layer up.
    expect(link).toContain('const offer = link.offerRead?.() ?? null;');
    const conductor = link.slice(link.indexOf('export async function syncWithPeer('));
    expect(conductor.indexOf('const offer = link.offerRead?.()')).toBeLessThan(
      conductor.indexOf('const stamped = openWantAttempt('),
    );
    expect(conductor).toContain('link.fetchMessages(want, offer)');
    // …and meshSync's link fills it from the NATIVE digest result, then puts
    // it on the wire in front of the ids.
    expect(mesh).toContain('offerRead(): OfferIdentity | null {');
    expect(mesh).toContain("typeof r.offerEpoch === 'number'");
    expect(mesh).toContain('wantToB64(wantIds, carried ?? null)');
    const wantCodec = parityBody(mesh, 'function wantToB64(');
    expect(wantCodec).toContain('putBE64(out, 0, offer?.epoch ?? 0)');
    expect(wantCodec).toContain('out.set(body, OFFER_IDENTITY_BYTES)');
    expect(mesh).toContain(`const OFFER_IDENTITY_BYTES = ${PARITY_OFFER_BYTES};`);
    // BOTH CLIENTS HAND IT UP. A native that read the identity and dropped
    // it on the floor is a native whose asks can never be attributed.
    expect(parityBody(swift, '    private func finishOk()')).toContain('out["offerEpoch"]');
    expect(parityBody(kt, '    private fun finishOk()')).toContain('m.putDouble("offerEpoch"');
  });
});

// ------------------------------------- the retirement that lost its race
//
// A CLEANUP THAT ARRIVES AFTER THE WORLD IT BELONGED TO IS A GHOST.
//
// `retireBeforeReturning` publishes the gate, hops to the confined queue and
// waits at most two seconds. On TIMEOUT it returns — correctly, fail-closed,
// because the GATE is what is holding — with its cleanup still queued behind
// whatever is blocking main. stopAll resolves, teardown completes, the camper
// turns sharing back on, setPayload/installDigest legitimately reopen the
// gate, session B advertises, and only THEN does main drain the old cleanup:
// wantAdvertising false, services removed, payload cleared, retirement
// republished. B dies after JS was told its start succeeded.
//
// THE CURE IS A GENERATION, minted under the same NSLock in the same atomic
// write as the gate flags. The cleanup captures the generation its own
// publish minted; its FIRST act on main is the CAS. A newer retirement or a
// legitimate reopen has moved the world on, and the stale cleanup then does
// NOTHING — not the gate, not wantAdvertising, not the services, not the
// payload. Reopening IS the fence, because setPayload and installDigest
// already clear under that lock.

/** Does the confined cleanup carry a generation, and check it FIRST? */
const parityCleanupIsVersioned = (src: string): boolean => {
  const body = parityBody(src, '  private func retireMeshScope(');
  if (!body.includes('generation: Int64? = nil')) {
    return false;
  }
  const cas = body.indexOf('claimRetirementCleanup(generation)');
  if (cas < 0) {
    return false;
  }
  // FIRST ACT: before every field a ghost could touch, the gate included.
  for (const touched of [
    'publishRetired(',
    'wantAdvertising = false',
    'payload = Data()',
    'removeAllServices()',
  ]) {
    const at = body.indexOf(touched);
    if (at >= 0 && at < cas) {
      return false;
    }
  }
  return true;
};

/** Is every framework call in the retirement its own ObjCTry step? */
const parityRetirementIsPerStep = (src: string): boolean => {
  const body = parityBody(src, '  private func retireMeshScope(');
  // The retirement's local `step` routes through the MODULE-level helper,
  // which is what lets the coverage be transitive: a nested cleanup three
  // frames down can reach the same guard. Both halves are required.
  if (
    !parityHasStatement(body, 'guard let raised = self.guardedStep(name, reason, body) else { return }')
  ) {
    return false;
  }
  if (
    !parityHasStatement(
      parityBody(src, '  func guardedStep('),
      'guard let raised = ObjCTry.run(body) else { return nil }',
    )
  ) {
    return false;
  }
  // …AND THE TRANSITIVE ROAD. `syncOwner.cancel` runs the op's failure
  // terminal, which runs its `cleanup()`, which touches CoreBluetooth: the
  // doorway is a step here, and the call at the far end is guarded at its
  // own site. One raise out of that chain aborted the process.
  if (!parityHasStatement(body, 'step("syncOwnerCancel") { self.syncOwner?.cancel(reason) }')) {
    return false;
  }
  const cleanup = parityBody(src, '    private func cleanup() {');
  if (!parityHasStatement(cleanup, 'module?.guardedStep("cancelPeripheralConnection", "sync-cleanup") {')) {
    return false;
  }
  for (const call of [
    'peripheralManager?.stopAdvertising()',
    'centralManager?.stopScan()',
    'peripheralManager?.removeAllServices()',
    'centralManager?.cancelPeripheralConnection(',
  ]) {
    const at = body.indexOf(call);
    if (at < 0) {
      return false;
    }
    // …inside a `step("name") { … }`, which is the only thing that runs a
    // block through ObjCTry here. The nearest preceding `step(` must be
    // closer than the nearest preceding statement terminator of its own.
    const before = body.slice(0, at);
    const stepAt = before.lastIndexOf('step("');
    const braceAt = before.lastIndexOf('{');
    if (stepAt < 0 || stepAt > braceAt) {
      return false;
    }
  }
  return true;
};

/**
 * THE SURFACE WORLD, AS A CLEANUP THAT LOST ITS RACE CAN SEE IT.
 *
 * `versioned` comes from the Swift source, so the plant that restores the
 * unversioned cleanup turns these arms red rather than leaving a model
 * nobody mutated quietly green.
 */
class ParityRetireWorld {
  gen = 0;

  meshRetired = false;

  surfaceRetired = false;

  advertising = false;

  services = false;

  payload = '';

  /** Retirements republished by a cleanup, in order. */
  republished: number[] = [];

  private claimed = 0;

  private queued: Array<{ gen: number }> = [];

  constructor(private readonly versioned: boolean) {}

  /** publishRetired: the flags and the generation are ONE write. */
  private publish(): number {
    this.meshRetired = true;
    this.surfaceRetired = true;
    this.gen += 1;
    return this.gen;
  }

  /** clearRetired: reopening is the fence. */
  private clear(): void {
    this.meshRetired = false;
    this.surfaceRetired = false;
    this.gen += 1;
  }

  /** A session sets its payload, publishes its offer and advertises. */
  start(payload: string): void {
    this.clear(); // setPayload
    this.clear(); // installDigest
    this.payload = payload;
    this.services = true;
    this.advertising = true;
  }

  /**
   * stopAll with MAIN BLOCKED: the gate goes up from the calling queue, the
   * cleanup is dispatched, the two-second wait expires, and the verb
   * RETURNS. Fail-closed — the gate is held the whole time.
   */
  stopAllTimesOut(): void {
    this.queued.push({ gen: this.publish() });
  }

  /** Main drains. Each queued cleanup takes its CAS first, or no-ops. */
  releaseMain(): void {
    const draining = this.queued.splice(0, this.queued.length);
    for (const c of draining) {
      if (this.versioned) {
        if (this.gen !== c.gen || this.claimed >= c.gen) {
          continue; // retire-cleanup-stale: touches nothing at all
        }
        this.claimed = c.gen;
      }
      // The 9c0ad89 body, verbatim in its effects.
      this.publish();
      this.republished.push(c.gen);
      this.advertising = false;
      this.services = false;
      this.payload = '';
    }
  }

  /** What a previously-known central gets from the payload characteristic. */
  read(): string {
    return this.surfaceRetired ? 'refused' : this.payload;
  }
}

describe('a retirement that lost its race cannot retire the world that replaced it', () => {
  const swift = readParitySrc(PARITY_SWIFT);

  test('the cleanup carries a generation and the CAS is its FIRST act', () => {
    // Mutation (plant 71): restore the 9c0ad89 unversioned cleanup — no
    // parameter, no compare — and every arm below goes with it.
    expect(parityCleanupIsVersioned(swift)).toBe(true);
    // Minted in the same critical section as the flags, or the "atomic gate
    // write" sentence is false and two callers can capture one generation.
    const publish = parityBody(swift, '  private func publishRetired(');
    expect(publish).toContain('retiredLock.lock()');
    expect(publish).toContain('retirementGen &+= 1');
    expect(publish.indexOf('retirementGen &+= 1')).toBeLessThan(
      publish.indexOf('retiredLock.unlock()'),
    );
    // REOPENING IS THE FENCE: the two verbs that lift the gate mint past it.
    const clear = parityBody(swift, '  private func clearRetired(');
    expect(clear).toContain('retirementGen &+= 1');
    expect(clear.indexOf('retirementGen &+= 1')).toBeLessThan(
      clear.indexOf('retiredLock.unlock()'),
    );
    // The compare and the claim are ONE critical section — a released lock
    // between them is the check-then-set this module already refuses.
    const claim = parityBody(swift, '  private func claimRetirementCleanup(');
    expect(claim).toContain('retiredLock.lock()');
    expect(claim).toContain('retirementGen == generation');
    expect(claim).toContain('retirementCleanupClaimed < generation');
    // The barrier hands the minted generation to the block it dispatches.
    const barrier = parityBody(swift, '  private func retireBeforeReturning(');
    expect(barrier).toContain('let generation = publishRetired(');
    expect(barrier).toContain('retireMeshScope(reason: reason, scope: scope, generation: generation)');
    // …and it is still not a main.sync, and still bounded.
    expect(barrier).not.toContain('DispatchQueue.main.sync');
    expect(barrier).toContain('Self.retirementBarrierTimeout');
    // The stale road SAYS SO, and says which two generations disagreed.
    const retire = parityBody(swift, '  private func retireMeshScope(');
    expect(retire).toContain('crew//retire-cleanup-stale gen=');
  });

  test('THE HOSTILE ARM — B stays live and the ghost cannot retire it', () => {
    const w = new ParityRetireWorld(parityCleanupIsVersioned(swift));
    // Session A is sharing.
    w.start('A');
    expect(w.read()).toBe('A');
    // MAIN IS BLOCKED >2s. stopAll publishes the gate, dispatches its
    // cleanup, times out and RETURNS.
    w.stopAllTimesOut();
    // FAIL-CLOSED IS INTACT: the gate is held even though nothing ran.
    expect(w.surfaceRetired).toBe(true);
    expect(w.read()).toBe('refused');
    // The camper turns sharing back on. setPayload/installDigest reopen the
    // gate — and that reopen is what fences the cleanup still queued.
    w.start('B');
    expect(w.surfaceRetired).toBe(false);
    expect(w.read()).toBe('B');
    // MAIN IS RELEASED. The old cleanup finally runs.
    w.releaseMain();
    // B REMAINS LIVE. Services intact, payload intact, advertising intact,
    // and no retirement republished over the world that replaced A.
    expect(w.advertising).toBe(true);
    expect(w.services).toBe(true);
    expect(w.read()).toBe('B');
    expect(w.surfaceRetired).toBe(false);
    expect(w.republished).toEqual([]);
  });

  test('THE BENIGN TWIN — an UN-raced timeout still lands its retirement late', () => {
    // The no-wedge half, and it is the reason the cure is a generation
    // rather than "drop the cleanup on timeout". Nothing reopened, so the
    // cleanup is not a ghost: it is simply late, and it must still land.
    const w = new ParityRetireWorld(parityCleanupIsVersioned(swift));
    w.start('A');
    w.stopAllTimesOut();
    expect(w.read()).toBe('refused');
    w.releaseMain();
    expect(w.advertising).toBe(false);
    expect(w.services).toBe(false);
    expect(w.payload).toBe('');
    expect(w.surfaceRetired).toBe(true);
    expect(w.republished).toHaveLength(1);
  });

  test('one terminal per generation — a re-dispatched cleanup runs once', () => {
    // The belt on the generation's braces. Mutation: claim outside the
    // compare's critical section, or drop the claim, and a cleanup body can
    // run twice for one retirement.
    const w = new ParityRetireWorld(parityCleanupIsVersioned(swift));
    w.start('A');
    w.stopAllTimesOut();
    w.stopAllTimesOut(); // a second stop, still nothing draining
    w.releaseMain();
    // The NEWER retirement's cleanup is the one that does the work; the
    // older one lost its race to it and no-ops.
    expect(w.republished).toHaveLength(1);
    expect(w.advertising).toBe(false);
  });
});

// ------------------------------------- the retirement under ObjCTry (row 115)

/** The per-step runner, modelled: an ObjC raise ABORTS, it does not throw. */
class ParityStepRun {
  ran: string[] = [];

  first: string | null = null;

  constructor(private readonly perStep: boolean) {}

  run(steps: Array<[string, boolean]>): void {
    for (const [name, raises] of steps) {
      if (raises && !this.perStep) {
        // Unguarded: the raise unwinds past every step after it.
        this.first = this.first ?? name;
        return;
      }
      this.ran.push(name);
      if (raises) {
        this.first = this.first ?? name;
      }
    }
  }
}

describe('every framework call in the retirement runs under ObjCTry', () => {
  const swift = readParitySrc(PARITY_SWIFT);

  test('each call is its own step, and the gate is published first', () => {
    // The repo's native contract: every framework call reachable from a user
    // gesture runs under ObjCTry.run, because Swift cannot catch an ObjC
    // precondition raise and a raise is an ABORT. Toggling sharing off is a
    // finger, and these four calls were bare.
    expect(parityRetirementIsPerStep(swift)).toBe(true);
    const retire = parityBody(swift, '  private func retireMeshScope(');
    // THE GATE IS PUBLISHED BEFORE THE FIRST STEP, so a retirement that
    // cannot complete is still one no read can get behind.
    expect(retire.indexOf('publishRetired(mesh: true')).toBeLessThan(
      retire.indexOf('step("stopAdvertising")'),
    );
    // …and the first raise is ATTRIBUTED rather than swallowed. The line
    // itself lives in the shared helper now, which is the point of there
    // being one: every guarded call in this module attributes the same way,
    // including the nested ones a retirement reaches through an owner.
    expect(parityBody(swift, '  func guardedStep(')).toContain('crew//retire-step-raised step=');
    expect(retire).toContain('crew//retire-incomplete reason=');
    // Walkie.swift is the stated template; it is still the file that shows
    // the shape, so the law has one home rather than two.
    expect(readParitySrc('ios/PlayaPal/Walkie.swift')).toContain('ObjCTry.run {');
  });

  test('THE THROWING-FRAMEWORK ARM — a raise costs its own step and no more', () => {
    const run = new ParityStepRun(parityRetirementIsPerStep(swift));
    // stopAdvertising raises (a manager torn down under us). Everything
    // after it is the part that actually locks a previously-known central
    // out, so this is the raise that matters.
    run.run([
      ['stopAdvertising', true],
      ['stopScan', false],
      ['removeAllServices', false],
      ['cancelPeripheralConnection', false],
      // THE TRANSITIVE STEP, and it is last on purpose: everything above it
      // is what an abort here would already have cost, and the op's own
      // cleanup is one frame further down still.
      ['syncOwnerCancel', false],
    ]);
    expect(run.ran).toEqual([
      'stopAdvertising',
      'stopScan',
      'removeAllServices',
      'cancelPeripheralConnection',
      'syncOwnerCancel',
    ]);
    // …and the ORIGINAL failure is the one attributed, not the last one.
    expect(run.first).toBe('stopAdvertising');
  });

  test('the roster iteration names its value rather than destructuring a key', () => {
    // Hygiene, and it is the shape a reviewer reads as a bug: `for (_, p) in`
    // says "there is a key here I am ignoring" about a loop that only ever
    // wanted the values.
    const retire = parityBody(swift, '  private func retireMeshScope(');
    expect(retire).toContain('for entry in inFlight.values {');
    expect(retire).not.toContain('for (_, p) in inFlight');
  });
});

// ------------------------------- the radio scope takes the radio's work with it

/**
 * THE CAP, AND WHAT A POWER CYCLE DOES TO IT (row 116). `radioClears` and
 * `lateFenced` are read from the source so the plant that restores the
 * `.radio`-omits shape reddens the trace rather than a model.
 */
class ParityCapWorld {
  gen = 0;

  private readonly cap = 2;

  /** addr -> the connect that holds this slot: its world, and ITS OWN id. */
  private inFlight = new Map<string, { gen: number; op: number }>();

  /** addr -> the delegate terminals the framework still owes us, oldest
   *  first. Cancelling a connect does not un-schedule its callback; it
   *  CAUSES one, and that callback names only a peripheral. */
  private owed = new Map<string, number[]>();

  private seq = 0;

  /** THE DEBT BOOK'S NAMED CAP, and the count that carries what will not fit.
   *  `debtDropped` is read from the Swift: true is the shape that threw the
   *  third debt away, false is the shape that counts it. */
  private readonly namedCap = 2;

  private overflow = new Map<string, number>();

  syncOwnsRadio = false;

  constructor(
    private readonly radioClears: boolean,
    private readonly lateFenced: boolean,
    private readonly opFenced: boolean,
    private readonly debtDropped = false,
  ) {}

  /** RECORD ONE TERMINAL THE FRAMEWORK STILL OWES US. Past the named cap the
   *  cured module COUNTS the debt; the shape this arm plants DROPS it. */
  private owe(addr: string, op: number): void {
    const queue = this.owed.get(addr) ?? [];
    if (queue.length >= this.namedCap) {
      if (this.debtDropped) {
        return;
      }
      this.overflow.set(addr, (this.overflow.get(addr) ?? 0) + 1);
      return;
    }
    queue.push(op);
    this.owed.set(addr, queue);
  }

  /** Every terminal still owed for this peripheral, named and unnamed. */
  debts(addr: string): number {
    return (this.owed.get(addr)?.length ?? 0) + (this.overflow.get(addr) ?? 0);
  }

  holds(addr: string): boolean {
    return this.inFlight.has(addr);
  }

  /** A sighting with no inline payload: dial and read, under the cap. */
  discover(addr: string): 'connected' | 'refused-cap' {
    if (this.inFlight.size >= this.cap) {
      return 'refused-cap';
    }
    this.seq += 1;
    this.inFlight.set(addr, { gen: this.gen, op: this.seq });
    return 'connected';
  }

  /** The `.radio` retirement — the one road a power cycle takes. */
  radioRetire(): void {
    if (!this.radioClears) {
      return;
    }
    for (const [addr, entry] of this.inFlight) {
      if (this.opFenced) {
        this.owe(addr, entry.op);
      }
    }
    this.inFlight.clear();
    this.gen += 1;
  }

  /** The eight-second fallback. It is NOT a terminal: when a mesh sync owns
   * the radio its guard returns without finishing, and nothing re-arms it. */
  fallbackTick(addr: string): void {
    if (this.syncOwnsRadio) {
      return;
    }
    this.inFlight.delete(addr);
  }

  /**
   * A late `didDisconnect`. IT CARRIES NOTHING BUT THE PERIPHERAL — which is
   * the whole finding: the old model took the dead generation as an
   * argument, and no CoreBluetooth callback does. What the module has to
   * work with is the map, the ledger, and nothing else.
   */
  lateCallback(addr: string): void {
    if (this.opFenced) {
      const queue = this.owed.get(addr);
      if (queue && queue.length > 0) {
        // THE DEBT IS PAID. This callback is the terminal of the operation
        // the retirement cancelled, so it clears nothing.
        queue.shift();
        if (queue.length === 0) {
          this.owed.delete(addr);
        }
        return;
      }
      // …AND THEN THE UNNAMED DEBTS, oldest-first by construction: the names
      // ARE the oldest, so the count is only reached once they are paid.
      const over = this.overflow.get(addr) ?? 0;
      if (over > 0) {
        if (over === 1) {
          this.overflow.delete(addr);
        } else {
          this.overflow.set(addr, over - 1);
        }
        return;
      }
    }
    const entry = this.inFlight.get(addr);
    if (this.lateFenced && entry && entry.gen !== this.gen) {
      return;
    }
    this.inFlight.delete(addr);
  }
}

describe('a radio retirement cancels the radio work, and .mesh stays narrow', () => {
  const swift = readParitySrc(PARITY_SWIFT);
  const kt = readParitySrc(PARITY_KT);

  test('the passive connects are cancelled on the RADIO scope, not only .everything', () => {
    // Mutation (the .radio-omits plant): move the cancel/clear back inside
    // `if scope == .everything`. Both poweredOff arcs take `.radio`, so the
    // entries then survive a power cycle and hold the cap forever.
    const { radioBranch: radio, everythingBranch: everything, retire } = parityRadioRoad(swift);
    for (const marker of [
      'self.centralManager?.cancelPeripheralConnection(entry.peripheral)',
      'oweTerminal(entry.peripheral.identifier, entry.opId)',
      'inFlight.removeAll()',
      'radioGeneration &+= 1',
    ]) {
      expect(parityHasStatement(radio, marker)).toBe(true);
    }
    expect(parityHasStatement(everything, 'inFlight.removeAll()')).toBe(false);
    // …and `.mesh` reaches neither: ending a mesh session must never cost
    // the camper a passive read.
    expect(retire.indexOf('inFlight.removeAll()')).toBeGreaterThan(
      retire.indexOf('if scope != .mesh {'),
    );
    // …and the RADIO road is ONE road, not two arcs. Both managers'
    // callbacks are triggers now; the reconciler is the only caller of the
    // `.radio` scope, and a latch means one outage retires once however
    // many events the two streams happen to deliver.
    const road = parityRadioRoad(swift);
    expect(road.radioDown).not.toBe('');
    expect(
      parityHasStatement(road.radioDown, 'retireMeshScope(reason: "radio down", scope: .radio)'),
    ).toBe(true);
    expect(
      parityStatements(swift).filter(line => line.includes('scope: .radio)')),
    ).toEqual(['retireMeshScope(reason: "radio down", scope: .radio)']);
  });

  test("the adapter's return is a publish, and the seam it rides is real", () => {
    // Row 123, blocker 1, from the source side — because meshSync subscribes
    // through a `typeof` probe so that a harness stubbing radio.ts with only
    // the older members does not take the session down. That probe is the
    // one shape that could hide a production seam going missing, so both
    // halves are pinned HERE: radio.ts really exports the stream, and
    // meshSync really subscribes to it and republishes on the rising edge.
    const radio = readParitySrc(PARITY_RADIO);
    const mesh = readParitySrc(PARITY_MESH);
    expect(radio).toContain('export function onRadioState(');
    // …and it really carries the adapter's power state, which is the field
    // the whole edge is read from.
    expect(parityBody(radio, 'export function onRadioState(')).toContain('adapterEnabled:');
    expect(mesh).toContain("typeof onRadioState === 'function'");
    expect(mesh).toContain('digest republish reason=adapter-on');
    const listener = parityBody(mesh, '      ? onRadioState(s => {');
    expect(listener).toContain('void pushDigest(crewCodes)');
    // EDGE, not level: `was === false` is what keeps an advertise/scan tick
    // from re-offering an unchanged digest several times a minute.
    expect(listener).toContain('was === false');
    // …and the native halves really do withdraw the offer on a bounce, which
    // is what makes the republish necessary rather than tidy.
    expect(parityBody(kt, '  private fun onAdapterOff()')).toContain('stopGattServer()');
    expect(
      parityHasStatement(
        parityRadioRoad(swift).radioDown,
        'retireMeshScope(reason: "radio down", scope: .radio)',
      ),
    ).toBe(true);
    // …AND READINESS IS THE ACK, NOT THE PUBLISH. The republish used to be
    // fire-and-forget while the session cleared its own interruption off the
    // scan and the payload — two independent races, both true before any
    // offer is installed, so the app reported a recovery over a mailbox that
    // still answered the not-ready frame. Mutation (the plant): report ready
    // without awaiting the ack.
    expect(mesh).toContain('export function meshRepublishReady(): boolean {');
    const ready = parityBody(mesh, 'export function meshRepublishReady(): boolean {');
    expect(ready).toContain('republishOutstanding === 0');
    expect(ready).toContain('digestInstalled >= republishTarget');
    expect(listener).toContain('republishOutstanding += 1');
    expect(listener).toContain('republishTarget = rev');
  });

  test('a late callback clears only the OPERATION it belongs to', () => {
    // Mutation (the UUID-only-lookup plant): let the callback clear whatever
    // entry the map holds for that peripheral.
    //
    // THE GENERATION ALONE WAS NOT ENOUGH, and this is the trace: op A to X
    // is cancelled by a `.radio` retirement, X is rediscovered after the
    // bounce and op B is opened, and A's late `didDisconnect` — which names
    // only X — looks X up, finds B's entry carrying the CURRENT generation,
    // and deletes the slot B is holding. Comparing the map entry's
    // generation cannot see that, because the entry it compares is B's.
    const drop = parityBody(swift, '  private func dropPassive(');
    expect(drop).not.toBe('');
    // The entry names its own operation, and the ledger is consulted FIRST.
    expect(parityHasStatement(drop, 'if var owed = passiveOwed[id], !owed.isEmpty {')).toBe(true);
    expect(parityHasStatement(drop, 'let dead = owed.removeFirst()')).toBe(true);
    expect(parityHasStatement(drop, 'guard entry.gen == radioGeneration else {')).toBe(true);
    expect(drop).toContain('crew//passive-late-drop');
    // …and every road that cancels a passive connect records the terminal it
    // just caused: the retirement, the module's own finish, and the sync
    // op's cleanup. A road that cancels without owing is a road whose late
    // callback becomes anonymous again.
    for (const [sig, marker] of [
      ['  private func retireMeshScope(', 'oweTerminal(entry.peripheral.identifier, entry.opId)'],
      ['  private func finish(', 'oweTerminal(id, owned.opId)'],
      ['    private func cleanup() {', 'module?.oweTerminal(id, owned.opId)'],
    ]) {
      expect({ sig, owes: parityHasStatement(parityBody(swift, sig), marker) }).toEqual({
        sig,
        owes: true,
      });
    }
    // Android's twin: the finish runnable compares the same fact.
    expect(kt).toContain('private var radioGeneration = 0');
    expect(parityBody(kt, '  private fun onAdapterOff()')).toContain('radioGeneration += 1');
    expect(kt).toContain('if (radioGeneration != myRadioGen)');
  });

  test('THE STALE-CAP TRACE — a bounce mid-connect does not wedge rediscovery', () => {
    // DERIVED FROM THE RADIO BRANCH, not from the whole method: the plant
    // that moves the clear back into `.everything` leaves it present in the
    // body, so reading the body would measure a model nobody mutated.
    const { radioBranch } = parityRadioRoad(swift);
    const drop = parityBody(swift, '  private func dropPassive(');
    const radioClears = parityHasStatement(radioBranch, 'inFlight.removeAll()');
    const lateFenced = parityHasStatement(drop, 'guard entry.gen == radioGeneration else {');
    const opFenced =
      parityHasStatement(drop, 'if var owed = passiveOwed[id], !owed.isEmpty {') &&
      parityHasStatement(radioBranch, 'oweTerminal(entry.peripheral.identifier, entry.opId)');
    // ONE RADIO ROAD, read out of the file rather than named here.
    expect(
      parityHasStatement(
        parityRadioRoad(swift).radioDown,
        'retireMeshScope(reason: "radio down", scope: .radio)',
      ),
    ).toBe(true);
    const w = new ParityCapWorld(radioClears, lateFenced, opFenced);
    // Two payload fallback connects occupy the cap.
    expect(w.discover('X')).toBe('connected');
    expect(w.discover('Y')).toBe('connected');
    expect(w.discover('Z')).toBe('refused-cap');
    // The adapter powers off before either callback lands.
    w.radioRetire();
    // A NEW MESH SYNC OWNS THE RADIO while the old fallback would have
    // fired, so the fallback returns without finishing and is never
    // re-armed — which is why it was never the terminal for this.
    w.syncOwnsRadio = true;
    w.fallbackTick('X');
    w.fallbackTick('Y');
    // The sync settles, and rediscovery must PROCEED.
    w.syncOwnsRadio = false;
    expect(w.discover('Z')).toBe('connected');
    expect(w.discover('X')).toBe('connected');
    // …AND THE LATE CALLBACKS CANNOT CLEAR THE SLOTS THE NEW CONNECTS HOLD.
    // They carry nothing but a peripheral name — the generation the old
    // model handed them was a fact no CoreBluetooth callback has — so the
    // authority has to be the ledger the cancel left behind.
    w.lateCallback('X');
    w.lateCallback('Y');
    expect({ holdsX: w.holds('X'), holdsZ: w.holds('Z'), third: w.discover('W') }).toEqual({
      holdsX: true,
      holdsZ: true,
      third: 'refused-cap',
    });
  });

  test('THE DEBT BOOK NEVER DROPS A DEBT — a third bounce is counted, not lost', () => {
    // Mutation (the plant): restore the `crew//passive-owe-drop` return, so
    // the third unpaid terminal for one peripheral is thrown away.
    //
    // THE OLD REASONING, AND WHY IT WAS WRONG. "Two is the passive connect
    // cap, so a third would name an op that never existed" — but two is the
    // cap on connects IN FLIGHT AT ONCE. Debts are not in flight: they
    // outlive the ops that made them and they accumulate one per OUTAGE, so
    // three bounces over one peripheral whose terminals are slow is three
    // debts. The comment called dropping one a fail-OPEN. It is not: the
    // dropped debt's callback arrives ANONYMOUS, looks the peripheral up by
    // UUID, finds whatever connect holds the slot now, sees the CURRENT
    // generation on it and deletes it — the exact opId-vs-UUID defect this
    // ledger exists to stop, re-entered through its own overflow.
    const owe = parityBody(swift, '  private func oweTerminal(');
    const drop = parityBody(swift, '  private func dropPassive(');
    expect(owe).not.toBe('');
    // THE SOURCE IS THE DISCRIMINATOR: the overflow is COUNTED where the
    // names stop, and paid back out where the names run out.
    expect(parityHasStatement(owe, 'passiveOwedOverflow[id] = over')).toBe(true);
    expect(parityHasStatement(drop, 'if let over = passiveOwedOverflow[id], over > 0 {')).toBe(true);
    expect(parityHasStatement(drop, 'passiveOwedOverflow[id] = over - 1')).toBe(true);
    // …and the ledger's other half is still emptied by `.everything`, the
    // one road on which nothing is owed to anybody any more.
    expect(
      parityHasStatement(parityRadioRoad(swift).everythingBranch, 'passiveOwedOverflow.removeAll()'),
    ).toBe(true);
    const debtDropped = !parityHasStatement(owe, 'passiveOwedOverflow[id] = over');

    // THREE BOUNCES, ONE PERIPHERAL, TERMINALS THAT HAVE NOT ARRIVED YET.
    const w = new ParityCapWorld(true, true, true, debtDropped);
    for (let bounce = 0; bounce < 3; bounce += 1) {
      expect(w.discover('X')).toBe('connected');
      w.radioRetire();
    }
    expect(w.debts('X')).toBe(3);
    // The live world opens op D, and it is the object the ledger protects.
    expect(w.discover('X')).toBe('connected');
    // …and the three cancelled ops' terminals finally come home.
    w.lateCallback('X');
    w.lateCallback('X');
    w.lateCallback('X');
    expect({ holdsD: w.holds('X'), owed: w.debts('X') }).toEqual({ holdsD: true, owed: 0 });
  });

  test('the dropped-debt shape is the one this bound replaces', () => {
    // THE MODEL'S OWN LIVENESS, said the way the fence arm above says it: with
    // the third debt dropped, the third late callback is anonymous and takes
    // the live slot with it. One rule flipped, same trace.
    const w = new ParityCapWorld(true, true, true, true);
    for (let bounce = 0; bounce < 3; bounce += 1) {
      expect(w.discover('X')).toBe('connected');
      w.radioRetire();
    }
    expect(w.debts('X')).toBe(2); // the third was thrown away
    expect(w.discover('X')).toBe('connected');
    w.lateCallback('X');
    w.lateCallback('X');
    w.lateCallback('X');
    expect(w.holds('X')).toBe(false);
  });

  test('OUR OWN CANCEL IS NOT A DELEGATE CALLBACK — finish clears by identity', () => {
    // Mutation (the plant): route `finish` back through `dropPassive`.
    //
    // THE TRACE, and it is the reason the bound above is provable rather than
    // hopeful. `finish` is the module ENDING a passive read — the eight-second
    // fallback, a peer with no crew service. It used to cancel and then call
    // `dropPassive`, the road built for DELEGATE callbacks: with an older op's
    // debt outstanding for that peripheral, that road paid the debt with our
    // own cancellation and returned false, so the entry being finished stayed
    // in `inFlight` holding one of the two cap slots with nothing left to
    // clear it — and the terminal our cancel had just caused was never
    // recorded at all. Both halves push the ledger out of step with the
    // terminals actually owed, which is the same failure as a dropped debt.
    const finish = parityBody(swift, '  private func finish(');
    expect(finish).not.toBe('');
    const stmts = parityBodyStatements(finish);
    // THE ENTRY IS CLEARED BY THE OPERATION, never by the peripheral's name…
    expect(stmts).toContain('if let owned, inFlight[id]?.opId == owned.opId {');
    expect(stmts).toContain('inFlight.removeValue(forKey: id)');
    // …the debt this cancel caused is recorded…
    expect(stmts).toContain('oweTerminal(id, owned.opId)');
    // …and the callback road is not borrowed to do it.
    expect(stmts.filter(line => line.includes('dropPassive('))).toEqual([]);
  });

  test('the UUID-only shape is the one this fence replaces', () => {
    // THE MODEL'S OWN LIVENESS for the passive fence: with the op ledger
    // gone, A's late callback deletes the slot B is holding, and the cap
    // silently frees a slot nobody released. Same trace, one rule flipped.
    const w = new ParityCapWorld(true, true, false);
    expect(w.discover('X')).toBe('connected');
    w.radioRetire();
    expect(w.discover('X')).toBe('connected'); // op B
    w.lateCallback('X'); // op A's terminal, arriving late
    expect(w.holds('X')).toBe(false);
  });
});

// -------------- the radio's actual level, its desire, and the two managers

/**
 * THE SCAN LEVEL, THE PROMISE, AND THE TWO EVENT STREAMS THAT WRITE THEM.
 *
 * THREE FINDINGS COLLAPSE INTO ONE MODEL, because they were three faces of
 * one thing — a decision taken somewhere the radio could not be seen from.
 *
 *  1. THE LYING LEVEL. `scanning` was a mirror the module set by hand on
 *     some roads and not others. `.unauthorized` cancelled and emitted but
 *     left it true; `.resetting` fell into `default: break` and left it
 *     true; and before 57d1f5d the `.radio` retirement left it true as
 *     well. The poweredOn gate is `wantScanning, !scanning`, whose else
 *     RESOLVES the pending startScan and returns — so any state that left
 *     the mirror lying turned the recovery into a reported success over a
 *     deaf phone. Curing one state at a time is a spiral: each new state is
 *     a fresh chance to forget. THE CLASS CURE reads the level from the
 *     object that owns it, `CBCentralManager.isScanning`, which no manager
 *     state can leave stale.
 *  2. THE CROSS-QUEUE RACE. `startScan` / `stopScan` / `setScanMode` wrote
 *     the desire, the level and the promise on React Native's shared module
 *     queue while the callbacks and the retirement wrote them on main. Not
 *     staleness — undefined behaviour, and a decision made on one queue can
 *     be APPLIED after the other queue has changed the world underneath it.
 *  3. THE CROSS-MANAGER ORDER. Apple guarantees each manager's callback
 *     queue and nothing about the order of two managers' streams against
 *     each other. A callback that acts on its own event BODY lets a lagging
 *     `.poweredOff` from one manager retire the other manager's healthy
 *     effect — and the manager that already reported `.poweredOn` need
 *     never emit again, so nothing puts it back.
 *
 * The world below is steppable on TWO queues and carries BOTH managers, so
 * all three are expressible in one trace vocabulary. Its rules are read out
 * of the Swift source — including the STATE TABLE itself, so an arm cannot
 * agree with a policy the module does not have.
 */
type ParityManager = 'central' | 'peripheral';

type ParityManagerState =
  | 'unknown'
  | 'resetting'
  | 'poweredOn'
  | 'poweredOff'
  | 'unauthorized'
  | 'unsupported';

type ParityEffect = 'scan' | 'advertise';

type ParitySettle = {
  effect: ParityEffect;
  kind: 'resolve' | 'reject';
  /** WHICH ROAD settled it. `begin-scan` / `begin-advertise` is the honest
   *  one: the effect ran first. `guard-resolve` is the false-success branch.
   *  Anything else is the terminal code the module's own table names. */
  via: string;
  /** Effect calls AT THE MOMENT OF SETTLEMENT, which is how "the promise
   *  settles only after the effect" is asserted rather than asserted about. */
  effectsAtSettle: number;
};

type ParityRadioRules = {
  /** Every bridge entry is one hop onto the owner queue. */
  confined: boolean;
  /** The re-entry gate reads the framework's level, not the module mirror. */
  derivesLevel: boolean;
  /** Callbacks are triggers; one reconciler reads BOTH managers' current state. */
  reconciles: boolean;
  /** THE STATE TABLE, READ OUT OF THE SOURCE. A state with no row is the
   *  `default: break` road — nothing settles, which is the hang. */
  table: Record<string, string>;
};

class ParityRadioWorld {
  /** The framework's own truth. A manager that is not powered on is not
   *  scanning or advertising, whatever any module flag says — which is the
   *  whole reason the cure reads these two rather than its own mirrors. */
  isScanning = false;

  isAdvertising = false;

  state: Record<ParityManager, ParityManagerState> = {
    central: 'unknown',
    peripheral: 'unknown',
  };

  /** The module's own copies — what `emitState` sends to JS. */
  scanMirror = false;

  advertiseMirror = false;

  wantScanning = false;

  wantAdvertising = false;

  beginScanCalls = 0;

  beginAdvertiseCalls = 0;

  /** A level or a tick torn down while THAT manager was actually powered on
   *  — the cross-manager damage, counted. */
  cancelledHealthy = 0;

  rescanArmed = false;

  settlements: ParitySettle[] = [];

  private readonly pending: Record<ParityEffect, boolean> = { scan: false, advertise: false };

  private readonly ownerQueue: Array<() => void> = [];

  private readonly bridgeSteps: Array<() => void> = [];

  private radioRetired = false;

  constructor(private readonly rules: ParityRadioRules) {}

  pendingFor(effect: ParityEffect): boolean {
    return this.pending[effect];
  }

  /**
   * Run both queues to quiescence — the owner's in FIFO, a GCD serial queue
   * and nothing more, and then whatever the bridge still has pending.
   *
   * The bridge half is what keeps an UNCONFINED world comparable: an arm
   * that is not about the race must not redden merely because a bridge step
   * was left unrun by a harness that only knows one queue. Interleaving is
   * something an arm does DELIBERATELY, with `stepBridge`.
   */
  settleAll(): void {
    for (let guard = 0; guard < 200; guard += 1) {
      if (this.ownerQueue.length > 0) {
        (this.ownerQueue.shift() as () => void)();
        continue;
      }
      if (this.bridgeSteps.length > 0) {
        (this.bridgeSteps.shift() as () => void)();
        continue;
      }
      return;
    }
  }

  /** Run ONE pending bridge-queue step. In the confined shape there are
   *  never any: the whole body is a single hop and has no interleave point
   *  at all, which is the property this method exists to make visible. */
  stepBridge(): void {
    const step = this.bridgeSteps.shift();
    if (step) {
      step();
    }
  }

  bridgeIdle(): boolean {
    return this.bridgeSteps.length === 0;
  }

  // ----------------------------------------------------------- the bridge

  startScan(): void {
    if (this.rules.confined) {
      this.ownerQueue.push(() => {
        this.wantScanning = true;
        this.pending.scan = true;
        // `startScan` re-drives the manager's own state callback when the
        // manager already exists, which is how the effect and the
        // settlement are reached from a bridge call in BOTH shapes.
        this.deliver('central', this.state.central);
      });
      return;
    }
    // THE 57d1f5d SHAPE: unsynchronized writes on `_sharedModuleQueue` with
    // no happens-before edge to the owner queue, so the owner can run
    // between any two of them — INCLUDING between the decision to scan and
    // the write that records it.
    let decided = false;
    this.bridgeSteps.push(
      () => {
        this.wantScanning = true;
      },
      () => {
        this.pending.scan = true;
      },
      () => {
        decided = this.state.central === 'poweredOn' && !this.gate('scan');
      },
      () => {
        if (!decided) {
          // Not our road: fall through to the ordinary effect logic, which
          // re-reads the world. Only the DECIDED road carries the race.
          this.driveScan();
          return;
        }
        // …and this is the race: the decision was taken against a manager
        // that was powered on, and it is APPLIED here, whatever the owner
        // queue did to the radio in between.
        this.beginScan();
        this.settle('scan', 'resolve', 'begin-scan');
      },
    );
  }

  startAdvertising(): void {
    this.ownerQueue.push(() => {
      this.wantAdvertising = true;
      this.pending.advertise = true;
      this.deliver('peripheral', this.state.peripheral);
    });
  }

  // ------------------------------------------------------- the two streams

  /** The OS moves a manager, and its callback is delivered. */
  power(which: ParityManager, to: ParityManagerState): void {
    this.state[which] = to;
    if (to !== 'poweredOn') {
      // The framework's own level goes with the manager: a central that is
      // not powered on is not scanning, and `isScanning` says so by itself.
      if (which === 'central') {
        this.isScanning = false;
      } else {
        this.isAdvertising = false;
      }
    }
    this.ownerQueue.push(() => this.deliver(which, to));
  }

  /** A callback delivered LATE: its body says `body` while the manager has
   *  already moved on. This is the shape Apple's per-manager guarantee
   *  permits and this file used to act on. */
  staleEvent(which: ParityManager, body: ParityManagerState): void {
    this.ownerQueue.push(() => this.deliver(which, body));
  }

  private deliver(which: ParityManager, body: ParityManagerState): void {
    if (this.rules.reconciles) {
      // TRIGGER ONLY. The body is a cue; the reconciler reads the world.
      this.reconcile();
      return;
    }
    // THE PER-CALLBACK SHAPE, branch for branch.
    if (body === 'poweredOff') {
      this.settle('scan', 'reject', 'bluetooth-off');
      this.settle('advertise', 'reject', 'bluetooth-off');
      // `retireMeshScope(scope: .radio)` out of ONE manager's event body:
      // it clears BOTH mirrors and cancels the tick, whatever the other
      // manager is actually doing.
      if (this.scanMirror && this.state.central === 'poweredOn') {
        this.cancelledHealthy += 1;
      }
      if (this.advertiseMirror && this.state.peripheral === 'poweredOn') {
        this.cancelledHealthy += 1;
      }
      this.scanMirror = false;
      this.advertiseMirror = false;
      this.rescanArmed = false;
      return;
    }
    if (body === 'unauthorized') {
      // `case .unauthorized:` cancelled the tick and emitted, and left the
      // levels exactly as it found them.
      this.settle(which === 'central' ? 'scan' : 'advertise', 'reject', 'permission');
      this.rescanArmed = false;
      return;
    }
    if (body !== 'poweredOn') {
      // `default: break` — resetting, unknown and unsupported alike.
      return;
    }
    if (which === 'central') {
      if (this.wantScanning && !this.gate('scan')) {
        this.beginScan();
        this.settle('scan', 'resolve', 'begin-scan');
        return;
      }
      this.settle('scan', 'resolve', 'guard-resolve');
      return;
    }
    if (this.wantAdvertising && !this.gate('advertise')) {
      this.beginAdvertise();
      this.settle('advertise', 'resolve', 'begin-advertise');
      return;
    }
    this.settle('advertise', 'resolve', 'guard-resolve');
  }

  // ------------------------------------------------------- the reconciler

  private reconcile(): void {
    // (1) THE ACTUAL LEVELS, EACH FROM THE OBJECT THAT OWNS IT.
    this.scanMirror = this.isScanning;
    this.advertiseMirror = this.isAdvertising;

    // (2) THE SHARED RADIO FACT, APPLIED EXACTLY ONCE. Both CURRENT states
    // are read, which is what makes a lagging `.poweredOff` harmless.
    const centralUp = this.state.central === 'poweredOn';
    const peripheralUp = this.state.peripheral === 'poweredOn';
    if (!centralUp && !peripheralUp) {
      if (!this.radioRetired) {
        this.radioRetired = true;
        this.isScanning = false;
        this.isAdvertising = false;
        this.scanMirror = false;
        this.advertiseMirror = false;
      }
    } else {
      this.radioRetired = false;
    }
    if (!centralUp) {
      this.rescanArmed = false;
    }

    // (3) EACH DESIRED EFFECT, RE-DRIVEN INDEPENDENTLY.
    this.driveScan();
    this.driveAdvertise();
  }

  private driveScan(): void {
    const policy = this.policy('central');
    if (policy === 'hold') {
      return;
    }
    if (policy !== 'run') {
      this.settle('scan', 'reject', policy.replace('reject:', ''));
      return;
    }
    if (!this.wantScanning) {
      return;
    }
    if (this.gate('scan')) {
      this.settle('scan', 'resolve', 'guard-resolve');
      return;
    }
    this.beginScan();
    this.settle('scan', 'resolve', 'begin-scan');
  }

  private driveAdvertise(): void {
    const policy = this.policy('peripheral');
    if (policy === 'hold') {
      return;
    }
    if (policy !== 'run') {
      this.settle('advertise', 'reject', policy.replace('reject:', ''));
      return;
    }
    if (!this.wantAdvertising) {
      return;
    }
    if (this.gate('advertise')) {
      this.settle('advertise', 'resolve', 'guard-resolve');
      return;
    }
    this.beginAdvertise();
    this.settle('advertise', 'resolve', 'begin-advertise');
  }

  /** THE TABLE IS THE SOURCE'S. A state with no row is `default: break`. */
  private policy(which: ParityManager): string {
    return this.rules.table[this.state[which]] ?? 'hold';
  }

  /** The level the re-entry gate reads: the framework's, or the mirror. */
  private gate(effect: ParityEffect): boolean {
    if (effect === 'scan') {
      return this.rules.derivesLevel ? this.isScanning : this.scanMirror;
    }
    return this.rules.derivesLevel ? this.isAdvertising : this.advertiseMirror;
  }

  private beginScan(): void {
    this.beginScanCalls += 1;
    this.isScanning = true;
    this.scanMirror = true;
    this.rescanArmed = true;
  }

  private beginAdvertise(): void {
    this.beginAdvertiseCalls += 1;
    this.isAdvertising = true;
    this.advertiseMirror = true;
  }

  private settle(effect: ParityEffect, kind: 'resolve' | 'reject', via: string): void {
    if (!this.pending[effect]) {
      return;
    }
    this.pending[effect] = false;
    this.settlements.push({
      effect,
      kind,
      via,
      effectsAtSettle: effect === 'scan' ? this.beginScanCalls : this.beginAdvertiseCalls,
    });
  }
}

describe('one reconciler owns the radio: the level, the queue and both managers', () => {
  const swift = PARITY_SWIFT_SRC;
  const kt = PARITY_KT_SRC;
  const road = parityRadioRoad(swift);
  const table = parityStateTable(swift);

  /** THE MODEL'S RULES, READ OUT OF THE SOURCE. Every arm below is driven
   *  by these, so a plant that removes a cure moves the model with it. */
  const rules: ParityRadioRules = {
    confined: parityBridgeIsConfined(swift) && parityDirectSettles(swift).length === 0,
    derivesLevel: parityHasStatement(road.driveScan, 'guard !central.isScanning else {'),
    reconciles:
      parityCallbackIsTrigger(road.central, 'central', 'central') &&
      parityCallbackIsTrigger(road.peripheral, 'peripheral', 'peripheral'),
    table,
  };

  /**
   * THE CURED WORLD, WRITTEN OUT. The liveness arm at the bottom drives its
   * worlds from THIS rather than from `rules`, because it is the MODEL's
   * liveness it proves and not the source's: a plant that removes a cure
   * must redden the arms that read the source, and must leave the arm that
   * says "the model can express the bug" exactly where it was. The state
   * table arm below pins this map against the one in the Swift.
   */
  const PARITY_CURED_RADIO: ParityRadioRules = {
    confined: true,
    derivesLevel: true,
    reconciles: true,
    table: {
      poweredOn: 'run',
      resetting: 'hold',
      poweredOff: 'reject:bluetooth-off',
      unauthorized: 'reject:permission',
      unsupported: 'reject:unsupported',
      unknown: 'reject:radio-unknown',
      unrecognised: 'reject:radio-unknown',
    },
  };

  test('THE STATE TABLE — every manager state has a terminal policy', () => {
    // Mutation (the default-break plant): drop a case and let `default:`
    // cover it. THE TABLE IS READ, not described: this is the map the arms
    // below drive their model from, so a missing row is a missing row
    // everywhere at once rather than a sentence somebody has to check.
    //
    // `.unsupported` is the confirmed promise-hang child. It is TERMINAL —
    // no further update is ever coming — and it used to fall into
    // `default: break // resetting/unknown resolve on the next state
    // callback`, whose comment was true of exactly one of the states it
    // covered. A startScan on a device without BLE hung forever.
    expect(table).toEqual(PARITY_CURED_RADIO.table);
    // …and the file has no `default:` road left for a state to hide in.
    expect(parityHasStatement(road.policy, 'default:')).toBe(false);
    expect(parityHasStatement(road.policy, 'break')).toBe(false);
  });

  test('EVERY BRIDGE ENTRY IS A SHELL over the owner queue', () => {
    // Mutation (the direct-mutation plant): let a bridge method write
    // wantScanning / the level / the promise on `_sharedModuleQueue`.
    //
    // STRUCTURAL, NOT LINE PRESENCE. The FIRST statement of each body, read
    // off a comment-stripped parse, must be the hop — a method that mentions
    // `onBle` three lines down has already raced.
    for (const sig of PARITY_RADIO_BRIDGE) {
      const stmts = parityBodyStatements(parityBody(swift, sig));
      const at = stmts.indexOf('onBle { [weak self] in');
      expect({ sig, hops: at >= 0 }).toEqual({ sig, hops: true });
      // …and nothing the radio owns is touched before the hop. Argument
      // validation may precede it; a field may not.
      expect({
        sig,
        before: stmts.slice(0, at).filter(l => PARITY_CONFINED_FIELD.test(parityCode(l))),
      }).toEqual({
        sig,
        before: [],
      });
    }
    // …and the promise is settled ONLY through the owner's two helpers.
    expect(parityDirectSettles(swift)).toEqual([]);
    expect(parityHasStatement(road.settleScan, 'guard let promise = startScanPromise else { return }')).toBe(
      true,
    );
    expect(parityHasStatement(road.settleScan, 'startScanPromise = nil')).toBe(true);
    expect(
      parityHasStatement(road.settleAdvertise, 'guard let promise = startAdvertisePromise else { return }'),
    ).toBe(true);
  });

  test('BOTH CALLBACKS ARE TRIGGERS and the reconciler reads the world', () => {
    // Mutation (the stale-event plant): let a callback act on its own event
    // body. The exact statement list is the assertion, because "contains
    // reconcileRadioState" passes on a callback that ALSO retires the radio
    // out of a stale body — which is the defect itself.
    expect(parityCallbackIsTrigger(road.central, 'central', 'central')).toBe(true);
    expect(parityCallbackIsTrigger(road.peripheral, 'peripheral', 'peripheral')).toBe(true);
    // The reconciler reads BOTH managers' current state, and applies the
    // shared radio fact once, under a latch.
    for (const marker of [
      'let centralUp = central?.state == .poweredOn',
      'let peripheralUp = peripheral?.state == .poweredOn',
      'let radioDown = (central != nil || peripheral != nil) && !centralUp && !peripheralUp',
      'if !radioRetired {',
      'radioRetired = true',
    ]) {
      expect({ marker, present: parityHasStatement(road.reconcile, marker) }).toEqual({
        marker,
        present: true,
      });
    }
  });

  test('THE LEVEL IS THE FRAMEWORK’S — isScanning, not a mirror', () => {
    // Mutation (the mirror-authority plant): read the module's own
    // `scanning` in the re-entry gate. Every manager state then becomes a
    // fresh chance to leave that flag lying, and the guard's else turns a
    // deaf phone into a reported success — which is what `.unauthorized`
    // and `.resetting` were doing after 57d1f5d cured only `.radio`.
    //
    // `CBCentralManager.isScanning` is iOS 9+ and
    // `CBPeripheralManager.isAdvertising` is iOS 6+; this target is 15.1
    // (IPHONEOS_DEPLOYMENT_TARGET in PlayaPal.xcodeproj), so both are
    // available unconditionally and no availability guard is needed.
    expect(parityHasStatement(road.driveScan, 'guard !central.isScanning else {')).toBe(true);
    expect(parityHasStatement(road.driveAdvertise, 'guard !peripheral.isAdvertising else {')).toBe(true);
    expect(parityHasStatement(road.reconcile, 'scanning = central?.isScanning ?? false')).toBe(true);
    expect(parityHasStatement(road.reconcile, 'advertising = peripheral?.isAdvertising ?? false')).toBe(
      true,
    );
    expect(readParitySrc('ios/PlayaPal.xcodeproj/project.pbxproj')).toContain(
      'IPHONEOS_DEPLOYMENT_TARGET = 15.1;',
    );
  });

  test('A SECOND START SETTLES THE FIRST — a promise slot is never orphaned', () => {
    // Mutation (the plant): let the second start overwrite the stored
    // resolver, as both bridge entries used to.
    //
    // `startScanPromise` / `startAdvertisePromise` are ONE deep. A second
    // start while the first is unresolved — the automatic re-arm racing the
    // camper's own tap, share.ts retrying behind a resume — replaced the
    // record and DROPPED the pair it replaced. Nothing in the process can
    // settle a promise nobody holds, so JS awaits forever: the same hang
    // `.unsupported` and `.unknown` were cured for, reached from the caller's
    // end instead of the radio's. Superseded is a REJECTION with a reason,
    // taken through the file's one settlement road so the record is cleared
    // before anything is called out to.
    const supersession: Array<[string, string, string]> = [
      ['  func startScan(', 'self.settleScan(', 'a newer startScan replaced this one'],
      [
        '  func startAdvertising(',
        'self.settleAdvertise(',
        'a newer startAdvertising replaced this one',
      ],
    ];
    for (const [sig, settle, why] of supersession) {
      const body = parityBody(swift, sig);
      expect({ sig, found: body !== '' }).toEqual({ sig, found: true });
      const stmts = parityBodyStatements(body);
      const settleAt = stmts.findIndex(line => line === settle);
      const installAt = stmts.findIndex(line =>
        /^self\.start(Scan|Advertise)Promise = \(resolve, reject\)$/.test(line),
      );
      expect({ sig, settles: settleAt >= 0, installs: installAt >= 0 }).toEqual({
        sig,
        settles: true,
        installs: true,
      });
      // SETTLE THE OLD ONE FIRST, THEN TAKE THE SLOT. The other order is the
      // orphan: the record is gone before the settlement can find it.
      expect({ sig, firstSettles: settleAt < installAt }).toEqual({ sig, firstSettles: true });
      // …and the asker is TOLD, by name. A silent resolve would report a
      // scan that this call never started.
      expect(stmts[settleAt + 1]).toBe(`.reject(code: "superseded", message: "${why}")`);
    }
  });

  test('A GUARDED SCAN FAILURE IS A FAILURE — not a resolve, not a hang', () => {
    // Mutation (the plant): swallow the raise in `beginScan` and resolve the
    // asker anyway, which is what the bring-up used to do.
    //
    // `guardedStep` exists so a throwing CoreBluetooth call cannot abort the
    // process. It was never a licence to report the effect as landed:
    // `scanForPeripherals` raising leaves the central NOT scanning, and the
    // road below resolved the promise regardless. The camper reads a green
    // session over a deaf phone — and leaving the promise pending instead is
    // the same lie with a hang in place of a claim.
    const begin = parityBody(swift, '  private func beginScan(');
    expect(begin).not.toBe('');
    // The raise is CARRIED OUT of the bring-up rather than swallowed.
    expect(
      parityHasStatement(begin, 'let raised = guardedStep("scanForPeripherals", "begin-scan") {'),
    ).toBe(true);
    expect(parityHasStatement(begin, 'return raised')).toBe(true);
    // …and the road that owns the promise settles ON it, before it can reach
    // the success settlement below.
    const stmts = parityBodyStatements(road.driveScan);
    const failAt = stmts.indexOf('if let raised = beginScan(central) {');
    const okAt = stmts.indexOf('settleScan(.resolve)');
    expect({ failAt: failAt >= 0, okAt: okAt >= 0 }).toEqual({ failAt: true, okAt: true });
    expect(stmts[failAt + 1]).toBe('settleScan(.reject(code: "scan-failed", message: raised))');
    expect(stmts[failAt + 2]).toBe('return raised');
    // The success road is the LAST settlement in the body, reachable only
    // past the failure branch's own return.
    expect(stmts.lastIndexOf('settleScan(.resolve)')).toBeGreaterThan(failAt);
  });

  test('A GUARDED ADVERTISE FAILURE SETTLES, AND THE MIRRORS DO NOT LIE', () => {
    // Mutation (the plant): restore the bare `guardedStep(...)` calls and the
    // unconditional `serviceAdded = true`.
    //
    // TWO LOSSES IN ONE SHAPE. `peripheral.add(service)` raising left
    // `serviceAdded` TRUE, so the next reconcile skipped the add and
    // advertised in front of no characteristics — a phone discoverable with
    // an unreadable mailbox, which is the lying-flag class this module spent
    // two commits removing. And `startAdvertising` raising left the promise
    // waiting on `didStartAdvertising`, a callback that is never coming for a
    // call that raised.
    const stmts = parityBodyStatements(road.driveAdvertise);
    const addAt = stmts.indexOf(
      'if let raised = guardedStep("addService", "reconcile", { peripheral.add(service) }) {',
    );
    const markAt = stmts.indexOf('serviceAdded = true');
    const advAt = stmts.indexOf('if let raised = guardedStep("startAdvertising", "reconcile", {');
    expect({ addAt: addAt >= 0, markAt: markAt >= 0, advAt: advAt >= 0 }).toEqual({
      addAt: true,
      markAt: true,
      advAt: true,
    });
    // THE MIRROR IS SET ONLY PAST THE FAILURE BRANCH, and the branch returns
    // before it can be reached.
    expect(markAt).toBeGreaterThan(addAt);
    const failed = stmts.slice(addAt, markAt);
    expect(failed).toContain('advertising = peripheral.isAdvertising');
    expect(failed).toContain(
      'settleAdvertise(.reject(code: "advertise-failed", message: raised))',
    );
    expect(failed).toContain('return raised');
    // …and the advertise call itself is settled the same way, because it has
    // no other road home.
    expect(advAt).toBeGreaterThan(markAt);
    const advFailed = stmts.slice(advAt);
    expect(advFailed).toContain('advertising = peripheral.isAdvertising');
    expect(advFailed).toContain(
      'settleAdvertise(.reject(code: "advertise-failed", message: raised))',
    );
    expect(advFailed).toContain('return raised');
  });

  test('the RADIO scope still clears the mirror and leaves the desire standing', () => {
    // Mutation (plant 77, minimised to its behavioural hunk): delete
    // `scanning = false` from the radio branch, leaving it in `.everything`.
    //
    // SAID HONESTLY: with the level derived from `isScanning` this mirror is
    // BELT, and the plant that deletes it is no longer behaviourally
    // reachable — which is the evidence that the class was cured rather than
    // one more instance of it. What the mirror still owns is what
    // `emitState` tells JS, and a state event claiming a scan over a dead
    // radio is its own bug. So the pin is structural and says so.
    expect(road.radioBranch).not.toBe('');
    expect(parityHasStatement(road.radioBranch, 'scanning = false')).toBe(true);
    // …and the DESIRE is untouched here. A radio scope that cleared
    // `wantScanning` would leave the re-entry gate false forever and the
    // camper would need a fresh JS ask to hear anybody again — the opposite
    // failure, and it fails the same person the same way.
    expect(road.radioBranch).not.toMatch(/wantScanning\s*=/);
    expect(parityHasStatement(road.everythingBranch, 'wantScanning = false')).toBe(true);
  });

  test('BOTH PHONES clear the actual scan level when the radio goes', () => {
    // The parity half, pinned structurally because no JS harness can run
    // either module. Android has always done this — `onAdapterOff` drops
    // the callbacks and the levels together — which is precisely why the
    // iOS gap was invisible: the cross-platform suite passed on Android's
    // correctness.
    const off = parityBody(kt, '  private fun onAdapterOff()');
    expect(off).not.toBe('');
    expect(parityHasStatement(off, 'scanning = false')).toBe(true);
    expect(parityHasStatement(off, 'advertising = false')).toBe(true);
    // …and the ASYMMETRY is deliberate, so it is stated rather than left to
    // look like drift: Android holds no want-fields at all (the desire lives
    // in JS, and `onAdapterOn` only emits the cue), while iOS keeps its own
    // and self-restarts. Two roads to one behaviour, both re-scanning.
    expect(kt).not.toContain('wantScanning');
    expect(parityBody(kt, '  private fun onAdapterOn()')).toContain('emitState()');
  });

  // ------------------------------------------------------ the bounce roads

  /** A live scan, brought up the way JS brings one up. */
  const liveScan = (r: ParityRadioRules): ParityRadioWorld => {
    const w = new ParityRadioWorld(r);
    w.power('central', 'poweredOn');
    w.startScan();
    w.settleAll();
    return w;
  };

  test('THE AUTONOMY ARM — off -> resetting -> on rescans with NO second ask', () => {
    // THE POINT OF THE ARM, and it is the ruling's own sentence: a re-issued
    // JS startScan creates a FRESH pending promise and proves nothing about
    // autonomous recovery. The desire is what has to carry the recovery, so
    // this trace never calls startScan again after the outage.
    const w = liveScan(rules);
    expect(w.beginScanCalls).toBe(1);

    w.power('central', 'poweredOff');
    w.settleAll();
    // Tight scope, short names; the DIAGNOSTIC keys below stay long, because
    // those are what a failing run prints and a reader has no other context.
    const down = !w.isScanning;
    const kept = w.wantScanning;

    w.power('central', 'resetting');
    w.settleAll();
    const before = w.beginScanCalls;

    // THE RETURN. Nothing asks; the durable desire is the whole mechanism.
    w.power('central', 'poweredOn');
    w.settleAll();

    // ONE ASSERTION CARRYING THE WHOLE VERDICT: a stepwise trace stops at
    // its FIRST divergence, so a broken world reddens on one fact and the
    // reader never sees the rest. Read together, the failure output IS the
    // bug report.
    expect({
      levelDownDuringOutage: down,
      desireSurvivedOutage: kept,
      rescansOnReturn: w.beginScanCalls - before,
      scanningAfterReturn: w.isScanning,
      mirrorAfterReturn: w.scanMirror,
      tickRearmed: w.rescanArmed,
      // No ask was outstanding across the outage, so the only settlement in
      // this trace is the original bring-up's.
      road: w.settlements.map(x => `${x.kind}:${x.via}`),
      falseSuccesses: w.settlements.filter(x => x.via === 'guard-resolve').length,
    }).toEqual({
      levelDownDuringOutage: true,
      desireSurvivedOutage: true,
      rescansOnReturn: 1,
      scanningAfterReturn: true,
      mirrorAfterReturn: true,
      tickRearmed: true,
      road: ['resolve:begin-scan'],
      falseSuccesses: 0,
    });
  });

  test('a NEW ask issued after the recovery settles, and starts nothing twice', () => {
    // The separate claim the autonomy arm cannot make, and it is the road
    // the guard's resolve-and-return branch is FOR: once the scan is
    // genuinely up, a fresh startScan must settle at once rather than hang
    // — and must not start a second scan on top of the first.
    const w = liveScan(rules);
    w.power('central', 'poweredOff');
    w.settleAll();
    w.power('central', 'poweredOn');
    w.settleAll();
    const after = w.beginScanCalls;
    w.startScan();
    w.settleAll();
    expect({
      settled: !w.pendingFor('scan'),
      extraScans: w.beginScanCalls - after,
      last: w.settlements[w.settlements.length - 1],
    }).toEqual({
      settled: true,
      extraScans: 0,
      last: { effect: 'scan', kind: 'resolve', via: 'guard-resolve', effectsAtSettle: 2 },
    });
  });

  test('THE UNAUTHORIZED ROAD — an honest terminal, and a desire that survives', () => {
    // The permission is refused mid-session. The camper must be TOLD (the
    // reject road stays, by its own code), the level must go down, and the
    // intent must survive so that granting the permission in Settings comes
    // back as `.poweredOn` and re-enters the scan with no second JS call.
    const w = liveScan(rules);
    w.startScan();
    w.power('central', 'unauthorized');
    w.settleAll();
    const afterDenial = {
      settled: !w.pendingFor('scan'),
      terminal: w.settlements[w.settlements.length - 1],
      scanning: w.isScanning,
      desire: w.wantScanning,
    };
    // Permission restored: the OS reports the radio again.
    const before = w.beginScanCalls;
    w.power('central', 'poweredOn');
    w.settleAll();
    expect({
      afterDenial,
      rescans: w.beginScanCalls - before,
      scanningNow: w.isScanning,
    }).toEqual({
      afterDenial: {
        settled: true,
        terminal: { effect: 'scan', kind: 'reject', via: 'permission', effectsAtSettle: 1 },
        scanning: false,
        desire: true,
      },
      rescans: 1,
      scanningNow: true,
    });
  });

  test('THE RESETTING ROAD — an ask issued mid-bounce settles on the RETURN', () => {
    const w = liveScan(rules);
    w.power('central', 'poweredOff');
    w.settleAll();
    w.power('central', 'resetting');
    w.startScan();
    w.settleAll();
    // NOTHING settles on `.resetting`: a further update is promised, and a
    // settlement here would be a verdict the module has no basis for.
    expect(w.pendingFor('scan')).toBe(true);
    const before = w.beginScanCalls;
    w.power('central', 'poweredOn');
    w.settleAll();
    expect({
      settled: !w.pendingFor('scan'),
      rescans: w.beginScanCalls - before,
      last: w.settlements[w.settlements.length - 1],
    }).toEqual({
      settled: true,
      rescans: 1,
      last: { effect: 'scan', kind: 'resolve', via: 'begin-scan', effectsAtSettle: 2 },
    });
  });

  test('THE UNSUPPORTED ROAD — the promise terminates, it does not hang', () => {
    // The confirmed promise-hang child. `.unsupported` is terminal: nothing
    // will ever arrive to settle this ask, so the module has to.
    const w = new ParityRadioWorld(rules);
    w.startScan();
    w.power('central', 'unsupported');
    w.settleAll();
    expect({
      settled: !w.pendingFor('scan'),
      last: w.settlements[w.settlements.length - 1],
      scans: w.beginScanCalls,
    }).toEqual({
      settled: true,
      last: { effect: 'scan', kind: 'reject', via: 'unsupported', effectsAtSettle: 0 },
      scans: 0,
    });
  });

  test('THE UNKNOWN ROAD — fail closed, with an outcome', () => {
    // `.unknown` is the other half of the same `default: break`. We cannot
    // say the radio is up, so we do not claim it: the ask is rejected BY
    // NAME rather than held open on the hope of an update the framework
    // only promises. The desire survives, so an update that does arrive
    // re-enters the scan by itself.
    const w = new ParityRadioWorld(rules);
    w.startScan();
    w.power('central', 'unknown');
    w.settleAll();
    const afterUnknown = {
      settled: !w.pendingFor('scan'),
      last: w.settlements[w.settlements.length - 1],
      desire: w.wantScanning,
    };
    const before = w.beginScanCalls;
    w.power('central', 'poweredOn');
    w.settleAll();
    expect({ afterUnknown, autonomousRescans: w.beginScanCalls - before }).toEqual({
      afterUnknown: {
        settled: true,
        last: { effect: 'scan', kind: 'reject', via: 'radio-unknown', effectsAtSettle: 0 },
        desire: true,
      },
      autonomousRescans: 1,
    });
  });

  test('THE RACE ARM — a bridge start racing a main power-off serializes', () => {
    // THE TWO-QUEUE TRACE, and the single-thread model this suite carried
    // before could not express it: JS asks for a scan on React Native's
    // shared module queue at the same moment the OS drops the radio on the
    // owner queue. In the confined shape the ask is ONE hop — there is no
    // interleave point at all, the two land in some order, and both orders
    // are coherent. Unconfined, the decision to scan is taken against a
    // manager that is powered on and APPLIED after it died.
    const w = new ParityRadioWorld(rules);
    w.power('central', 'poweredOn');
    w.settleAll();
    w.startScan();
    // The bridge queue makes what progress it can…
    w.stepBridge();
    w.stepBridge();
    w.stepBridge();
    // …and the owner queue runs the outage in the middle of it.
    w.power('central', 'poweredOff');
    w.settleAll();
    // …and whatever the bridge had left lands afterwards.
    w.stepBridge();
    w.settleAll();
    expect({
      // NO INTERLEAVE POINT EXISTS: the confined bridge has no steps.
      bridgeStepsLeft: w.bridgeIdle(),
      // The promise TERMINATED, exactly once.
      settled: !w.pendingFor('scan'),
      settlements: w.settlements.length,
      // …and the world is coherent: no scan is claimed over a dead radio.
      scanningAfter: w.isScanning,
      mirrorAfter: w.scanMirror,
      falseSuccesses: w.settlements.filter(x => x.via === 'guard-resolve').length,
    }).toEqual({
      bridgeStepsLeft: true,
      settled: true,
      settlements: 1,
      scanningAfter: false,
      mirrorAfter: false,
      falseSuccesses: 0,
    });
  });

  // -------------------------------------------------- the two cross-orders

  test('CROSS-ORDER 1 — central on, peripheral stale off, peripheral on', () => {
    // SCAN-ONLY DESIRE. The radio bounces; the CENTRAL comes back first and
    // the scan restarts. Then the peripheral's lagging `.poweredOff` lands —
    // a body describing a world that is already over. Acting on it retires
    // the scan that just started and cancels the tick, and the peripheral's
    // own `.poweredOn` then guard-returns with `wantAdvertising` false and
    // leaves no cue, while the central — having already reported
    // `.poweredOn` — need never emit again. The camper is deaf for the rest
    // of the session.
    const w = liveScan(rules);
    w.power('central', 'poweredOff');
    w.power('peripheral', 'poweredOff');
    w.settleAll();
    const before = w.beginScanCalls;

    w.power('central', 'poweredOn');
    w.settleAll();
    w.staleEvent('peripheral', 'poweredOff');
    w.settleAll();
    w.power('peripheral', 'poweredOn');
    w.settleAll();

    expect({
      recoveries: w.beginScanCalls - before,
      scanningAtEnd: w.isScanning,
      mirrorAtEnd: w.scanMirror,
      tickArmed: w.rescanArmed,
      cancelledHealthy: w.cancelledHealthy,
    }).toEqual({
      recoveries: 1,
      scanningAtEnd: true,
      mirrorAtEnd: true,
      tickArmed: true,
      cancelledHealthy: 0,
    });
  });

  test('CROSS-ORDER 2 — peripheral on, central stale off, central on', () => {
    // ADVERTISE-ONLY DESIRE, the same failure the other way round: a
    // peripheral-only manager reset must not retire a healthy central, and
    // a lagging central `.poweredOff` must not un-publish an advertisement
    // that never stopped.
    const w = new ParityRadioWorld(rules);
    w.power('peripheral', 'poweredOn');
    w.startAdvertising();
    w.settleAll();
    expect(w.beginAdvertiseCalls).toBe(1);

    w.power('central', 'poweredOff');
    w.power('peripheral', 'poweredOff');
    w.settleAll();
    const before = w.beginAdvertiseCalls;

    w.power('peripheral', 'poweredOn');
    w.settleAll();
    w.staleEvent('central', 'poweredOff');
    w.settleAll();
    w.power('central', 'poweredOn');
    w.settleAll();

    expect({
      recoveries: w.beginAdvertiseCalls - before,
      advertisingAtEnd: w.isAdvertising,
      mirrorAtEnd: w.advertiseMirror,
      cancelledHealthy: w.cancelledHealthy,
    }).toEqual({
      recoveries: 1,
      advertisingAtEnd: true,
      mirrorAtEnd: true,
      cancelledHealthy: 0,
    });
  });

  // ------------------------------------------------- the model's liveness

  test('the model is sensitive to every fact it reads', () => {
    // A STEPPABLE MODEL THAT CANNOT EXPRESS THE BUG PROVES NOTHING ABOUT THE
    // CURE. Each rule is flipped to the shape the source had before it, and
    // the failure the ruling described is REQUIRED — so a plant that removes
    // a cure has somewhere to land, and this arm is what says the plants are
    // measuring behaviour rather than a model that agrees with itself.
    const flip = (over: Partial<ParityRadioRules>): ParityRadioRules => ({
      ...PARITY_CURED_RADIO,
      ...over,
    });

    // (a) THE MIRROR AS THE AUTHORITY, with `.unauthorized` leaving it
    //     standing: the return reports success down the guard's else and
    //     never rescans.
    const mirror = new ParityRadioWorld(
      flip({ derivesLevel: false, reconciles: false, table: {} }),
    );
    mirror.power('central', 'poweredOn');
    mirror.startScan();
    mirror.settleAll();
    mirror.power('central', 'unauthorized');
    mirror.settleAll();
    // THE LIE, IN TWO FIELDS SIDE BY SIDE: the framework knows the scan is
    // over, and the module's mirror says it is still running.
    expect({ framework: mirror.isScanning, mirror: mirror.scanMirror }).toEqual({
      framework: false,
      mirror: true,
    });
    // The permission comes back and JS re-arms. Nothing rescans, and the
    // guard's else reports success anyway — the deaf phone with a green
    // state event behind it.
    mirror.power('central', 'poweredOn');
    mirror.startScan();
    mirror.settleAll();
    expect(mirror.beginScanCalls).toBe(1);
    expect(mirror.settlements[mirror.settlements.length - 1]).toEqual({
      effect: 'scan',
      kind: 'resolve',
      via: 'guard-resolve',
      effectsAtSettle: 1,
    });

    // (b) THE `default: break` TABLE: `.unsupported` settles nothing, ever.
    const hang = new ParityRadioWorld(flip({ table: { poweredOn: 'run' } }));
    hang.startScan();
    hang.power('central', 'unsupported');
    hang.settleAll();
    expect(hang.pendingFor('scan')).toBe(true);
    expect(hang.settlements).toEqual([]);

    // (c) THE STALE EVENT WRITING THE OTHER MANAGER'S LEVEL.
    const stale = new ParityRadioWorld(flip({ reconciles: false }));
    stale.power('central', 'poweredOn');
    stale.startScan();
    stale.settleAll();
    expect(stale.beginScanCalls).toBe(1);
    stale.staleEvent('peripheral', 'poweredOff');
    stale.settleAll();
    expect(stale.cancelledHealthy).toBe(1);
    expect(stale.scanMirror).toBe(false);
    expect(stale.rescanArmed).toBe(false);
    // …and the peripheral's own return provides no cue at all.
    stale.power('peripheral', 'poweredOn');
    stale.settleAll();
    expect(stale.beginScanCalls).toBe(1);

    // (d) THE UNCONFINED BRIDGE: a decision taken on one queue, applied
    //     after the other queue killed the radio.
    const raced = new ParityRadioWorld(flip({ confined: false }));
    raced.power('central', 'poweredOn');
    raced.settleAll();
    raced.startScan();
    raced.stepBridge();
    raced.stepBridge();
    raced.stepBridge();
    raced.power('central', 'poweredOff');
    raced.settleAll();
    raced.stepBridge();
    raced.settleAll();
    expect(raced.isScanning).toBe(true); // a scan claimed over a dead radio
    expect(raced.settlements.map(x => `${x.kind}:${x.via}`)).toEqual([
      'reject:bluetooth-off',
    ]);
  });
});

// ------------------------- the Android response and the retirement it belongs to

/**
 * R copies under the lock, E resolves, R sends.
 *
 * `atomic` is read from the source and says whether the CHECK and the SEND
 * are one critical section. The pre-cure shape read `retireGen` under the
 * lock, RELEASED it, and only then sent — and re-checking outside the lock
 * cannot close a race the lock exists for. `during` is the one place a
 * non-atomic terminal yields; an atomic one has no such place, so whatever
 * would have run there is serialized after the whole terminal instead.
 */
class ParityResponseWorld {
  private gen = 0;

  private buffers = new Map<string, string>();

  /** Sends and terminals in the order they actually happened. */
  events: string[] = [];

  sent: string[] = [];

  constructor(
    /** Does the terminal consult `retireGen` AT ALL? */
    private readonly fenced: boolean,
    /** …and is that check in the SAME critical section as the send? */
    private readonly atomic: boolean,
  ) {}

  fill(addr: string, bytes: string): void {
    this.buffers.set(addr, bytes);
  }

  /** onCharacteristicReadRequest: copy under syncLock, then release it. */
  copy(addr: string): { bytes: string; gen: number } {
    return { bytes: this.buffers.get(addr) ?? '', gen: this.gen };
  }

  /** RN endSession: acquire the lock, clear, bump, resolve to JS. */
  endSession(): void {
    this.buffers.clear();
    this.gen += 1;
    this.events.push('end-resolved');
  }

  /** The response terminal: check the generation, then send. */
  respond(copied: { bytes: string; gen: number }, during?: () => void): void {
    const stale = (): boolean => this.fenced && copied.gen !== this.gen;
    if (this.atomic) {
      // ONE critical section: nothing can land between the check and the
      // send, so whatever `during` was going to do is serialized after.
      this.push(stale() ? 'not-ready' : copied.bytes);
      during?.();
      return;
    }
    const refuse = stale();
    during?.();
    this.push(refuse ? 'not-ready' : copied.bytes);
  }

  private push(bytes: string): void {
    this.sent.push(bytes);
    this.events.push(`send:${bytes}`);
  }
}

describe('an Android response belongs to the retirement it was copied under', () => {
  const kt = PARITY_KT_SRC;
  const ktRead = parityBody(kt, '        override fun onCharacteristicReadRequest(');
  const ktTerminal = parityBody(ktRead, 'synchronized(syncLock) {\n              val server = gattServer');
  // TWO FACTS, READ SEPARATELY, because two different plants remove them.
  // `fenced` is whether the terminal consults the retirement generation at
  // all; `atomic` is whether it does so in the same critical section as the
  // send. A fence outside the lock is the check-then-send shape — it looks
  // like a cure and closes nothing.
  const fenced =
    parityHasStatement(ktRead, 'var respGen = -1') &&
    ktRead.includes('val retiredSinceCopy = respGen >= 0') &&
    ktRead.includes('reason=retired-since-copy');
  const atomic =
    fenced &&
    parityHasStatement(ktTerminal, 'val retiredSinceCopy = respGen >= 0 && retireGen != respGen') &&
    parityHasStatement(
      ktTerminal,
      'server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)',
    ) &&
    parityHasStatement(
      ktTerminal,
      'server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, refusal)',
    );

  test('the claim, the check and the send are ONE retirement-atomic terminal', () => {
    // Mutation (the check-then-send plant): hoist the generation compare
    // back out of the critical section. The window it re-opens is exact —
    // R checks and sees its own generation, E bumps and resolves, R sends
    // session A's mail to a central the app has already told JS is gone.
    expect({ fenced, atomic }).toEqual({ fenced: true, atomic: true });
    expect(ktTerminal).not.toBe('');
    // Captured INSIDE the same critical section as the copy, per branch.
    expect(ktRead).not.toBe('');
    for (const branch of [
      'DIGEST_CHAR -> synchronized(syncLock) {',
      'MSG_CHAR -> synchronized(syncLock) {',
    ]) {
      expect(parityHasStatement(parityBody(ktRead, branch), 'respGen = retireGen')).toBe(true);
    }
    // …and the retirements move it.
    expect(parityBody(kt, '  fun endSession(')).toContain('retireGen += 1');
    expect(parityBody(kt, '  private fun stopGattServer(')).toContain('retireGen += 1');
    expect(ktRead).toContain('reason=retired-since-copy');
    // THE BRIDGE RULE IS UNCHANGED and is why the send could move in: the
    // emit still happens outside the lock, on a flag the terminal carries
    // out. A `emit(` inside that block would be a JS callback under a lock
    // the GATT callbacks take.
    expect(parityHasStatement(ktTerminal, 'servedDialable = digestServed')).toBe(true);
    expect(ktTerminal).not.toContain('emit(SYNC_SERVED_EVENT');
  });

  test('R(copy A) -> E(resolve) -> R(send) must refuse, never emit A', () => {
    const w = new ParityResponseWorld(fenced, atomic);
    w.fill('C', 'A-mail');
    // R copies A under the lock and releases it.
    const copied = w.copy('C');
    expect(copied.bytes).toBe('A-mail');
    // E acquires the lock, clears, and resolves its promise to JS.
    w.endSession();
    // R now reaches its terminal.
    w.respond(copied);
    expect(w.sent).toEqual(['not-ready']);
    expect(w.sent).not.toContain('A-mail');
  });

  test('E CANNOT LAND INSIDE THE TERMINAL — the two serialize', () => {
    // THE ARM THE RE-CHECK COULD NOT MAKE, and the reason check-then-send is
    // a finding rather than a style note: the ordering is what is claimed.
    // Once `endSession` has resolved to JS, no byte of the dead session may
    // still go out — and a terminal that yields between its check and its
    // send emits AFTER that resolve.
    const w = new ParityResponseWorld(fenced, atomic);
    w.fill('C', 'A-mail');
    const copied = w.copy('C');
    w.respond(copied, () => w.endSession());
    expect(w.events).toEqual(['send:A-mail', 'end-resolved']);
  });

  test('the model is sensitive to the fact it reads', () => {
    // Check-then-send, driven through the same trace: A's mail goes out
    // after the session that owned it was reported over.
    const w = new ParityResponseWorld(true, false);
    w.fill('C', 'A-mail');
    const copied = w.copy('C');
    w.respond(copied, () => w.endSession());
    expect(w.events).toEqual(['end-resolved', 'send:A-mail']);
  });

  test('an unraced response still goes out whole', () => {
    // The no-wedge half: the fence must cost an ordinary read nothing.
    const w = new ParityResponseWorld(fenced, atomic);
    w.fill('C', 'A-mail');
    w.respond(w.copy('C'));
    expect(w.sent).toEqual(['A-mail']);
  });
});

// ------------------------------------------------ the stop the JS side takes

describe('an explicit stop is a barrier on both sides of the bridge', () => {
  const swift = readParitySrc(PARITY_SWIFT);
  const mesh = readParitySrc(PARITY_MESH);
  const share = readParitySrc(PARITY_SHARE);
  const radio = readParitySrc(PARITY_RADIO);

  test('endSession completes its retirement before the native call returns', () => {
    // Mutation: put the retirement back inside an `onBle` enqueue and
    // resolve. The Jest stub could never tell the difference — it retires
    // synchronously inside its async mock — which is exactly how this road
    // stayed broken while every arm stayed green.
    const end = parityBody(swift, '  func endSession(');
    expect(end).not.toBe('');
    expect(end).not.toContain('onBle {');
    expect(end.indexOf('retireBeforeReturning(')).toBeLessThan(end.indexOf('resolve(nil)'));
  });

  test('…AND the JS lifecycle awaits it through teardown (belt and braces)', () => {
    // Mutation (plant 67): drop the `await`. The reviewer offered this OR
    // the native barrier; both are built, because the stub-masking above is
    // the proof that an async road rots unwatched.
    expect(mesh).toMatch(/export function stopMeshSync\(\): Promise<void> \{/);
    // The native settlement is HANDED BACK rather than defused in place.
    const endNative = parityBody(mesh, 'function endNativeSession(why: string): Promise<void> {');
    expect(endNative).not.toBe('');
    expect(endNative).toContain('return Promise.resolve(ended).then(');
    const stop = parityBody(mesh, 'export function stopMeshSync(): Promise<void> {');
    expect(stop).toContain('const retired = endNativeSession(\'stop\');');
    expect(stop).toContain('return retired;');
    const teardown = parityBody(share, 'async function teardownSession(): Promise<void> {');
    expect(teardown).not.toBe('');
    expect(teardown).toContain('await stopMeshSync();');
  });

  test('full-sharing teardown calls AND awaits the native stopAll', () => {
    // THE PRIVACY PATH (row 108). Mutation (plant 68): drop the call. Then a
    // central that learned this iPhone's identifier while sharing reconnects
    // by it after the camper removed their last mailbox, reads payloadChar,
    // and the UI has been saying "off" the whole time — because iOS's
    // stopAdvertising ends DISCOVERY only, and endSession clears the mesh
    // scope only.
    const stopAllJs = parityBody(radio, 'export async function stopAllRadio(): Promise<void> {');
    expect(stopAllJs).not.toBe('');
    expect(stopAllJs).toContain('await native.stopAll();');
    const teardown = parityBody(share, 'async function teardownSession(): Promise<void> {');
    expect(teardown).toContain('await stopAllRadio();');
    // …and it is the SHARING teardown, not the walkie's hold. That hold is
    // temporary and keeps the mailbox reachable on purpose; swapping it for
    // this would cost pod mail to cure a problem it does not have.
    const hold = parityBody(share, 'export function holdCrewAdvertising(): Promise<void> {');
    expect(hold).not.toBe('');
    expect(hold).not.toContain('stopAllRadio');
    expect(hold).toContain('setCrewAdvertisingHold(true)');
    expect(parityBody(radio, 'export async function setCrewAdvertisingHold(')).toContain(
      'await native.stopAdvertising();',
    );
    // …and the replacement session cannot race it: teardown is inside
    // share.ts's own serialization, so a start waits for this stop.
    expect(share).toMatch(/export function startMailboxPresence\(\): Promise<void> \{\n\s*return serialized\(/);
    expect(share).toMatch(/export function stopMailboxPresence\(\): Promise<void> \{\n\s*return serialized\(/);
  });
});

// ---------------------------------------------------------------- live JS

/**
 * The other half of "zero JS changes": drive radio.ts against a native
 * module built FROM THE BRIDGE FILE, so the surface under test is the one
 * an iPhone actually exposes rather than a mock that agrees with the code.
 */
jest.mock('react-native', () => {
  const fs = require('fs');
  const bridgeSrc = fs.readFileSync('ios/PlayaPal/CrewBeaconBridge.m', 'utf8') as string;
  const re = /RCT_EXTERN_METHOD\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  const CrewBeacon: Record<string, unknown> = {};
  let m: RegExpExecArray | null = re.exec(bridgeSrc);
  while (m) {
    CrewBeacon[m[1]] = jest.fn(async () => undefined);
    m = re.exec(bridgeSrc);
  }
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  class NativeEventEmitter {
    addListener(name: string, cb: (e: unknown) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return {
        remove: () => {
          listeners.set(name, (listeners.get(name) ?? []).filter(x => x !== cb));
        },
      };
    }
  }
  return {
    NativeModules: { CrewBeacon },
    NativeEventEmitter,
    Platform: { OS: 'ios', Version: 0 },
    PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
    __crewListeners: listeners,
  };
});

import { onSyncServed, onSyncWant, setScanPosture } from '../src/crews/radio';

const parityRN = jest.requireMock('react-native') as {
  NativeModules: { CrewBeacon: Record<string, jest.Mock> };
  __crewListeners: Map<string, Array<(e: unknown) => void>>;
};

const parityEmit = (name: string, body: unknown): void => {
  for (const cb of parityRN.__crewListeners.get(name) ?? []) {
    cb(body);
  }
};

describe('the guards in radio.ts light up on an iOS-shaped module', () => {
  test('setScanPosture now reaches the native knob instead of no-opping', async () => {
    // Mutation: drop setScanMode from the bridge. This test dies, and the
    // failure names the reason the iPhone would have stayed slow.
    await setScanPosture(true);
    await setScanPosture(false);
    expect(parityRN.NativeModules.CrewBeacon.setScanMode.mock.calls).toEqual([
      [true],
      [false],
    ]);
  });

  test('a CrewSyncServed event reaches the reciprocity callback', async () => {
    const seen: string[] = [];
    const off = onSyncServed(({ peerId }) => seen.push(peerId));
    // The peripheral-side identity of a central: on iOS a UUID string, on
    // Android a MAC. Both are opaque to this seam.
    parityEmit('CrewSyncServed', { peerId: 'B0F5E0A2-0000-4000-8000-00000000FEED' });
    parityEmit('CrewSyncServed', { peerId: 42 }); // not a string: ignored
    off();
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:01' }); // after off
    expect(seen).toEqual(['B0F5E0A2-0000-4000-8000-00000000FEED']);
  });

  test('an unsaid `dialable` is FALSE, never a promise', () => {
    // Mutation: default dialable to true (or pass the raw field through).
    // A server that says nothing about whether its central name is an
    // address would then have its silence read as a route, and meshSync
    // would queue an opaque identifier into the one-at-a-time native sync
    // mutex — trading the eight-minute mail for a stalled one.
    const seen: Array<{ peerId: string; dialable: boolean }> = [];
    const off = onSyncServed(s => seen.push(s));
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:01' });
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:02', dialable: true });
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:03', dialable: false });
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:04', dialable: 'yes' });
    off();
    expect(seen.map(s => s.dialable)).toEqual([false, true, false, false]);
  });

  test("a CrewSyncWant hands its request identity to the listener", () => {
    // THE DROP THE REVIEW FOUND, armed. radio.ts read the peer and the
    // bytes off this event and threw the other two fields away, so an
    // answer could only ever be addressed to a peer — and a peer is not a
    // question. Mutation (plant e): stop forwarding requestId/serverEpoch.
    // Every native match below becomes a comparison against a value JS
    // never had.
    const seen: Array<Record<string, unknown>> = [];
    const off = onSyncWant(w => seen.push({ ...w }));
    parityEmit('CrewSyncWant', {
      peerId: 'B0F5E0A2-0000-4000-8000-00000000FEED',
      payload: 'V0FOVA==',
      requestId: 12,
      serverEpoch: 4,
    });
    off();
    expect(seen).toEqual([
      {
        peerId: 'B0F5E0A2-0000-4000-8000-00000000FEED',
        payload: 'V0FOVA==',
        requestId: 12,
        serverEpoch: 4,
      },
    ]);
  });

  test('a want with no identity is not delivered at all', () => {
    // There is no answer this seam could send for such a want that either
    // server could match, so handing it up would only produce a reply that
    // must be refused. Mutation: pass the event through with two undefineds
    // and the refusal moves to the far side of a bridge hop, where the
    // bytes it names have already been read out of the store.
    const seen: unknown[] = [];
    const off = onSyncWant(w => seen.push(w));
    const peerId = 'B0F5E0A2-0000-4000-8000-00000000FEED';
    // TABLE-DRIVEN, because five near-identical emits differing in one field
    // hide the one that stops differing: a copy-paste that leaves two rows
    // testing the same thing reads exactly like coverage. The name is what
    // the failure prints, so a red row says WHICH malformation got through.
    const malformed: Array<[string, Record<string, unknown>]> = [
      ['neither field', {}],
      ['epoch missing', { requestId: 3 }],
      ['id missing', { serverEpoch: 3 }],
      ['id is a string', { requestId: '3', serverEpoch: 3 }],
      ['id is NaN', { requestId: Number.NaN, serverEpoch: 3 }],
    ];
    for (const [, fields] of malformed) {
      parityEmit('CrewSyncWant', { peerId, payload: 'V0FOVA==', ...fields });
    }
    off();
    expect(seen.map(() => 'delivered')).toEqual([]);
    expect(malformed.map(([name]) => name)).toHaveLength(5);
  });

  test('the optional guard still protects a module without the knob', async () => {
    // The guard is not vestigial now that both platforms implement it: an
    // older build on a phone that has not updated, or a future third
    // module, must degrade to its own cadence rather than throw inside a
    // posture flip. Proven by removing the method, not by reading the code.
    let radioNoKnob: typeof import('../src/crews/radio') | undefined;
    jest.isolateModules(() => {
      const rn = require('react-native');
      delete rn.NativeModules.CrewBeacon.setScanMode;
      radioNoKnob = require('../src/crews/radio');
    });
    await expect(radioNoKnob!.setScanPosture(true)).resolves.toBeUndefined();
  });
});
