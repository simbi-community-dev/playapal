/**
 * Call signaling over the walkie's own wire (docs/VIDEO-CALLS.md §2).
 *
 * A video call needs to move a few KB of SDP and a handful of ICE
 * candidates between exactly two phones — and the walkie already maintains
 * a UDP path to every pod peer on three transports (shared LAN, Android
 * Wi-Fi Aware, iOS local link). So signaling rides THAT, as one more codec
 * id in the PW frame (0x6, docs/WALKIE-LADDER.md §3's whole point): no
 * server, no internet, no second discovery layer, and a build that does
 * not know the codec drops the frames silently.
 *
 * Two problems the wire hands us, solved here in pure TS so tests can
 * drive every byte:
 *
 * 1. SIZE. The Android receive loop reuses one HEADER+640-byte buffer for
 *    every datagram; anything longer is truncated by the socket, not
 *    errored. So a signal payload NEVER exceeds 640 bytes on the wire —
 *    an SDP (~2-6 KB) is chunked and reassembled.
 * 2. LOSS. UDP drops, and a lost "accept" is a call that rings forever on
 *    one screen and connects on the other. Every message retransmits on a
 *    timer until the peer acks its id — bounded, so a dead peer becomes an
 *    honest 'signal-dead' event instead of an infinite retry.
 * 3. LOSS THAT IS NOT RANDOM (docs/VIDEO-CALLS.md §2a). Retransmission
 *    only beats loss that is independent per try. The measured failure was
 *    not: P7's row for P9 was DEAD, so all eight of P7's acks went into the
 *    same downed interface and erred nowhere. Retransmitting harder down a
 *    dead road is still zero deliveries. So a retransmission also CHANGES
 *    ROAD — see the fanout argument below.
 *
 * Chunk layout inside the PW payload (all BE):
 *   msgId (4) | idx (1) | total (1) | utf8 JSON slice (≤ SIGNAL_CHUNK_DATA_MAX)
 */

/** Per-chunk framing overhead: msgId(4) + idx(1) + total(1). */
export const SIGNAL_CHUNK_HEADER = 6;

/** JSON bytes per chunk. 600 + 6 = 606, safely under the native 640-byte
 * payload ceiling (WalkieModule.kt FRAME_BYTES) that the receive buffer
 * enforces by truncation — a test reads the Kotlin file and pins this. */
export const SIGNAL_CHUNK_DATA_MAX = 600;

/** The largest wire payload this module will ever hand the native side. */
export const WALKIE_SIGNAL_MAX_PAYLOAD =
  SIGNAL_CHUNK_HEADER + SIGNAL_CHUNK_DATA_MAX;

/** A control message. `t` routes it; everything else is message-specific.
 * `id` is stamped by the signaler and is transport-level, like the seq
 * bytes it rides beside — the call layer never reads it. */
export interface SignalEnvelope {
  t: string;
  id?: number;
  [key: string]: unknown;
}

// ------------------------------------------------------------- utf8 + b64
//
// Hand-rolled on purpose: Hermes has carried TextEncoder/atob for a while,
// but "for a while" is exactly the kind of claim that breaks on one OS
// build in the desert. Forty lines of loop beats a polyfill dependency.

/** Same encoder as friendLink's, typed-array flavoured for the frame path. */
export function utf8Encode(s: string): Uint8Array {
  return new Uint8Array(encodeUtf8(s));
}
export function utf8Decode(b: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let code: number;
    if (c < 0x80) {
      code = c;
      i += 1;
    } else if (c < 0xe0) {
      code = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f);
      i += 2;
    } else if (c < 0xf0) {
      code = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      i += 3;
    } else {
      code =
        ((c & 0x07) << 18) |
        ((b[i + 1] & 0x3f) << 12) |
        ((b[i + 2] & 0x3f) << 6) |
        (b[i + 3] & 0x3f);
      i += 4;
    }
    if (code >= 0x10000) {
      code -= 0x10000;
      s += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      s += String.fromCharCode(code);
    }
  }
  return s;
}

// The alphabet is stated once, in src/util/base64.ts — see there for why
// this tree has two of them and why they must never be merged.
import { decodeB64Standard, encodeB64Standard } from '../util/base64';
import { encodeUtf8 } from '../util/utf8';

// Shared with radio.ts via src/util/base64.ts — see there for why one
// implementation replaced two, and what proved the merge safe.
export const b64Encode = encodeB64Standard;

export const b64Decode = decodeB64Standard;

// ------------------------------------------------------------- chunking

/** Split one JSON message into wire-ready base64 chunks. */
export function encodeSignalChunks(msgId: number, json: string): string[] {
  const bytes = utf8Encode(json);
  const total = Math.max(1, Math.ceil(bytes.length / SIGNAL_CHUNK_DATA_MAX));
  if (total > 0xff) {
    // ~150 KB of JSON in a control message is a bug upstream, not a
    // bigger buffer's job. Refuse loudly; nothing legitimate gets here.
    throw new Error('signal message too large');
  }
  const chunks: string[] = [];
  for (let i = 0; i < total; i++) {
    const slice = bytes.subarray(
      i * SIGNAL_CHUNK_DATA_MAX,
      (i + 1) * SIGNAL_CHUNK_DATA_MAX,
    );
    const c = new Uint8Array(SIGNAL_CHUNK_HEADER + slice.length);
    c[0] = (msgId >>> 24) & 0xff;
    c[1] = (msgId >>> 16) & 0xff;
    c[2] = (msgId >>> 8) & 0xff;
    c[3] = msgId & 0xff;
    c[4] = i;
    c[5] = total;
    c.set(slice, SIGNAL_CHUNK_HEADER);
    chunks.push(b64Encode(c));
  }
  return chunks;
}

interface Partial {
  total: number;
  got: Map<number, Uint8Array>;
}

/** In-flight incomplete messages held at once. A message that permanently
 * lost a chunk (UDP on a lossy playa link, sender gone mid-SDP) otherwise
 * kept its buffers for the process lifetime — the "bounded memory" note
 * below was only true of the done-id half. A live message evicted at the
 * bound costs one retransmit round; SIGNAL_MAX_TRIES bounds live messages
 * per peer to single digits, so 32 is generous. */
export const SIGNAL_MAX_PARTIALS = 32;

/**
 * Reassembles chunked messages, tolerant of loss-driven retransmission:
 * duplicate chunks are ignored, chunks arrive in any order, and a message
 * id that already completed is never delivered twice (retransmits of an
 * already-heard message must be re-ACKed by the caller, not re-acted-on).
 */
export class SignalReassembler {
  private partials = new Map<number, Partial>();
  private done: number[] = [];
  private doneSet = new Set<number>();

  /** Feed one wire chunk. A completed NEW message comes back with its
   * JSON; a chunk of an ALREADY-delivered message comes back as dup:true
   * (the peer retransmitting means our ack was lost — the caller must
   * re-ack, or the sender retries to death over a message we heard);
   * anything else is null. */
  feed(
    chunk: Uint8Array,
  ): { msgId: number; json: string; dup?: boolean } | null {
    if (chunk.length < SIGNAL_CHUNK_HEADER) {
      return null;
    }
    const msgId =
      ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0;
    const idx = chunk[4];
    const total = chunk[5];
    if (total === 0 || idx >= total) {
      return null; // torn header — drop, like every other bad frame
    }
    if (this.doneSet.has(msgId)) {
      return { msgId, json: '', dup: true };
    }
    let p = this.partials.get(msgId);
    if (!p) {
      if (this.partials.size >= SIGNAL_MAX_PARTIALS) {
        // Insertion order IS age for a Map: the oldest incomplete message
        // is the likeliest orphan. Mutation: drop this eviction — every
        // permanently chunk-lost message leaks its buffers forever.
        const oldest = this.partials.keys().next().value;
        if (oldest !== undefined) {
          this.partials.delete(oldest);
        }
      }
      p = { total, got: new Map() };
      this.partials.set(msgId, p);
    }
    if (p.total !== total || p.got.has(idx)) {
      return null; // conflicting header, or a duplicate of a chunk we hold
    }
    p.got.set(idx, chunk.subarray(SIGNAL_CHUNK_HEADER));
    if (p.got.size < p.total) {
      return null;
    }
    this.partials.delete(msgId);
    this.markDone(msgId);
    let len = 0;
    for (const part of p.got.values()) {
      len += part.length;
    }
    const all = new Uint8Array(len);
    let at = 0;
    for (let i = 0; i < p.total; i++) {
      const part = p.got.get(i)!;
      all.set(part, at);
      at += part.length;
    }
    return { msgId, json: utf8Decode(all) };
  }

  private markDone(msgId: number): void {
    this.doneSet.add(msgId);
    this.done.push(msgId);
    // Bounded memory: a call's whole life is a few dozen messages, so 256
    // remembered ids outlives any retransmit window by orders of magnitude.
    while (this.done.length > 256) {
      this.doneSet.delete(this.done.shift()!);
    }
  }
}

// ------------------------------------------------------- reliable delivery

/** Retransmit cadence. LAN/Aware RTTs are single-digit ms; one second is
 * generous and keeps a lossy channel's chatter negligible. */
export const SIGNAL_RETRY_MS = 1000;

/** Tries before a message is declared dead. Eight seconds of unbroken
 * silence from a phone we discovered seconds ago is a gone phone. */
export const SIGNAL_MAX_TRIES = 8;

/**
 * HOW MANY DATAGRAM ROWS ONE TRANSMISSION MAY RIDE (docs/VIDEO-CALLS.md
 * §2a). The native side ranks a podmate's rows by proof and takes the best
 * `fanout` of them; the receiver dedupes by message id, so a second copy is
 * free correctness-wise and costs one extra ≤606-byte datagram.
 *
 * TWO, and the bound is the whole design. The liveness lane (WALKIE-LADDER
 * §5b) shrank the lying-row window from forever to ~12 s — probe cadence
 * 4.5 s plus the 10 s staleness window — but did not close it: a signal
 * fired in the first seconds after a path goes silently dead still has a
 * PROVEN-looking row to exhaust all eight retransmits into. Spreading the
 * retransmits over the two best rows means the second copy rides a
 * different radio, which is the only thing that helps when the loss is a
 * property of the road rather than of the moment.
 *
 * Above two the arithmetic inverts: a podmate rarely holds three datagram
 * rows at all, and a signaler that sprayed every row would put a call's
 * whole control channel on a link the ladder deliberately demoted.
 */
export const SIGNAL_HEDGE_FANOUT = 2;

interface Pending {
  env: SignalEnvelope;
  chunks: string[];
  tries: number;
  nextAt: number;
}

/**
 * One reliable channel to ONE peer. Owns msg ids, retransmission and
 * dedupe; time is injected through tick(now) so tests own the clock.
 *
 * `sendRaw` takes a FANOUT — how many of the peer's datagram rows this one
 * transmission may ride (§2a). First tries are singles; retransmissions
 * spread, because a retransmission is by definition evidence that the road
 * we chose is not delivering.
 */
export class ReliableSignaler {
  private pending = new Map<number, Pending>();
  private assembler = new SignalReassembler();
  /** Set by noteSendMiss(): the native side told us the best row is dead,
   * so even a brand-new message's FIRST send spreads. Cleared by any
   * inbound frame — that is a row proving itself. */
  private hedged = false;

  constructor(
    private sendRaw: (payloadB64: string, fanout: number) => void,
    private onMessage: (env: SignalEnvelope) => void,
    private onDead: (env: SignalEnvelope) => void,
    private nextId: () => number = () =>
      Math.floor(Math.random() * 0x100000000) >>> 0,
  ) {}

  /** Queue a message for delivery-until-acked and send it now. */
  post(env: SignalEnvelope, now: number): void {
    const id = this.nextId();
    const chunks = encodeSignalChunks(id, JSON.stringify({ ...env, id }));
    this.pending.set(id, {
      env,
      chunks,
      tries: 1,
      nextAt: now + SIGNAL_RETRY_MS,
    });
    this.transmit(chunks, this.width());
  }

  /**
   * THE SEND ITSELF FAILED — the native side refused, and the reason it
   * refuses that matters here is `stale`: no row for this podmate has
   * proven itself alive (WALKIE-LADDER §5). The runtime calls this from
   * the send promise's rejection.
   *
   * Two things it deliberately does NOT do:
   *
   * - it does not touch `tries` or `nextAt`. A refused send is loss, and
   *   loss is what the retransmit clock already exists for. Counting a
   *   reject as an extra try, or pulling the next try forward, would spend
   *   the eight-try budget in less wall-clock time and hand the caller
   *   "no answer" EARLIER than a silent drop does — the opposite of the
   *   bug being fixed.
   * - it does not call onDead. A signaler that dies on the first stale
   *   reject cannot outlive the ~12 s demotion window it exists to cross;
   *   the row it is waiting on comes back the moment one probe answers.
   *
   * What it does do is widen: every send from here on rides both of the
   * podmate's best rows, so the copy the dead row swallows still has a
   * second road out.
   */
  noteSendMiss(): void {
    this.hedged = true;
  }

  /** Rows one transmission may ride right now. */
  private width(): number {
    return this.hedged ? SIGNAL_HEDGE_FANOUT : 1;
  }

  /** The single place a payload reaches the wire — so the fanout bound is
   * enforced once, here, and not re-argued at four call sites. */
  private transmit(chunks: string[], fanout: number): void {
    const rows = Math.max(1, Math.min(fanout, SIGNAL_HEDGE_FANOUT));
    for (const c of chunks) {
      this.sendRaw(c, rows);
    }
  }

  /** True while anything still wants retransmission. */
  busy(): boolean {
    return this.pending.size > 0;
  }

  /** Retransmit whatever is due. Call on a coarse timer while busy(). */
  tick(now: number): void {
    for (const [id, p] of this.pending) {
      if (now < p.nextAt) {
        continue;
      }
      if (p.tries >= SIGNAL_MAX_TRIES) {
        this.pending.delete(id);
        this.onDead(p.env);
        continue;
      }
      p.tries += 1;
      p.nextAt = now + SIGNAL_RETRY_MS;
      // FROM THE SECOND TRANSMISSION ON, CHANGE ROAD (§2a). We are here
      // because the first copy was not acked, and the field failure says
      // the likeliest reason is not a dropped packet but a dead row. The
      // first try stayed single so an ordinary call — the overwhelmingly
      // common one — costs exactly what it always did.
      this.transmit(p.chunks, SIGNAL_HEDGE_FANOUT);
    }
  }

  /** Feed one received wire payload (base64, PW payload bytes). */
  receive(payloadB64: string, now: number): void {
    // A frame from this podmate is a row proving itself: whatever the
    // native side ranks best right now demonstrably carried something.
    // Back to singles until something says otherwise.
    this.hedged = false;
    const complete = this.assembler.feed(b64Decode(payloadB64));
    if (!complete) {
      return;
    }
    if (complete.dup) {
      // The peer is retransmitting a message we already delivered — our
      // ack was lost. Re-ack, never re-deliver.
      //
      // AND SPREAD THE RE-ACK (§2a). This is the measured failure seen
      // from the OTHER phone: P7 heard P9's invite and acked it eight
      // times, every ack into P7's own dead aware row for P9, while P9
      // read "No answer". A re-ack IS a retransmission — the first one
      // did not arrive — so it earns the same second road.
      this.transmit(
        encodeSignalChunks(
          this.nextId(),
          JSON.stringify({ t: 'ack', of: complete.msgId }),
        ),
        SIGNAL_HEDGE_FANOUT,
      );
      return;
    }
    let env: SignalEnvelope;
    try {
      env = JSON.parse(complete.json) as SignalEnvelope;
    } catch {
      return; // a torn or foreign payload is dropped, never thrown
    }
    if (env.t === 'ack') {
      const acked = typeof env.of === 'number' ? env.of : -1;
      this.pending.delete(acked >>> 0);
      return;
    }
    // Ack BEFORE delivering: even if the handler throws, the peer must
    // stop retransmitting a message we have fully heard. Acks are fire-
    // and-forget (never retried, never acked back) — a lost ack just
    // means one more harmless retransmit, which dedupe absorbs.
    this.transmit(
      encodeSignalChunks(
        this.nextId(),
        JSON.stringify({ t: 'ack', of: complete.msgId }),
      ),
      this.width(),
    );
    void now;
    this.onMessage(env);
  }

  /** Drop everything in flight (call ended, peer gone). */
  reset(): void {
    this.pending.clear();
    this.hedged = false;
  }
}
