/**
 * llama.rn integration: model loading, prompt-and-ordered-tool-schema-keyed
 * KV warm-up, the tool-calling chat loop, and context-overflow retry.
 *
 * Configuration follows the validated prototype (toolcall-proto-results.md)
 * plus the Pixel 7 bench (corpus-archive/2026-08-13-pixel7-lfm25-bench):
 *   - thinking ON (no-think collapses routing precision) and UNCAPPED — the
 *     graded v1.6 config ran without a thinking budget (EVAL-v16; the
 *     harness cannot budget server-side) and v1.6's trained thinks are
 *     short by construction; the r5-era 96/64 caps were a phone-latency
 *     workaround for v1.1's rambling thinks and would now cut into the
 *     graded behavior. The staged status line narrates the think phase.
 *   - temp 0.1, top_k 50, repeat penalty 1.1; min_p omitted
 *   - n_predict 2048 (thinking shares the completion budget; 600 starved finals)
 *   - 4 threads pinned (Pixel 7: thread scaling INVERTS past 4 — A55 cores hurt)
 *   - CPU default on Android, Metal on iOS; Vulkan stays an experiment flag
 *   - tool loop capped at TOOL_ROUND_CAP=2; multi-tool-call arrays handled
 *   - WARM-UP IS MANDATORY: prefill of a ~200-token system prompt costs ~16s
 *     on a Pixel 7, so the processed prefix is keyed by the GGUF fingerprint,
 *     system prompt, and ordered tool schema, then reloaded for ~1-2s TTFT.
 *     The model stays RESIDENT for the whole app session; never release
 *     between messages. The ONE deliberate exception is unload() — the
 *     camper putting the Angel to rest on a small phone (llm/angelRest.ts),
 *     which is a decision, not a between-messages economy.
 *   - context-overflow retry ported from iBurn's withContextWindowRetry:
 *     halve the tool-result candidates and retry, floor 2.
 *
 * The llama.rn calls typecheck against 0.12.8's published API. Native behavior
 * still requires a real-phone build and run; TypeScript cannot prove it.
 */

import { isFactualTurn, groundingTopic } from './groundingFloor';
import { Platform } from 'react-native';
import { initLlama, LlamaContext, ToolCall } from 'llama.rn';
import {
  DocumentDirectoryPath,
  exists,
  hash,
  mkdir,
  readDir,
  stat,
  unlink,
} from '@dr.pogodin/react-native-fs';
import type {
  ChatCard,
  EventRow,
  EventSearchOutcome,
  ModelStatus,
  PersonRef,
  SourceRef,
} from '../types';
import { loadFailureMessage } from './loadFailure';
import { mergeSourceRefs } from '../docs/sourceRef';
import { sha256Hex } from '../camp/hmac';
import { identityAffiliationTerms } from '../events/db';
import { ALL_TOOLS, LOOKUP_HISTORY_TOOL } from './tools';
import { getPersona, Persona } from './personas';
import {
  ThinkFilter,
  streamChunkFromPartial,
  stripResidualMarkup,
} from './thinkFilter';
import { executeTool, type ToolOutcome } from './toolExecutor';
import {
  authoritativeEventSearches,
  eventFollowUp,
  eventFollowUpHasTemporalConstraint,
  reconcileEventNarration,
  type EventFollowUpField,
} from './eventNarration';
import {
  absentNarration,
  campHistoryAbsenceNarration,
  personAmbiguityNarration,
  personCardUnavailableNarration,
  personNotFoundNarration,
  structuredCardNarration,
  nothingFoundNarration,
  NOTHING_FOUND,
  NO_ANSWER,
  FOUND_UNWRITTEN,
} from './factNarration';
import {
  historyToolArgs,
  historyToolPlans,
  splitClauses,
  type HistoryToolArgs,
  type HistoryToolPlan,
} from './historyIntent';
import { lookupHistory } from '../facts/historyLookup';
import { identityIntent, type IdentityIntent } from './identityIntent';
import {
  lookupPersonIdentity,
  type PersonIdentityCandidate,
  type PersonIdentityOutcome,
} from '../facts/personIdentity';
import type {
  HistoryAbsence,
  HistoryAmbiguity,
} from '../facts/historyLookup';
import { personAnchorFromCards } from './priorPerson';
import {
  eventClarificationQuery,
  eventSearchQuery,
  isEventRequest,
  isFactualEventRequest,
  shouldRouteEventSearch,
  splitEventClauses,
  type PendingEventQuery,
} from './eventClarification';
import { isNoToolFailure, refersToPriorFailure } from './inferenceHistory';
import { parseDayOnly } from '../events/timeParser';
import {
  enabledTitleSpans,
  exactTitleSearchQuery,
  isEnabledEventTitleRequest,
  replaceEventDayCoordinate,
  replaceEventTemporalCoordinates,
} from '../events/searchEvents';
import { logChat, logSystemNote, rotateChatSession } from '../log/chatLog';

/** Vendor sampler per the LFM2.5-2.6B generation_config (RESEARCH-TOOL-ROUTING.md
 * MUST-DO #4): temp 0.1 / top_k 50 / repeat_penalty 1.1, min_p dropped — the
 * old 0.3/0.15 pair was the LFM2-generation recipe and sat outside the current
 * card's band; Liquid benchmarks agentic tool use near-greedy. Mirrored in the
 * offline eval harness so gate runs measure the shipping config.
 * Do not lower n_predict below 1024. */
export const SAMPLER = {
  temperature: 0.1,
  top_k: 50,
  penalty_repeat: 1.1,
  n_predict: 2048,
} as const;

/** Max tool-execution rounds before forcing a no-tools final answer. */
export const TOOL_ROUND_CAP = 2;

/** At the tool-round cap, tools are withdrawn. Without an explicit cue the
 * model can keep emitting tool grammar as plain text, which the stream filter
 * removes and leaves an empty answer. Append one instruction to the final
 * tool result so the model knows lookup is over and must answer. It stays in
 * the tool message because some chat templates reject a second user turn or
 * a later system turn. The operation is idempotent and must be re-applied if
 * a context-overflow retry rewrites the tool message. */
export const FORCED_FINAL_NUDGE =
  '\n\n[Angel: lookups are finished -- no more tools. Answer the user now from ' +
  'the results above and what you know for certain about Black Rock City. ' +
  'If you do not actually know, say so plainly in one sentence.]';

export function nudgeLastToolMessage(messages: Array<{ role: string; content: string }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      if (!messages[i].content.endsWith(FORCED_FINAL_NUDGE)) {
        messages[i] = { ...messages[i], content: messages[i].content + FORCED_FINAL_NUDGE };
      }
      return true;
    }
  }
  return false;
}

/** On context overflow, halve result candidates and retry, floor two. */
const CANDIDATE_FLOOR = 2;

const N_CTX = 8192;
/** Pixel 7 bench: performance inverts past 4 threads (little cores hurt). */
const N_THREADS = 4;

/** A phone below this is memory-constrained for a ~1.4 GB model plus the
 * app's live indexes: it gets a smaller KV cache and, on iOS, an
 * unwired model. 6 GB is the same floor the smart tier uses. */
const CONSTRAINED_RAM_BYTES = 6 * 1024 * 1024 * 1024;
/** KV cache scales linearly with context; 4096 halves it versus 8192 and
 * still holds this app's turns (the context-overflow retry evicts if a
 * long thread ever needs it). */
const N_CTX_CONSTRAINED = 4096;

/**
 * The model-load memory profile, adapted to the device (owner field
 * report 2026-08-25: an iPhone mini — 4 GB — crashed setting up, hard at
 * "hold to talk", and eased when other apps were closed: textbook iOS
 * jetsam). Two levers:
 *
 *  - use_mlock WIRES the whole model in physical RAM so the OS can never
 *    page it. On a big Android phone that is a latency win; on a 4 GB
 *    iPhone it is exactly wrong — it defeats mmap, so the model plus the
 *    audio buffers "hold to talk" allocates cannot be reclaimed and the
 *    process is jetsam-killed. mlock stays ON only where RAM is ample AND
 *    the OS is not iOS (Metal already keeps its own resident copy).
 *  - n_ctx sizes the KV cache; a constrained phone takes the smaller one.
 *
 * The verified Pixel path (8 GB+) is unchanged: ample RAM, Android → 8192
 * + mlock, exactly as before.
 */
async function memoryProfile(): Promise<{ nCtx: number; useMlock: boolean }> {
  // Unknown RAM → assume constrained: the safe direction for the load
  // PARAMETERS is the smaller footprint, never the crash. (The auto-load
  // gate reads the same probe the other way round — see
  // memoryConstrainedDevice for why the two disagree on purpose.)
  const totalRam = await totalDeviceRam();
  const constrained = totalRam === null || totalRam < CONSTRAINED_RAM_BYTES;
  return {
    nCtx: constrained ? N_CTX_CONSTRAINED : N_CTX,
    useMlock: !constrained && Platform.OS !== 'ios',
  };
}

/**
 * Total physical RAM in bytes, or null when this phone cannot say.
 *
 * A phone that answers 0 (or a negative, or nothing at all — the shapes
 * platforms use for "I don't know") has not MEASURED itself, so it reads as
 * unknown here rather than as the smallest phone ever made.
 */
async function totalDeviceRam(): Promise<number | null> {
  try {
    // Required LAZILY: a module-level import of device-info constructs a
    // NativeEventEmitter at import time, which drags a native mock into
    // every suite that merely imports this session. The probe is once per
    // load, so the require cost is irrelevant.
    const deviceInfo = require('react-native-device-info').default;
    const total: unknown = await deviceInfo.getTotalMemory();
    return typeof total === 'number' && Number.isFinite(total) && total > 0
      ? total
      : null;
  } catch {
    return null;
  }
}

/**
 * Is this phone MEASURED below the constrained boundary? That is the gate on
 * whether the Angel loads herself at startup (llm/angelRest.ts) — owner field
 * report 2026-08-25, a 4 GB iPhone jetsam-killed three times with ~1.4 GB of
 * model resident, and still slow after the memory fix.
 *
 * SAME boundary as memoryProfile, OPPOSITE handling of "don't know", and the
 * difference is deliberate: a wrong profile costs a smaller KV cache, while a
 * wrong gate costs the camper their Angel entirely. So a phone that cannot
 * answer keeps the behaviour it had before this rule existed (she loads),
 * while a phone that ANSWERS 4 GB gets the rest.
 */
export async function memoryConstrainedDevice(): Promise<boolean> {
  const totalRam = await totalDeviceRam();
  return totalRam !== null && totalRam < CONSTRAINED_RAM_BYTES;
}
/** Flip to experiment with GPU decode on Android (Vulkan: better tg, worse pp). */
const ANDROID_GPU_EXPERIMENT = false;

export interface ChatTurnResult {
  text: string;
  /** App-owned cards from tool calls; dates and counts never come from prose. */
  cards: ChatCard[];
  /** The passages this answer stood on, for the tappable source chips.
   * Empty on an untooled turn — an answer with no retrieval cites nothing. */
  sources: SourceRef[];
  /** Present only when search_events ran; an empty-state member is an
   * authoritative zero, while absence means no event search occurred. */
  eventSearches?: EventSearchOutcome[];
  completion?: 'recovered-after-tool-error';
  toolRounds: number;
  /** WHICH ONE IT USED — the Ranger says whether it read the binder or
   * spoke from memory (owner, 2026-08-17: "smarts augmented by what you can
   * look up, just like a Ranger"). 'packs' = cards or passages stand under
   * the answer; 'app' = the app's own honest close (nothing found / no
   * answer / person absent); 'memory' = the model's prose with nothing
   * retrieved under it. The bubble marks 'memory' so a stale-weights leak
   * is never mistaken for a looked-up fact. */
  answeredFrom: 'packs' | 'app' | 'memory';
}

export interface TurnCallbacks {
  /** User-visible streamed text (reasoning filtered out). */
  onToken?: (visible: string) => void;
  /** True while the model is inside a thinking block. */
  onThinking?: (thinking: boolean) => void;
  /** Fired when a tool starts executing, for a UI status chip. `forced` marks
   * an APP-SUPPLIED call (a clarified event search, or either deterministic
   * pre-route): whatever prose the model already streamed this turn was
   * written WITHOUT the tool result, so the UI drops it. */
  onToolCall?: (name: string, forced: boolean) => void;
  /** Fired when a tool's execution finished and its results are being fed
   * back — the long tail after this is the round-2 prefill+think ("reading
   * what I found…" in the staged status line). `cards` is what the executor
   * actually produced: lookup_facts only becomes a card turn once a person
   * card came back, which is knowable here and not at onToolCall. `sources`
   * is the provenance, handed over the instant retrieval lands (the presence
   * rule: show what was found before the prose catches up). */
  onToolDone?: (name: string, cards: ChatCard[], sources: SourceRef[]) => void;
}

/** Message shape for the chat template; llama.rn's own message type does not
 * declare tool_calls/name, but jinja templates consume them — validate on
 * device. */
interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  name?: string;
  /** The think the model actually generated on a tool-call turn, fed back
   * so the template re-renders that turn BYTE-IDENTICAL to what was
   * generated (LFM2.5's template: `<think>{reasoning_content}</think>` +
   * content + tool calls, kept for turns after the last user message).
   * Without it the fed-back turn diverges from the KV cache at the first
   * assistant position and every later round re-prefills the whole tail —
   * measured 2026-08-17 (Pixel 7): 1,619 tokens / 42 s re-processed on a
   * forced final whose own new tokens were ~100. Never persisted to
   * history (the next turn's prompt drops prior thinks by template rule). */
  reasoning_content?: string;
}

/** The one line under a person card when a compound question's relational
 * half returned records; the records themselves are the cards below. */
function relationalFollowUpLine(query: HistoryToolArgs['query']): string {
  switch (query) {
    case 'sponsees':
      return 'The people they sponsored are below.';
    case 'sponsors':
      return 'Their sponsorship lineage is below.';
    case 'attendance':
      return 'Their years at camp are below.';
    case 'projects':
      return 'Their projects are below.';
    case 'path':
      return 'The sponsorship path is below.';
    default:
      return 'The camp-history records are below.';
  }
}

interface HistoryTurn {
  user: ChatMsg;
  assistant: ChatMsg;
  /** THE RAW THREAD (owner's design, 2026-08-18): everything this turn put
   * in front of the model — the user message (as prompted), the tool-call
   * assistant messages with their reasoning, the tool results, and the
   * final. History replays these verbatim, so the model's context across
   * turns is real grounded material, not a drumbeat of its own terse
   * finals. The curated user/assistant pair (above) remains for features
   * that read finals (echo guard, IDK trims, logging) — the pair is a VIEW,
   * the raw slice is the context. */
  raw: ChatMsg[];
  noToolFailure: boolean;
  omitFromInference: boolean;
}

/** History token budget (chars/4 heuristic + per-message overhead). N_CTX
 * 8192 minus the system prompt (~700) minus the current turn's workspace
 * (fresh tool payloads + generation headroom ~3400) leaves ~4000 for prior
 * turns. Whole turns are evicted oldest-first; an evicted turn breaks the
 * KV prefix once, an un-evicted thread replays from cache. */
const HISTORY_TOKEN_BUDGET = 4000;
const estimateTokens = (msgs: ChatMsg[]): number =>
  msgs.reduce(
    (n, m) =>
      n +
      8 +
      Math.ceil(
        ((m.content?.length ?? 0) +
          ((m as { reasoning_content?: string }).reasoning_content?.length ?? 0) +
          JSON.stringify((m as { tool_calls?: unknown }).tool_calls ?? '').length) / 4,
      ),
    0,
  );

/** Sampler config as stored on each logged assistant row — the config that
 * produced that specific completion, resolved at write time. The think
 * The absence of budget fields is itself information: a logged row
 * without them ran the graded uncapped config this build ships. */
const samplerJson = (): string => JSON.stringify(SAMPLER);

/** Per-completion measurement kept for the assistant row's timings_json.
 * Everything here is read straight off llama.rn's completion result —
 * timings (prompt_n/prompt_ms/predicted_n/...) plus the top-level token
 * counts; reasoning_content contributes only its LENGTH (the thinking text
 * itself is never logged). */
interface RoundStat {
  round: number;
  timings: unknown;
  tokens_evaluated: number | null;
  tokens_predicted: number | null;
  thinking_chars: number;
  tool_calls: string[];
  context_full: boolean;
  interrupted: boolean;
}

/** Collision-resistant stable key for serialized warm-up inputs. */
export function promptHash(text: string): string {
  return sha256Hex(text);
}

export function warmedSessionHash(
  modelFingerprint: string,
  systemPrompt: string,
  tools: readonly unknown[] = ALL_TOOLS,
): string {
  return promptHash(`${modelFingerprint}\0${systemPrompt}\0${JSON.stringify(tools)}`);
}

export async function modelFileFingerprint(modelPath: string): Promise<string> {
  const file = await stat(modelPath);
  const digest = await hash(modelPath, 'sha256');
  return promptHash(
    [
      modelPath,
      file.originalFilepath,
      file.size,
      file.mtime.getTime(),
      file.ctime?.getTime?.() ?? 'unknown-ctime',
      digest,
    ].join('\0'),
  );
}

type TurnAuthorityPolicy = 'ordinary' | 'event' | 'history' | 'identity';

/** Only shapes whose no-tool status is part of their meaning may skip the tool
 * selector and stream immediately. Everything else gets one buffered routing
 * completion so broad requests such as “where can I dance?” can still select
 * authoritative local tools without leaking a preamble. */
function isConversationalNoTool(text: string): boolean {
  return /^\s*(?:hi|hello|hey|howdy|thanks|thank you|good (?:morning|afternoon|evening)|how are you)[!?.\s]*$/i.test(text);
}

/** Keep the turn-wide event cap without letting an early broad search erase a
 * later distinct positive query. One row per semantic query is admitted first,
 * then remaining slots are filled round-robin in tool-result order. */
function cappedEventCards(
  results: readonly Pick<ToolOutcome, 'cards' | 'eventSearch'>[],
  cap: number,
): ChatCard[] {
  const groups = new Map<string, Extract<ChatCard, { kind: 'event' }>[]>();
  for (const result of results) {
    const cards = result.cards.filter(
      (card): card is Extract<ChatCard, { kind: 'event' }> => card.kind === 'event',
    );
    if (cards.length === 0) {
      continue;
    }
    const search = result.eventSearch;
    const key = JSON.stringify([search?.query ?? '', search?.window ?? null]);
    const group = groups.get(key) ?? [];
    const ids = new Set(group.map(card => card.event.id));
    group.push(...cards.filter(card => {
      if (ids.has(card.event.id)) {
        return false;
      }
      ids.add(card.event.id);
      return true;
    }));
    groups.set(key, group);
  }

  const queues = [...groups.values()].map(cards => [...cards]);
  const selected: Extract<ChatCard, { kind: 'event' }>[] = [];
  const seen = new Set<number>();
  while (selected.length < cap && queues.some(queue => queue.length > 0)) {
    for (const queue of queues) {
      let card = queue.shift();
      while (card && seen.has(card.event.id)) {
        card = queue.shift();
      }
      if (!card) {
        continue;
      }
      selected.push(card);
      seen.add(card.event.id);
      if (selected.length === cap) {
        break;
      }
    }
  }
  return selected;
}

export class LlamaSession {
  private context: LlamaContext | null = null;
  /** Every native context stays here until release resolves successfully. */
  private ownedContexts = new Set<LlamaContext>();
  /** Candidates still initializing must not be retired by another load. */
  private loadingContexts = new Set<LlamaContext>();
  private releaseAttempts = new Map<LlamaContext, Promise<void>>();
  private activeContexts = new Map<LlamaContext, number>();
  private contextIdleWaiters = new Map<LlamaContext, Set<() => void>>();
  private pendingLoads = new Set<Promise<boolean>>();
  private loadGeneration = 0;
  private persistedGeneration: number | null = null;
  private persistedSessionFile: string | null = null;
  private previousSessionFile: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private initializationQueue: Promise<void> = Promise.resolve();
  private replacementQueue: Promise<void> = Promise.resolve();
  private sessionFileQueues = new Map<string, Promise<void>>();
  private disposed = false;
  private persona: Persona;
  private desiredPersona: Persona;
  private history: HistoryTurn[] = [];
  private structuredEventHistoryTurn: HistoryTurn | null = null;

  /** True when the session carries prior exchanges. The UI half of the
   * transcript lives in ChatScreen state; this lets a freshly mounted
   * screen detect an orphaned session (ghost history) and heal the pair. */
  hasHistory(): boolean {
    return this.history.length > 0;
  }
  /**
   * THE PERSON ANCHOR — the last camper this session actually RESOLVED, and
   * the antecedent a later pronoun binds to (llm/priorPerson for the receipt
   * and the reasoning). Set only from the app's own structured results — a
   * rendered person card, or an exact fact-graph match — never scraped from
   * text, and cleared wherever the transcript is.
   */
  private lastPersonEntity: PersonRef | null = null;
  /** Final deduped rows from the most recent authoritative event turn. Reserved
   * date/time/location follow-ups read only this state, never model prose. */
  private lastEventResults: EventRow[] = [];
  /** Requested reserved field retained while the user disambiguates an event. */
  private pendingEventFollowUp: EventFollowUpField | null = null;
  private pendingEventQuery: PendingEventQuery | null = null;
  private modelName: string | null = null;
  private modelFingerprint: string | null = null;
  /** A failed persona rollback leaves the resident weights reusable, but its
   * recurrent prefix cannot be trusted until a later switch prepares one. */
  private personaRecoveryError: Error | null = null;

  constructor(personaId: string) {
    this.persona = getPersona(personaId);
    this.desiredPersona = this.persona;
  }

  get isReady(): boolean {
    return !this.disposed && this.context !== null && this.personaRecoveryError === null;
  }

  /** The loaded model's filename, for status restoration after a failed
   * download (a failed pull must never brick a resident model). */
  get loadedModelName(): string | null {
    return this.modelName;
  }

  get personaId(): string {
    return this.persona.id;
  }

  private sessionFile(fingerprint = this.modelFingerprint, persona = this.persona): string {
    if (!fingerprint) {
      throw new Error('Cannot restore a warmed session before model identification.');
    }
    return `${DocumentDirectoryPath}/sessions/${warmedSessionHash(
      fingerprint,
      persona.systemPrompt,
    )}.llama-session`;
  }

  /** Bound warm-cache growth after confirmed persistence while retaining one
   * prior prefix for fast model/persona rollback. */
  private async pruneWarmedSessions(generation: number): Promise<void> {
    if (
      generation !== this.loadGeneration ||
      generation !== this.persistedGeneration ||
      this.context === null ||
      this.modelFingerprint === null
    ) {
      return;
    }
    const keep = new Set([
      this.sessionFile(),
      ...(this.previousSessionFile ? [this.previousSessionFile] : []),
    ]);
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(`${DocumentDirectoryPath}/sessions`);
    } catch (error) {
      console.warn('[llm] failed to list warmed sessions for pruning:', error);
      return;
    }
    const stale = entries.filter(entry =>
      entry.isFile() &&
      entry.name.endsWith('.llama-session') &&
      !keep.has(entry.path),
    );
    for (const entry of stale) {
      if (
        generation !== this.loadGeneration ||
        generation !== this.persistedGeneration
      ) {
        return;
      }
      try {
        await unlink(entry.path);
      } catch (error) {
        console.warn(`[llm] failed to prune warmed session ${entry.path}:`, error);
      }
    }
  }

  private queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => {}, () => {});
    return result;
  }

  private queueInitialization<T>(initialize: () => Promise<T>): Promise<T> {
    const result = this.initializationQueue.then(initialize, initialize);
    this.initializationQueue = result.then(() => {}, () => {});
    return result;
  }

  private queueReplacement<T>(replace: () => Promise<T>): Promise<T> {
    const result = this.replacementQueue.then(replace, replace);
    this.replacementQueue = result.then(() => {}, () => {});
    return result;
  }

  private queueSessionFile<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const queue = this.sessionFileQueues.get(file) ?? Promise.resolve();
    const result = queue.then(operation, operation);
    const settled = result.then(() => {}, () => {});
    this.sessionFileQueues.set(file, settled);
    return result.finally(() => {
      if (this.sessionFileQueues.get(file) === settled) {
        this.sessionFileQueues.delete(file);
      }
    });
  }

  private invalidateLoads(): void {
    ++this.loadGeneration;
    for (const loading of this.loadingContexts) {
      loading.stopCompletion().catch(error => {
        console.warn('[llm] failed to stop superseded warm-up:', error);
      });
    }
  }

  private leaseContext(context: LlamaContext): () => void {
    this.activeContexts.set(context, (this.activeContexts.get(context) ?? 0) + 1);
    return () => {
      const remaining = (this.activeContexts.get(context) ?? 1) - 1;
      if (remaining > 0) {
        this.activeContexts.set(context, remaining);
        return;
      }
      this.activeContexts.delete(context);
      const waiters = this.contextIdleWaiters.get(context);
      this.contextIdleWaiters.delete(context);
      waiters?.forEach(resolve => resolve());
    };
  }

  private waitForContextIdle(context: LlamaContext): Promise<void> {
    if (!this.activeContexts.has(context)) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const waiters = this.contextIdleWaiters.get(context) ?? new Set();
      waiters.add(resolve);
      this.contextIdleWaiters.set(context, waiters);
    });
  }

  private async retireContextAndWait(
    context: LlamaContext,
    detail: string,
    required = false,
  ): Promise<void> {
    try {
      await this.waitForContextIdle(context);
      await this.releaseOwned(context);
    } catch (error) {
      console.warn(`[llm] ${detail}:`, error);
      logSystemNote(
        this.persona.id,
        `${detail}; context remains owned and release() can retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (required) {
        throw error;
      }
    }
  }

  private retireContext(context: LlamaContext, detail: string): void {
    this.retireContextAndWait(context, detail).catch(() => {});
  }

  /** A failed release remains owned and retryable; concurrent callers share one attempt. */
  private async releaseOwned(context: LlamaContext): Promise<void> {
    if (!this.ownedContexts.has(context)) {
      return;
    }
    let attempt = this.releaseAttempts.get(context);
    if (!attempt) {
      attempt = context.release().then(() => {
        this.ownedContexts.delete(context);
        if (this.context === context) {
          this.context = null;
          this.modelFingerprint = null;
          this.modelName = null;
          this.lastEventResults = [];
          this.pendingEventFollowUp = null;
        }
      });
      this.releaseAttempts.set(context, attempt);
      attempt.finally(() => {
        if (this.releaseAttempts.get(context) === attempt) {
          this.releaseAttempts.delete(context);
        }
      }).catch(() => {});
    }
    await attempt;
  }

  /**
   * Build replacements concurrently, then serialize publication by generation.
   * The resident context remains usable until the newest candidate is fully
   * restored/warmed. Superseded candidates never publish and are released.
   */
  load(modelPath: string, onStatus: (s: ModelStatus) => void): Promise<boolean> {
    if (this.disposed) {
      return Promise.reject(new Error('LlamaSession has been released.'));
    }
    this.invalidateLoads();
    const generation = this.loadGeneration;
    const candidate = this.queueInitialization(async () => {
      const retired = [...this.ownedContexts].filter(
        context => context !== this.context && !this.loadingContexts.has(context),
      );
      await Promise.all(retired.map(context =>
        this.retireContextAndWait(
          context,
          'failed to free retired context before replacement allocation',
          true,
        ),
      ));
      if (generation !== this.loadGeneration || this.disposed) {
        return false;
      }
      return this.loadCandidate(
        modelPath,
        onStatus,
        generation,
        this.desiredPersona,
        modelPath.split('/').pop() ?? modelPath,
      );
    });
    const task = candidate.finally(async () => {
      this.pendingLoads.delete(task);
      if (this.pendingLoads.size === 0) {
        await this.pruneWarmedSessions(this.loadGeneration);
      }
    });
    this.pendingLoads.add(task);
    return task;
  }

  private async loadCandidate(
    modelPath: string,
    onStatus: (s: ModelStatus) => void,
    generation: number,
    persona: Persona,
    modelName: string,
  ): Promise<boolean> {
    const publish = (status: ModelStatus): void => {
      if (generation === this.loadGeneration) {
        onStatus(status);
      }
    };
    publish({ state: 'loading', detail: 'Loading model…' });

    let candidate: LlamaContext | null = null;
    let published = false;
    try {
      const fingerprint = await modelFileFingerprint(modelPath);
      if (generation !== this.loadGeneration) {
        return false;
      }
      const profile = await memoryProfile();
      if (generation !== this.loadGeneration) {
        return false;
      }
      candidate = await initLlama(
        {
          model: modelPath,
          n_ctx: profile.nCtx,
          n_threads: N_THREADS,
          // Metal on iOS. Android runs CPU by default (Pixel 7: CPU -t4
          // pp 13.3 t/s beats Vulkan prefill; flip the experiment flag to
          // trade prefill for Vulkan's slightly better decode).
          n_gpu_layers:
            Platform.OS === 'ios' || ANDROID_GPU_EXPERIMENT ? 99 : 0,
          // Adapted to device RAM (memoryProfile): wired only where RAM is
          // ample and the OS is not iOS — the 4 GB-iPhone jetsam fix.
          use_mlock: profile.useMlock,
        },
        progress => publish({ state: 'loading', detail: `Loading model… ${progress}%` }),
      );
      this.ownedContexts.add(candidate);
      if (generation !== this.loadGeneration) {
        await this.retireContextAndWait(
          candidate,
          `failed to release superseded ${modelName} context`,
        );
        return false;
      }
      this.loadingContexts.add(candidate);
      let persisted = false;
      try {
        await mkdir(`${DocumentDirectoryPath}/sessions`);
        if (generation !== this.loadGeneration) {
          await this.retireContextAndWait(
            candidate,
            `failed to release superseded ${modelName} context`,
          );
          return false;
        }
        persisted = await this.restoreOrWarmUp(
          publish,
          candidate,
          fingerprint,
          persona,
          () => generation === this.loadGeneration,
        );
      } finally {
        this.loadingContexts.delete(candidate);
      }

      let retired: LlamaContext[] = [];
      await this.queueReplacement(async () => {
        if (
          generation !== this.loadGeneration ||
          persona.id !== this.desiredPersona.id ||
          this.disposed
        ) {
          await this.retireContextAndWait(
            candidate!,
            `failed to release superseded ${modelName} context`,
          );
          return;
        }
        if (this.persistedSessionFile) {
          this.previousSessionFile = this.persistedSessionFile;
        }
        this.context = candidate;
        this.modelFingerprint = fingerprint;
        this.modelName = modelName;
        this.persona = persona;
        this.persistedSessionFile = persisted
          ? this.sessionFile(fingerprint, persona)
          : null;
        this.persistedGeneration = persisted ? generation : null;
        this.personaRecoveryError = null;
        published = true;
        retired = [...this.ownedContexts].filter(
          context => context !== candidate && !this.loadingContexts.has(context),
        );
        logSystemNote(persona.id, `model loaded: ${modelName}`);
        publish({ state: 'ready', modelName });
      });

      for (const context of retired) {
        this.retireContext(context, `failed to release context retired by ${modelName}`);
      }
      return published;
    } catch (e) {
      const failure: unknown = e;
      if (candidate && !published && this.ownedContexts.has(candidate)) {
        this.retireContext(candidate, `failed to release ${modelName} after load error`);
      }
      if (generation !== this.loadGeneration) {
        return false;
      }
      const reason = failure instanceof Error ? failure.message : String(failure);
      logSystemNote(persona.id, `model load failed: ${reason}`);
      // CAMPER-ACTIONABLE ERRORS (P2-5): a raw native exception ("failed to
      // mmap model", "gguf tensor data offset is not within file bounds")
      // reads as a crash to a camper who can FIX it — full storage, a
      // truncated download, or a phone that can't hold the model. The raw
      // string stays in the console for diagnostics.
      console.warn('[llm] model load failed (raw):', reason);
      if (this.isReady) {
        const residentName = this.modelName ?? 'current model';
        publish({
          state: 'ready',
          modelName: residentName,
          detail: `Could not load ${modelName}; kept ${residentName} ready: ${reason}`,
        });
        throw failure;
      }
      publish({ state: 'error', detail: loadFailureMessage(reason) });
      throw failure;
    }
  }

  /**
   * MANDATORY warm-up (Pixel 7: ~16s prefill for a 200-token system prompt).
   * The saved KV filename hashes the model fingerprint, current prompt, and
   * ordered tool schema, so changing any warm-up input invalidates the prefix.
   */
  private async restoreOrWarmUp(
    onStatus: (s: ModelStatus) => void,
    ctx = this.context,
    fingerprint = this.modelFingerprint,
    persona = this.persona,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!ctx) {
      return false;
    }
    const file = this.sessionFile(fingerprint, persona);
    return this.queueSessionFile(file, () => this.restoreOrWarmUpUnlocked(
      onStatus,
      ctx,
      file,
      persona,
      isCurrent,
    ));
  }

  private async restoreOrWarmUpUnlocked(
    onStatus: (s: ModelStatus) => void,
    ctx: LlamaContext,
    file: string,
    persona: Persona,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) {
      return false;
    }
    if (await exists(file)) {
      try {
        await ctx.loadSession(file);
        return true;
      } catch (e) {
        console.warn('[llm] stale session ignored, clearing partial state before re-warming:', e);
        await ctx.clearCache(true);
      }
    }
    // Use the short persona label rather than its full display name so the
    // warm-up status stays concise and grammatical.
    onStatus({ state: 'loading', detail: `Warming up the ${persona.label}…` });
    // Evaluate only the chat-template prefix (n_predict: 0), so the persisted
    // KV state contains no sampled assistant token. Tools MUST be passed: the
    // template renders their ordered schemas into the prefix, so a tool-less
    // warm-up never matches a real chat turn and the saved state is useless
    // (device-validated 2026-08-13).
    await ctx.completion({
      messages: [{ role: 'system', content: persona.systemPrompt }],
      jinja: true,
      tools: ALL_TOOLS,
      tool_choice: 'auto',
      n_predict: 0,
      enable_thinking: true,
    });
    if (!isCurrent()) {
      return false;
    }
    try {
      await ctx.saveSession(file, { tokenSize: N_CTX });
      return true;
    } catch (e) {
      console.warn('[llm] saveSession failed (warm-up not persisted):', e);
      return false;
    }
  }

  /** Reset to a clean warmed Angel context at a new-conversation boundary.
   * Recurrent state only fully clears via clearCache. */
  newConversation(
    onStatus: (s: ModelStatus) => void = () => {},
  ): Promise<void> {
    return this.queueOperation(() => {
      if (this.disposed) {
        throw new Error('LlamaSession has been released.');
      }
      return this.resetConversation(onStatus);
    });
  }

  private async resetConversation(
    onStatus: (s: ModelStatus) => void,
  ): Promise<void> {
    const ctx = this.context;
    if (ctx) {
      const releaseLease = this.leaseContext(ctx);
      try {
        try {
          await ctx.clearCache(true);
          await this.restoreOrWarmUp(
            () => {},
            ctx,
            this.modelFingerprint,
            this.persona,
          );
        } catch (targetError) {
          let rollbackError: unknown = null;
          try {
            await ctx.clearCache(true);
            await this.restoreOrWarmUp(
              () => {},
              ctx,
              this.modelFingerprint,
              this.persona,
            );
          } catch (error) {
            rollbackError = error;
          }
          if (rollbackError === null) {
            const detail = `Could not start a new conversation: ${
              targetError instanceof Error ? targetError.message : String(targetError)
            }. The previous conversation was restored.`;
            this.personaRecoveryError = null;
            onStatus({
              state: 'ready',
              modelName: this.modelName ?? 'model',
              detail,
            });
            throw targetError;
          }

          let quarantineError: unknown = null;
          try {
            await ctx.clearCache(true);
          } catch (error) {
            quarantineError = error;
          }
          const message =
            `Starting a new conversation failed: ${
              targetError instanceof Error ? targetError.message : String(targetError)
            }; restoring the previous conversation also failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }${
              quarantineError === null
                ? ''
                : `; final cache clear failed: ${
                    quarantineError instanceof Error
                      ? quarantineError.message
                      : String(quarantineError)
                  }`
            }. The resident model is not ready; retry to recover.`;
          const failure = new Error(message);
          this.personaRecoveryError = failure;
          onStatus({ state: 'error', detail: message });
          throw failure;
        }
      } finally {
        releaseLease();
      }
    }

    this.history = [];
    this.structuredEventHistoryTurn = null;
    this.pendingEventQuery = null;
    this.lastEventResults = [];
    this.pendingEventFollowUp = null;
    // The anchor is conversation state: a pronoun in a NEW chat has no
    // antecedent, and inheriting one across the boundary would resolve it to
    // someone the asker never mentioned.
    this.lastPersonEntity = null;
    this.personaRecoveryError = null;
    rotateChatSession();
    logSystemNote(this.persona.id, 'new conversation');
    if (ctx) {
      onStatus({ state: 'ready', modelName: this.modelName ?? 'model' });
    }
  }

  /** Dormant selector compatibility path. PERSONAS currently exposes only the
   * Angel, so the shipping UI cannot call this with a different id. */
  setPersona(
    personaId: string,
    onStatus: (s: ModelStatus) => void = () => {},
  ): Promise<void> {
    return this.queueOperation(async () => {
      if (this.disposed) {
        throw new Error('LlamaSession has been released.');
      }
      const next = getPersona(personaId);
      if (next.id === this.desiredPersona.id) {
        return;
      }
      const priorDesired = this.desiredPersona;
      this.desiredPersona = next;
      this.invalidateLoads();
      try {
        await this.switchPersona(next, onStatus);
      } catch (error) {
        if (this.desiredPersona === next) {
          this.desiredPersona = priorDesired;
          this.invalidateLoads();
        }
        throw error;
      }
    });
  }

  private async switchPersona(
    next: Persona,
    onStatus: (s: ModelStatus) => void,
  ): Promise<void> {
    const previous = {
      persona: this.persona,
      history: this.history,
      pendingEventQuery: this.pendingEventQuery,
      lastPersonEntity: this.lastPersonEntity,
    };
    const ctx = this.context;
    const fingerprint = this.modelFingerprint;

    if (ctx) {
      const releaseLease = this.leaseContext(ctx);
      try {
        try {
          // Prepare the target prefix without publishing its persona, transcript
          // boundary, log row, or transient warm-up status.
          await ctx.clearCache(true);
          await this.restoreOrWarmUp(() => {}, ctx, fingerprint, next);
        } catch (targetError) {
          let rollbackError: unknown = null;
          try {
            await ctx.clearCache(true);
            await this.restoreOrWarmUp(
              () => {},
              ctx,
              fingerprint,
              previous.persona,
            );
          } catch (error) {
            rollbackError = error;
          }
          if (rollbackError === null) {
            this.personaRecoveryError = null;
            onStatus({
              state: 'ready',
              modelName: this.modelName ?? 'model',
              detail: `Could not switch to ${next.label}: ${
                targetError instanceof Error ? targetError.message : String(targetError)
              }. ${previous.persona.label} was restored.`,
            });
            throw targetError;
          }

          let quarantineError: unknown = null;
          try {
            // Leave no target prefix callable after a failed rollback. The
            // resident weights stay allocated so a later switch can retry.
            await ctx.clearCache(true);
          } catch (error) {
            quarantineError = error;
          }
          const message =
            `Persona switch ${previous.persona.id} -> ${next.id} failed: ${
              targetError instanceof Error ? targetError.message : String(targetError)
            }; restoring ${previous.persona.id} also failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }${
              quarantineError === null
                ? ''
                : `; final cache clear failed: ${
                    quarantineError instanceof Error
                      ? quarantineError.message
                      : String(quarantineError)
                  }`
            }. The resident model is not ready; retry the persona switch to recover.`;
          const failure = new Error(message);
          this.personaRecoveryError = failure;
          onStatus({ state: 'error', detail: message });
          throw failure;
        }
      } finally {
        releaseLease();
      }
    }

    // Preparation succeeded. Publish the new conversation atomically from the
    // app's perspective, without reloading the resident model weights.
    this.persona = next;
    this.history = [];
    this.structuredEventHistoryTurn = null;
    this.pendingEventQuery = null;
    this.lastPersonEntity = null;
    this.lastEventResults = [];
    this.pendingEventFollowUp = null;
    this.personaRecoveryError = null;
    rotateChatSession();
    logSystemNote(
      next.id,
      `persona switch: ${previous.persona.id} -> ${next.id}`,
    );
    if (ctx) {
      onStatus({ state: 'ready', modelName: this.modelName ?? 'model' });
    }
  }

  private historyMessages(turns: HistoryTurn[]): ChatMsg[] {
    return this.historySlices(turns).flatMap(s => s.slice);
  }

  /** The same replay, with TURN BOUNDARIES kept: context-full eviction must
   * remove whole slices — a raw tool turn is variable-length, and the old
   * fixed splice(1,2) orphaned tool messages mid-turn and evicted the wrong
   * HistoryTurn from the authoritative transcript (review batch 2.1). */
  private historySlices(
    turns: HistoryTurn[],
  ): { turn: HistoryTurn; slice: ChatMsg[] }[] {
    // Newest turns keep their place; oldest whole turns are evicted when the
    // budget fills. Eviction never orphans a tool message because a turn's
    // raw slice is self-contained (assistant-with-tool_calls + its results).
    const kept: { turn: HistoryTurn; slice: ChatMsg[] }[] = [];
    let budget = HISTORY_TOKEN_BUDGET;
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.omitFromInference) {
        continue;
      }
      const slice = turn.raw.length > 0 ? turn.raw : [turn.user, turn.assistant];
      const cost = estimateTokens(slice);
      if (cost > budget && kept.length > 0) {
        break; // this turn and everything older is evicted
      }
      if (cost <= budget) {
        kept.unshift({ turn, slice });
        budget -= cost;
      } else {
        // even the newest turn overflows alone: keep its user+final only
        kept.unshift({ turn, slice: [turn.user, turn.assistant] });
        break;
      }
    }
    return kept;
  }

  private stripStructuredEventHistory(): void {
    if (!this.structuredEventHistoryTurn) {
      return;
    }
    this.structuredEventHistoryTurn.assistant.content =
      this.structuredEventHistoryTurn.assistant.content.replace(
        /\nStructured event results: \[[^\n]*\]$/,
        '',
      );
    // The raw thread would replay the ORIGINAL turn slice — tool payloads
    // included — straight past this redaction (the accepted invariant:
    // structured event JSON leaves inference once the app clears its event
    // anchor). Emptying the slice makes historyMessages fall back to the
    // curated user/assistant pair, which the line above just cleaned.
    this.structuredEventHistoryTurn.raw = [];
    this.structuredEventHistoryTurn = null;
  }

  private inferenceTurns(userText: string): HistoryTurn[] {
    let end = this.history.length;
    if (!refersToPriorFailure(userText)) {
      while (end > 0 && this.history[end - 1].noToolFailure) {
        end -= 1;
      }
    }
    return this.history.slice(0, end).filter(turn => !turn.omitFromInference);
  }

  private finishIdentityTurn(
    userText: string,
    intent: IdentityIntent,
    outcome: PersonIdentityOutcome,
    cb: TurnCallbacks,
    turnT0: number,
    relational: readonly HistoryToolPlan[] = [],
  ): ChatTurnResult {
    const modelName = this.modelName;
    cb.onToolCall?.('lookup_person', true);
    logChat({
      role: 'user',
      persona: this.persona.id,
      text: userText,
      model_file: modelName,
    });
    logChat({
      role: 'tool_call',
      persona: this.persona.id,
      text: JSON.stringify({ name: 'lookup_person', args: { topic: intent.topic } }),
      model_file: modelName,
    });

    const cards: ChatCard[] = outcome.status === 'resolved' ? [outcome.card] : [];
    const sources = outcome.status === 'resolved' ? [outcome.source] : [];
    cb.onToolDone?.('lookup_person', cards, sources);
    let text: string;
    if (outcome.status === 'resolved') {
      text = structuredCardNarration(cards)!;
      // COMPOUND: "who is X and who has he sponsored" — the second clause is
      // a relational question about the person just resolved. Answer both
      // halves in one turn, deterministically: the lineage/attendance/
      // projects card rides under the person card, and an empty relation is
      // said plainly instead of dropped (owner phone test, 2026-08-17).
      for (const plan of relational) {
        const args = historyToolPlans(
          plan.rawUserText,
          outcome.person,
        )[0]?.args ?? plan.args;
        cb.onToolCall?.('lookup_history', true);
        const rel = lookupHistory(args);
        cb.onToolDone?.('lookup_history', rel.cards, []);
        logChat({
          role: 'tool_call',
          persona: this.persona.id,
          text: JSON.stringify({ name: 'lookup_history', args }),
          model_file: this.modelName,
        });
        logChat({
          role: 'tool_result',
          persona: this.persona.id,
          text: JSON.stringify({
            name: 'lookup_history',
            absence: rel.absence ? rel.absence.query : null,
            card_kinds: rel.cards.map(card => card.kind),
          }),
          model_file: this.modelName,
        });
        cards.push(...rel.cards);
        text = rel.absence
          ? `${text} ${campHistoryAbsenceNarration(rel.absence)}`
          : rel.cards.length > 0
          ? `${text} ${relationalFollowUpLine(args.query)}`
          : text;
      }
    } else if (outcome.status === 'ambiguous') {
      text = personAmbiguityNarration(outcome.query, outcome.candidates);
    } else if (outcome.status === 'not_found') {
      text = personNotFoundNarration(outcome.query);
    } else if (outcome.status === 'card_unavailable') {
      text = personCardUnavailableNarration(outcome.person.name, outcome.pack_name);
    } else {
      throw new Error(`Unknown identity outcome: ${JSON.stringify(outcome)}`);
    }

    logChat({
      role: 'tool_result',
      persona: this.persona.id,
      text: JSON.stringify({
        name: 'lookup_person',
        status: outcome.status,
        card_kinds: cards.map(card => card.kind),
      }),
      model_file: modelName,
    });
    logChat({
      role: 'assistant',
      persona: this.persona.id,
      text,
      model_file: modelName,
      sampler_json: samplerJson(),
      ttft_ms: null,
      total_ms: Date.now() - turnT0,
      prompt_tokens: null,
      completion_tokens: null,
      thinking_chars: 0,
      timings_json: '[]',
    });
    this.stripStructuredEventHistory();
    this.history.push({
      user: { role: 'user', content: userText },
      assistant: { role: 'assistant', content: text },
      raw: [
        { role: 'user', content: userText },
        { role: 'assistant', content: text },
      ],
      noToolFailure: false,
      omitFromInference: false,
    });
    this.pendingEventQuery = null;
    this.lastEventResults = [];
    this.pendingEventFollowUp = null;
    this.lastPersonEntity = outcome.status === 'resolved' ? outcome.person : null;
    // The app's own structured identity answer: cards stand under it.
    return { text, cards, sources, toolRounds: 1, answeredFrom: 'packs' };
  }

  private finishEventFollowUp(
    userText: string,
    followUp: NonNullable<ReturnType<typeof eventFollowUp>>,
    cb: TurnCallbacks,
    turnT0: number,
  ): ChatTurnResult {
    const modelName = this.modelName;
    const cards: ChatCard[] = followUp.event
      ? [{ kind: 'event', event: followUp.event }]
      : [];
    cb.onToolCall?.('search_events', true);
    cb.onToolDone?.('search_events', cards, []);
    logChat({
      role: 'user',
      persona: this.persona.id,
      text: userText,
      model_file: modelName,
    });
    logChat({
      role: 'tool_call',
      persona: this.persona.id,
      text: JSON.stringify({
        name: 'search_events',
        args: { follow_up: userText },
      }),
      model_file: modelName,
    });
    logChat({
      role: 'tool_result',
      persona: this.persona.id,
      text: JSON.stringify({
        name: 'search_events',
        status: followUp.event ? 'resolved-follow-up' : 'ambiguous-follow-up',
        row_ids: followUp.event ? [followUp.event.id] : [],
        card_kinds: cards.map(card => card.kind),
      }),
      model_file: modelName,
    });
    logChat({
      role: 'assistant',
      persona: this.persona.id,
      text: followUp.text,
      model_file: modelName,
      sampler_json: samplerJson(),
      ttft_ms: null,
      total_ms: Date.now() - turnT0,
      prompt_tokens: null,
      completion_tokens: null,
      thinking_chars: 0,
      timings_json: '[]',
    });
    this.history.push({
      user: { role: 'user', content: userText },
      assistant: { role: 'assistant', content: followUp.text },
      raw: [
        { role: 'user', content: userText },
        { role: 'assistant', content: followUp.text },
      ],
      noToolFailure: false,
      omitFromInference: false,
    });
    this.pendingEventQuery = null;
    this.pendingEventFollowUp = followUp.event ? null : followUp.field;
    if (followUp.event) {
      this.lastEventResults = [followUp.event];
    }
    return {
      text: followUp.text,
      cards,
      sources: [],
      toolRounds: 1,
      // A structured event follow-up is the app answering from its own
      // search result — cards stand under it.
      answeredFrom: 'packs',
    };
  }

  /** Run one user turn through the capped tool loop. Native completion, cache
   * mutation, and transcript publication share one admission queue. */
  chat(userText: string, cb: TurnCallbacks = {}): Promise<ChatTurnResult> {
    if (this.disposed) {
      return Promise.reject(new Error('LlamaSession has been released.'));
    }
    if (this.personaRecoveryError) {
      return Promise.reject(this.personaRecoveryError);
    }
    return this.queueOperation(async () => {
      if (this.disposed) {
        throw new Error('LlamaSession has been released.');
      }
      if (this.personaRecoveryError) {
        throw this.personaRecoveryError;
      }
      const ctx = this.context;
      if (!ctx) {
        throw new Error('Model not loaded');
      }
      const releaseLease = this.leaseContext(ctx);
      const turnT0 = Date.now();
      const modelName = this.modelName;
      try {
        return await this.runTurn(ctx, userText, cb, turnT0, modelName);
      } catch (e: unknown) {
        // Field log: failures are rows too — the error string, in-session.
        logSystemNote(
          this.persona.id,
          `turn failed after ${Date.now() - turnT0}ms: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        throw e;
      } finally {
        releaseLease();
      }
    });
  }

  private async runTurn(
    ctx: LlamaContext,
    userText: string,
    cb: TurnCallbacks,
    turnT0: number,
    modelName: string | null,
  ): Promise<ChatTurnResult> {
    // Read without clearing: a failed clarified search must remain retryable.
    // Successful finalization replaces this value at the end of the turn.
    const pendingEventQuery = this.pendingEventQuery;
    const clarifiedDay =
      pendingEventQuery === null ? null : parseDayOnly(userText);
    const clarifiedEvent =
      clarifiedDay === null || pendingEventQuery === null
        ? null
        : {
            args: { query: pendingEventQuery.query, day: clarifiedDay },
            rawUserText: replaceEventDayCoordinate(
              pendingEventQuery.rawUserText,
              clarifiedDay,
            ),
          };
    // THE PRONOUN ANCHOR, read ONCE, before this turn looks anything up: the
    // antecedent of "her" is who the session had resolved when the question
    // was asked, so a lookup made later in this same turn can never re-point
    // the pronoun that lookup is answering. Null on a fresh conversation, and
    // null makes every slot filler below behave exactly as it does today.
    const personAnchor = this.lastPersonEntity;
    const routesEvent = (text: string) =>
      shouldRouteEventSearch(text) || isEnabledEventTitleRequest(text);
    const clauses = splitClauses(userText);
    const eventPlan = splitEventClauses(userText, routesEvent, enabledTitleSpans);
    const routedEventClauses = eventPlan.eventClauses;
    const eventFollowUpCandidate = eventFollowUp(
      userText,
      this.lastEventResults,
      this.pendingEventFollowUp,
    );
    const constrainedEventFollowUp =
      eventFollowUpCandidate !== null &&
      eventFollowUpHasTemporalConstraint(
        userText,
        eventFollowUpCandidate.event,
        this.lastEventResults,
      );
    const priorEventFollowUp =
      eventFollowUpCandidate !== null && !constrainedEventFollowUp
        ? eventFollowUpCandidate
        : null;
    const followUpEventSearch = clarifiedEvent ?? (
      constrainedEventFollowUp
        ? {
            args: {
              query: eventFollowUpCandidate?.event?.title ??
                eventSearchQuery(userText),
            },
            rawUserText: userText,
          }
        : null
    );
    if (priorEventFollowUp) {
      return this.finishEventFollowUp(
        userText,
        priorEventFollowUp,
        cb,
        turnT0,
      );
    }
    const affiliations = identityAffiliationTerms();
    const historyPlans = historyToolPlans(userText, personAnchor);
    const forcedHistoryArgs = (
      clauses.length > 1 ? historyPlans[0]?.args : null
    ) ?? historyToolArgs(userText, personAnchor);
    const forceHistoryTool = forcedHistoryArgs !== null;
    const historyTexts = new Set(historyPlans.flatMap(plan =>
      splitClauses(plan.rawUserText)
    ));
    const factualOtherClauses = followUpEventSearch
      ? []
      : eventPlan.otherClauses.filter(clause =>
          !historyTexts.has(clause) && isFactualTurn(clause)
        );
    // CLAUSES THE APP DECLINED, which the MODEL is therefore owed
    // (binding re-review): an event-hinted clause the router refused is
    // not the app's to answer with lookup_facts — but it must not vanish
    // either. Naming the set ONCE keeps the forced-lookup filter and the
    // model's scoped prompt from disagreeing, which is exactly how the
    // clause fell between them and reached the model on ZERO rounds.
    const modelOwedClauses = factualOtherClauses.filter(clause =>
      isEventRequest(clause),
    );
    const nonFactualOtherClauses = followUpEventSearch
      ? []
      : eventPlan.otherClauses.filter(clause =>
          !historyTexts.has(clause) && !isFactualTurn(clause)
        );
    const compoundToolRound = clauses.length > 1 && (
      (routedEventClauses.length > 0 && eventPlan.otherClauses.length > 0) ||
      historyPlans.length > 1 ||
      (historyPlans.length > 0 && eventPlan.otherClauses.length > 1) ||
      factualOtherClauses.length > 1 ||
      (factualOtherClauses.length > 0 && nonFactualOtherClauses.length > 0)
    );
    const mixedDeterministicRound =
      !followUpEventSearch &&
      routedEventClauses.length > 0 &&
      (factualOtherClauses.length > 0 || nonFactualOtherClauses.length > 0);
    const baseEventClause = routedEventClauses[0] ?? '';
    const baseEventQuery = eventSearchQuery(baseEventClause);
    const forcedEventSearches = followUpEventSearch
      ? [followUpEventSearch]
      : routedEventClauses.length > 1 || mixedDeterministicRound ||
        routedEventClauses.some(isEnabledEventTitleRequest) || (
          forcedHistoryArgs !== null && routedEventClauses.length > 0
        )
      ? routedEventClauses.map((clause, index) => {
          // A clause naming an enabled exact title searches by the TITLE —
          // eventSearchQuery's daypart/shell stripping dismembers "Morning
          // Coffee" into "coffee" (staged-review root 5).
          const query = exactTitleSearchQuery(clause) ?? eventSearchQuery(clause);
          return query.length > 0 || index === 0 || routesEvent(clause)
            ? { args: { query }, rawUserText: clause }
            : {
                args: { query: baseEventQuery },
                rawUserText: replaceEventTemporalCoordinates(
                  baseEventClause,
                  clause,
                ),
              };
        })
      : [];
    // Identity is resolved before the model can stream a syllable. The exact
    // graph match (or explicit ambiguity) claims broad real-world names;
    // syntactically conservative unknowns close honestly; topic-like unknowns
    // fall through to ordinary routing.
    // A compound question — "who is X and who has he sponsored" — is an
    // identity question about its FIRST clause plus a relational follow-up
    // (historyToolArgs already parsed the whole sentence, resolving "he" to
    // X). Only that shape reaches the compound path; a lone identity or a
    // lone relational question behaves exactly as before.
    const compoundIdentity =
      forcedHistoryArgs !== null && clauses.length >= 2
        ? identityIntent(clauses[0], personAnchor, affiliations)
        : null;
    const parsedIdentity =
      identityIntent(userText, personAnchor, affiliations) ?? compoundIdentity;
    if (parsedIdentity !== null) {
      const outcome = lookupPersonIdentity(parsedIdentity);
      if (outcome.status !== 'not_found' || parsedIdentity.confidentUnknown) {
        return this.finishIdentityTurn(
          userText,
          parsedIdentity,
          outcome,
          cb,
          turnT0,
          compoundIdentity !== null ? historyPlans : [],
        );
      }
    }
    const authorityPolicy: TurnAuthorityPolicy = forcedEventSearches.length > 0
      ? 'event'
      : forceHistoryTool
      ? 'history'
      : parsedIdentity !== null
      ? 'identity'
      : routesEvent(userText)
      ? 'event'
      : 'ordinary';
    const conversationalNoTool =
      authorityPolicy === 'ordinary' && isConversationalNoTool(userText);
    // The model's failed ask-for-a-day exchange stays in the transcript/log,
    // but the forced retry sees a clean event request plus its tool result.
    const priorTurns = clarifiedEvent
      ? this.history.slice(0, -1).filter(turn => !turn.omitFromInference)
      : this.inferenceTurns(userText);
    const priorSlices = this.historySlices(priorTurns);
    const priorMessages = priorSlices.flatMap(s => s.slice);
    // The eviction queue mirrors the ASSEMBLY, not the raw turn list: a
    // turn the budget already dropped must never be the one the context-
    // full path "evicts" (it is not in the prompt), and each entry knows
    // its own slice length so eviction removes WHOLE turns.
    const retrySlices = [...priorSlices];
    const evictedHistoryTurns = new Set<HistoryTurn>();
    // The scoped prompt carries every clause the app did NOT handle: the
    // conversational ones AND the event-hinted ones the router declined.
    // Narrowing to nonFactual alone dropped the declined clause from the
    // model's view entirely, so the round it was owed could not route it.
    const modelScopedClauses = [...modelOwedClauses, ...nonFactualOtherClauses];
    const scopedNonFactualPrompt =
      compoundToolRound && modelScopedClauses.length > 0
        ? modelScopedClauses.join(' and ')
        : null;
    const promptUserText = clarifiedEvent
      ? `${clarifiedEvent.args.query || 'events'} ${clarifiedEvent.args.day}`
      : scopedNonFactualPrompt ?? userText;
    const messages: ChatMsg[] = [
      { role: 'system', content: this.persona.systemPrompt },
      ...priorMessages,
      { role: 'user', content: promptUserText },
    ];
    // The raw thread: this turn's contribution = everything appended from
    // here on (its user message, tool exchanges with reasoning, notes),
    // plus the final. History replays it verbatim next turn. Mutable:
    // whole-turn eviction below shifts every index left, and a stale base
    // would persist a partial/foreign span as this turn's raw history.
    let turnBase = messages.length - 1;
    // Signatures of tool calls already EXECUTED this turn (name + exact
    // args). A model that repeats the identical call is not gathering — it
    // is stuck (measured 2026-08-17: search_events("Robot Heart", today)
    // twice back-to-back, then a speechless final). The repeat costs a full
    // device round (~30 s) and buys nothing; the dup guard answers it with
    // an in-context instruction instead of re-executing.
    const executedCalls = new Set<string>();
    let historyMessageCount = priorMessages.length;
    const toolResults: {
      cards: ChatCard[];
      sources: SourceRef[];
      resolvedPerson?: PersonRef;
      noCoverage?: string;
      emptyLookup?: boolean;
      historyAbsence?: HistoryAbsence;
      historyAmbiguity?: HistoryAmbiguity;
      eventSearch?: EventSearchOutcome;
      forced: boolean;
      toolName: string;
      rawUserText: string;
    }[] = [];
    let toolRounds = 0;
    // A router-DECLINED event-hinted clause belongs to the MODEL (binding
    // review C12, closure-verified form): the forced compound's OTHER
    // results (document evidence included) must not close the turn before
    // the model has had one round to route that clause itself.
    const modelRoundOwed = [...factualOtherClauses, ...nonFactualOtherClauses]
      .some(clause => isEventRequest(clause) && !routesEvent(clause));
    let modelRoundRan = false;
    let finalText = '';
    // Context-overflow retry state (iBurn withContextWindowRetry pattern):
    // shrinkers for the most recent round's tool-result messages, so a
    // context_full completion can rebuild them with fewer candidates.
    let lastToolMsgs: {
      msgIndex: number;
      outcome: ToolOutcome;
      result: {
        cards: ChatCard[];
        sources: SourceRef[];
        eventSearch?: EventSearchOutcome;
      };
    }[] = [];
    let candidateLimit = 5;

    // Field log: the user turn lands at send; every completion contributes a
    // RoundStat; the assistant row lands at the end with aggregate metrics.
    // ttft here = wall-clock to the first VISIBLE (post-ThinkFilter) text,
    // the same moment the staged status line clears on screen.
    let firstVisibleAt: number | null = null;
    const markVisible = (): void => {
      if (firstVisibleAt === null) {
        firstVisibleAt = Date.now();
      }
    };
    const roundStats: RoundStat[] = [];
    logChat({
      role: 'user',
      persona: this.persona.id,
      text: userText,
      model_file: modelName,
    });

    // Set when the APP supplied the identity lookup the model skipped, when a
    // lookup proved a knowable absence (executor no_coverage), and when any
    // doc lookup ran and came back with nothing (the honest-close inputs).
    let absentEntity: string | null = null;
    let emptyLookup = false;
    let historyAbsence: HistoryAbsence | null = null;
    let historyAmbiguity: HistoryAmbiguity | null = null;
    const reconcileEvidenceState = (): void => {
      const structuredPositive = toolResults.some(
        result => result.cards.length > 0,
      );
      const structuredHistoryPositive = toolResults.some(result =>
        result.cards.some(card => card.kind !== 'event'),
      );
      const documentPositive = toolResults.some(
        result => result.sources.length > 0,
      );
      historyAmbiguity = toolResults
        .flatMap(result => result.historyAmbiguity ? [result.historyAmbiguity] : [])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] ?? null;
      const history = toolResults
        .flatMap(result => result.historyAbsence ? [result.historyAbsence] : [])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] ?? null;
      historyAbsence = structuredHistoryPositive || historyAmbiguity ? null : history;
      absentEntity = structuredPositive || documentPositive || historyAbsence ||
        historyAmbiguity
        ? null
        : toolResults
            .flatMap(result => result.noCoverage ? [result.noCoverage] : [])
            .sort((a, b) => a.localeCompare(b))[0] ?? null;
      emptyLookup = !structuredPositive && !documentPositive &&
        !historyAbsence && !historyAmbiguity && !absentEntity &&
        toolResults.some(result => result.emptyLookup === true);
    };

    const runToolCall = async (
      call: ToolCall,
      forced = false,
      rawUserText = userText,
    ): Promise<void> => {
      const argsStr =
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {});
      // __DEV__-gated: tool args derive from user questions (release QA
      // round 2, finding 17).
      if (__DEV__) {
        console.log(
          `[llm] tool_call ${call.function.name} args=${argsStr.slice(0, 200)}`,
        );
      }
      executedCalls.add(`${call.function.name}|${argsStr}`);
      if (call.function.name === 'lookup_history') {
        forcedHistoryComplete = true;
      }
      cb.onToolCall?.(call.function.name, forced);
      logChat({
        role: 'tool_call',
        persona: this.persona.id,
        text: JSON.stringify({ name: call.function.name, args: argsStr }),
        model_file: modelName,
      });
      const outcome = await executeTool(
        call,
        rawUserText,
        personAnchor,
        affiliations,
      );
      const stored = {
        cards: outcome.cards,
        sources: outcome.sources ?? [],
        resolvedPerson: outcome.resolvedPerson,
        noCoverage: outcome.noCoverage,
        emptyLookup: outcome.emptyLookup,
        historyAbsence: outcome.historyAbsence,
        historyAmbiguity: outcome.historyAmbiguity,
        eventSearch: outcome.eventSearch,
        forced,
        toolName: call.function.name,
        rawUserText,
      };
      toolResults.push(stored);
      reconcileEvidenceState();
      messages.push({
        role: 'tool',
        name: call.function.name,
        content: outcome.json,
      });
      lastToolMsgs.push({
        msgIndex: messages.length - 1,
        outcome,
        result: stored,
      });
      logChat({
        role: 'tool_result',
        persona: this.persona.id,
        text: JSON.stringify({
          name: call.function.name,
          row_ids: outcome.cards.flatMap(card =>
            card.kind === 'event' ? [card.event.id] : [],
          ),
          card_kinds: outcome.cards.map(card => card.kind),
          json: outcome.json,
        }),
        model_file: modelName,
      });
      cb.onToolDone?.(call.function.name, outcome.cards, stored.sources);
    };

    let forcedHistoryComplete = false;
    const forcedCalls: Array<{ call: ToolCall; rawUserText: string }> = [];
    for (const eventSearch of forcedEventSearches) {
      forcedCalls.push({
        call: {
          type: 'function',
          function: {
            name: 'search_events',
            arguments: JSON.stringify(eventSearch.args),
          },
        },
        rawUserText: eventSearch.rawUserText,
      });
    }
    // Recognized deterministic compounds run every owner in one app-supplied
    // tool round, so one clause cannot close the turn before another runs.
    if (
      historyPlans.length > 0 &&
      (forcedEventSearches.length > 0 || compoundToolRound)
    ) {
      for (const plan of historyPlans) {
        forcedCalls.push({
          call: {
            type: 'function',
            function: {
              name: 'lookup_history',
              arguments: JSON.stringify(plan.args),
            },
          },
          rawUserText: plan.rawUserText,
        });
      }
      forcedHistoryComplete = true;
    }
    if (
      factualOtherClauses.length > 0 &&
      (forcedEventSearches.length > 0 || historyPlans.length > 0 || compoundToolRound)
    ) {
      // An event-HINTED clause the router DECLINED stays with the MODEL
      // (binding review C12): forcing lookup_facts for it pre-empted the
      // model's own search_events selection, so a compound's event half
      // was answered from document passages the camper never asked for.
      // The model's round still runs after the forced calls; the declined
      // clause reaches it with every tool exposed.
      for (const factualText of factualOtherClauses.filter(
        t => !modelOwedClauses.includes(t),
      )) {
        forcedCalls.push({
          call: {
            type: 'function',
            function: {
              name: 'lookup_facts',
              arguments: JSON.stringify({ topic: groundingTopic(factualText) }),
            },
          },
          rawUserText: factualText,
        });
      }
    }
    if (forcedCalls.length > 0) {
      toolRounds = 1;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: forcedCalls.map(({ call }) => call),
      });
      for (const { call, rawUserText } of forcedCalls) {
        await runToolCall(call, true, rawUserText);
      }
    }

    // ANSWER-FORCING floor (r8): true only for the one retry of a round that
    // produced zero visible characters — thinking suppressed, tools off.
    let speechRetry = false;
    let groundingFloorFired = false;
    let echoRetry = false;
    // The previous turn's final, for the echo guard below.
    const prevFinal = (this.history[this.history.length - 1]?.assistant.content ?? '').trim();
    const prevUser = (this.history[this.history.length - 1]?.user.content ?? '').trim();
    // Set wherever the app closes the turn in its OWN voice (see
    // ChatTurnResult.answeredFrom).
    let appVoice = false;

    for (;;) {
      const hasStructuredCards = toolResults.some(result =>
        result.cards.some(card => card.kind !== 'event'),
      );
      const hasDocumentEvidence = toolResults.some(
        result => result.sources.length > 0,
      );
      const eventOutcomes = toolResults.flatMap(result =>
        result.eventSearch ? [result.eventSearch] : [],
      );
      const hasEventAuthority = eventOutcomes.some(
        outcome => outcome.state !== 'not-run',
      ) || (eventOutcomes.length > 0 && !hasDocumentEvidence);
      const hasConclusiveEventAuthority = toolResults.some(result =>
        result.eventSearch?.state === 'matches' ||
        result.eventSearch?.state === 'invalid-date' ||
        (result.forced && result.eventSearch?.state === 'empty'),
      );
      const hasOtherAppAuthority = toolResults.some(
        result =>
          result.noCoverage !== undefined ||
          result.historyAbsence !== undefined ||
          result.historyAmbiguity !== undefined,
      );
      const eventSearchCanFallBack =
        hasEventAuthority &&
        !hasConclusiveEventAuthority &&
        !hasStructuredCards &&
        !hasDocumentEvidence &&
        !hasOtherAppAuthority &&
        toolRounds < TOOL_ROUND_CAP;
      const emptyEventSearchWasSuperseded =
        hasEventAuthority &&
        !hasConclusiveEventAuthority &&
        (hasStructuredCards || hasDocumentEvidence || hasOtherAppAuthority);
      if (
        hasEventAuthority &&
        !mixedDeterministicRound &&
        toolRounds > 0 &&
        !eventSearchCanFallBack &&
        !emptyEventSearchWasSuperseded
      ) {
        cb.onThinking?.(false);
        finalText = '';
        break;
      }
      const forceAnswer =
        ((conversationalNoTool ||
          clarifiedEvent !== null ||
          (forceHistoryTool && forcedHistoryComplete) ||
          hasStructuredCards ||
          (hasEventAuthority && !eventSearchCanFallBack) ||
          hasDocumentEvidence ||
          hasOtherAppAuthority) &&
          (!modelRoundOwed || modelRoundRan)) ||
        toolRounds >= TOOL_ROUND_CAP ||
        speechRetry;
      const forceHistoryCall =
        forceHistoryTool && !forcedHistoryComplete && toolRounds === 0;
      if (forceAnswer && (toolRounds >= TOOL_ROUND_CAP || speechRetry)) {
        // Say out loud that the tools are gone (see FORCED_FINAL_NUDGE).
        nudgeLastToolMessage(messages);
      }
      const toolsEnabled = !forceAnswer;
      const streamRoundLive =
        !toolsEnabled &&
        !hasStructuredCards &&
        !hasEventAuthority &&
        !hasOtherAppAuthority &&
        (conversationalNoTool || hasDocumentEvidence || authorityPolicy === 'ordinary') &&
        lastToolMsgs.length === 0 &&
        historyMessageCount < 2;
      const filter = new ThinkFilter();
      const roundVisible: string[] = [];
      // Forensics (logcat/ReactNativeJS): the exact assembly every completion
      // sees — role:chars per message, in order. A duplicated exchange or a
      // double-fed tool result shows up here immediately (owner field bug
      // 2026-08-13 was unclassifiable without this).
      if (__DEV__) console.log(
        `[llm] round=${toolRounds} assembly=${messages
          .map(m => `${m.role}:${m.content.length}${m.tool_calls ? '+tc' : ''}${m.reasoning_content ? '+r' + m.reasoning_content.length : ''}`)
          .join(',')}`,
      );
      const completion = ctx.completion(
        {
          messages: messages as any,
          jinja: true,
          // THE FORCED FINAL KEEPS THE TOOL LIST and forbids calling them via
          // tool_choice:'none'. Dropping `tools` re-renders the system
          // prefix WITHOUT the tool specs, so the KV cache misses on the
          // whole conversation and the phone re-processes everything —
          // measured 2026-08-17 (Pixel 7, chat_log timings): forced-final
          // prompt_n 1,576 and 2,326 tokens = 29 s and 43 s of prefill per
          // question, versus ~700 for the round's own new tokens. llama.cpp
          // renders the tools into the prompt regardless of tool_choice and
          // only skips the tool grammar for 'none' (common/chat.cpp
          // include_grammar), so the prefix stays byte-identical and cached.
          tools: (forceHistoryCall ? [LOOKUP_HISTORY_TOOL] : ALL_TOOLS) as any,
          tool_choice: forceAnswer ? 'none' : 'auto',
          // Uncapped thinking — the GRADED config (integration decision,
          // 2026-08-25): the shipping tiers were graded without thinking
          // budgets, v1.6's trained thinks are short by construction, and
          // the r5-era safety caps were a latency workaround for v1.1's
          // rambling — cutting into graded behavior to guard against a
          // model that no longer ships. Suppressed only on the
          // answer-forcing retry: the think already happened once and
          // produced no speech; a second silent think helps no one.
          enable_thinking: !speechRetry,
          // enable_thinking:false is NOT honored by LFM2.5's template on
          // device (2,737 think chars on a "suppressed" retry, measured
          // 2026-08-17): a ZERO budget is what actually closes the think.
          // The zero rides ONLY the speech retry — every ordinary round
          // runs the graded uncapped config.
          ...(speechRetry
            ? {
                thinking_budget_tokens: 0,
                thinking_budget_message: ' Enough thinking. Answering now.',
              }
            : {}),
          reasoning_format: 'auto',
          ...SAMPLER,
        },
        data => {
          // A tools-enabled selection round can reveal an authoritative call only
          // after prose has arrived, so it stays buffered. A proven no-tools
          // conversational or positive-document final streams immediately.
          const chunk = streamChunkFromPartial(data);
          if (chunk.length > 0) {
            const { visible, thinking } = filter.push(chunk);
            cb.onThinking?.(thinking);
            if (visible.length > 0) {
              if (streamRoundLive) {
                markVisible();
                cb.onToken?.(visible);
              } else {
                roundVisible.push(visible);
              }
            }
          }
        },
      );
      const result = await completion;
      const tail = filter.flush();
      if (tail.length > 0) {
        if (streamRoundLive) {
          markVisible();
          cb.onToken?.(tail);
        } else {
          roundVisible.push(tail);
        }
      }

      // Measure every completion — context-full retries and tool rounds
      // included; they are all real wall-clock the user waited through. The
      // fields are read defensively: llama.rn fills them on device, mocks
      // may not.
      roundStats.push({
        round: toolRounds,
        timings: (result as any).timings ?? null,
        tokens_evaluated: (result as any).tokens_evaluated ?? null,
        tokens_predicted: (result as any).tokens_predicted ?? null,
        thinking_chars: (result.reasoning_content ?? '').length,
        tool_calls: (result.tool_calls ?? []).map(c => c.function.name),
        context_full: result.context_full ?? false,
        interrupted: (result as any).interrupted ?? false,
      });

      if (result.context_full && lastToolMsgs.length > 0 && candidateLimit > CANDIDATE_FLOOR) {
        // Halve the candidates in the last round's tool results and retry.
        candidateLimit = Math.max(CANDIDATE_FLOOR, Math.floor(candidateLimit / 2));
        for (const { msgIndex, outcome, result: stored } of lastToolMsgs) {
          const smaller = await outcome.shrink(candidateLimit);
          messages[msgIndex] = { ...messages[msgIndex], content: smaller.json };
          stored.cards = smaller.cards;
          // The chips must show the passages the model was LEFT with, not the
          // ones the overflowed round dropped.
          stored.sources = smaller.sources ?? stored.sources;
          stored.eventSearch = smaller.eventSearch ?? stored.eventSearch;
        }
        reconcileEvidenceState();
        continue;
      }
      if (result.context_full && retrySlices.length > 0) {
        // Ordinary and exhausted-tool turns have nothing candidate-shaped left
        // to shrink. Evict the oldest WHOLE turn slice from both the retry
        // assembly and, after success, the authoritative session transcript —
        // a raw tool turn is variable-length, so the amount removed comes
        // from the slice itself, and every downstream index shifts with it.
        const oldest = retrySlices.shift()!;
        messages.splice(1, oldest.slice.length);
        historyMessageCount -= oldest.slice.length;
        turnBase -= oldest.slice.length;
        evictedHistoryTurns.add(oldest.turn);
        speechRetry = false;
        continue;
      }

      // The owed model round counts only once its completion is ACCEPTED —
      // a context_full result was retried above, not run (codex closure
      // rider A on C12: flagging at await time let sibling document
      // evidence force tools off before the retry could route).
      modelRoundRan = true;
      const toolCalls = result.tool_calls ?? [];
      if (toolCalls.length > 0 && !forceAnswer) {
        toolRounds += 1;
        // A narrow relational question exposes only lookup_history. Keep the
        // model's tool selection, but replace drifted free-text slots (device:
        // query="years attended") with the app's confidently parsed enum slots.
        let historyForced = false;
        const routedToolCalls = toolCalls.map(call => {
          if (
            call.function.name === 'search_events' &&
            isEventRequest(userText) &&
            isFactualEventRequest(userText) &&
            // The ROUTING OWNER decides, not the factual shape alone
            // (binding review C3): "what is happening on Friday?" matches
            // FACTUAL_EVENT_SHAPE's `what is` arm, and rewriting the
            // model's search_events to lookup_facts on a turn the app
            // itself classified as routable silently dropped
            // authoritative event rows. Only a turn the router DECLINED
            // may be re-pointed at the docs corpus.
            !routesEvent(userText)
          ) {
            return {
              ...call,
              function: {
                name: 'lookup_facts',
                arguments: JSON.stringify({ topic: groundingTopic(userText) }),
              },
            };
          }
          // The app's parse routed ONE narrow relational question; a
          // compound response ("sponsors AND projects") carries distinct
          // clauses the model got right on its own, and rewriting every
          // lookup_history to the same first parse ran one lookup twice
          // and dropped the other clause (review batch 3.3).
          if (
            forcedHistoryArgs !== null &&
            call.function.name === 'lookup_history' &&
            !historyForced
          ) {
            historyForced = true;
            return {
              ...call,
              function: {
                ...call.function,
                arguments: JSON.stringify(forcedHistoryArgs),
              },
            };
          }
          return call;
        });
        // Sanitize before feeding back: llama.cpp's message parser requires
        // tool_call.id to be a STRING if the key is present, but llama.rn
        // hands back id:null for LFM2.5's pythonic tool calls — feeding that
        // straight back crashes the next completion with "Failed to parse
        // messages: type must be string, but is null" (device-validated
        // 2026-08-13). Omit null ids, force type, stringify arguments.
        const fedBackCalls: ToolCall[] = routedToolCalls.map(call => ({
          type: 'function',
          ...(typeof call.id === 'string' && call.id.length > 0
            ? { id: call.id }
            : {}),
          function: {
            name: call.function.name,
            arguments:
              typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
          },
        }));
        messages.push({
          role: 'assistant',
          content: result.content ?? '',
          tool_calls: fedBackCalls,
          ...(typeof result.reasoning_content === 'string' && result.reasoning_content.length > 0
            ? { reasoning_content: result.reasoning_content }
            : {}),
        });
        // Multi-tool-call arrays: execute ALL calls, append one tool-result
        // message per call, in order. A NEW round's results arrive at full
        // size, so the shrink limit resets with them — turn-global, it froze
        // at a prior round's floor and the next overflow had nothing left to
        // shrink and fell through to eviction (review batch 6.2).
        candidateLimit = 5;
        lastToolMsgs = [];
        for (const call of routedToolCalls) {
          const sig = `${call.function.name}|${
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {})
          }`;
          if (executedCalls.has(sig)) {
            messages.push({
              role: 'tool',
              name: call.function.name,
              content:
                '{"note":"You already ran this exact lookup this turn — its result is above. Do not call any more tools. Answer the camper now from what you have."}',
            });
            continue;
          }
          await runToolCall(call);
        }
        continue;
      }

      // tool_choice="required" is incompatible with the field model's chat
      // template, and "auto" can still narrate without calling the only tool.
      // After giving the model one chance to select lookup_history, execute the
      // confidently parsed enum slots so a relational turn cannot silently skip
      // its storage-of-record lookup.
      if (
        forcedHistoryArgs !== null &&
        toolRounds === 0 &&
        !forceAnswer
      ) {
        toolRounds = 1;
        const call: ToolCall = {
          type: 'function',
          function: {
            name: 'lookup_history',
            arguments: JSON.stringify(forcedHistoryArgs),
          },
        };
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [call],
        });
        lastToolMsgs = [];
        await runToolCall(call, true);
        continue;
      }

      // A model ask-for-a-day is not an answer and not a fact claim. Accept
      // only the app-recognized clarification shape here, before the factual
      // floor would replace it with lookup_facts; the full trusted request is
      // retained below for the day-only retry.
      const clarificationText = stripResidualMarkup(
        result.content || result.text || '',
      );
      if (
        toolRounds === 0 &&
        !forceAnswer &&
        !roundStats[roundStats.length - 1]?.interrupted &&
        eventClarificationQuery(userText, clarificationText) !== null
      ) {
        cb.onThinking?.(false);
        finalText = clarificationText;
        break;
      }

      // THE GROUNDING FLOOR (owner's Pixel session, 2026-08-18): a factual
      // turn may not end as an unsourced memory answer. That session showed
      // TEN consecutive no-tool answers in one thread — the direct-answer
      // form learned from the qa-era data, base-model confabulation behind
      // it ("Reno County Fairgrounds", "Michael McManus"), one even citing
      // "the official Survival Guide" for a fact the guide never says. The
      // single-turn battery is structurally blind to this (every cell a
      // fresh thread, rounds/q read 1.0). If round 0 produced no tool call,
      // drop the narration, force ONE lookup_facts on the question itself,
      // and let the model answer with the passages in view. Smalltalk is
      // exempt; fires once per turn; the relational floor above runs first.
      if (
        !groundingFloorFired &&
        toolRounds === 0 &&
        !forceAnswer &&
        !speechRetry &&
        !roundStats[roundStats.length - 1]?.interrupted &&
        isFactualTurn(userText)
      ) {
        groundingFloorFired = true;
        toolRounds = 1;
        const routeEvent = routesEvent(userText);
        const call: ToolCall = {
          type: 'function',
          function: routeEvent
            ? {
                name: 'search_events',
                arguments: JSON.stringify({ query: eventSearchQuery(userText) }),
              }
            : {
                name: 'lookup_facts',
                arguments: JSON.stringify({ topic: groundingTopic(userText) }),
              },
        };
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        lastToolMsgs = [];
        await runToolCall(call, true);
        continue;
      }

      cb.onThinking?.(false);
      // stripResidualMarkup: when the chat parser does not recognize the
      // model's format, result.content can still carry raw <think>/tool spans.
      finalText = stripResidualMarkup(result.content || result.text || '');
      // THE ECHO GUARD (owner replay, 2026-08-18 11:00): three different
      // questions in one thread got the byte-identical answer — the model
      // called the right tool with the right topic each time, then ignored
      // the fresh passages and copied its own previous final ("It began in
      // 1986..." for "what is robot heart"). At temp 0.1 the repeated
      // assistant shape in context outweighs the new tool payload. A final
      // that equals the PREVIOUS turn's final, on a DIFFERENT question,
      // regenerates once with an in-context instruction; if it echoes
      // again, honesty beats repetition: the card-aware close speaks.
      if (
        !echoRetry &&
        prevFinal.length > 0 &&
        finalText.trim() === prevFinal &&
        userText.trim() !== prevUser
      ) {
        echoRetry = true;
        logSystemNote(
          this.persona.id,
          'echo guard: final repeats the previous answer on a new question — regenerating once',
        );
        messages.push({
          role: 'tool',
          name: 'note',
          content:
            '{"note":"You just gave the SAME answer as the previous question. This is a DIFFERENT question — answer it from the passages above, not from your last reply."}',
        });
        continue;
      }
      if (echoRetry && prevFinal.length > 0 && finalText.trim() === prevFinal) {
        finalText = toolResults.some(r => r.cards.length > 0 || r.sources.length > 0)
          ? FOUND_UNWRITTEN
          : NO_ANSWER;
        appVoice = true;
      }
      const resolvedEventSearches = authoritativeEventSearches(
        toolResults.flatMap(toolResult =>
          toolResult.eventSearch ? [toolResult.eventSearch] : [],
        ),
      ).filter(search => !(
        search.state === 'empty' &&
        (hasDocumentEvidence || hasStructuredCards || hasOtherAppAuthority)
      ));
      const appOwnsFinal =
        resolvedEventSearches.some(search => search.state !== 'not-run') ||
        (resolvedEventSearches.length > 0 && !hasDocumentEvidence) ||
        hasStructuredCards ||
        absentEntity !== null ||
        historyAbsence !== null ||
        historyAmbiguity !== null;
      if (!appOwnsFinal) {
        for (const visible of roundVisible) {
          markVisible();
          cb.onToken?.(visible);
        }
      }
      if (appOwnsFinal && finalText.trim().length === 0) {
        break;
      }
      // ANSWER-FORCING floor (r8): a turn may never end speechless. A round
      // that yields zero visible chars post-ThinkFilter and was NOT stopped
      // by the user retries exactly once with thinking suppressed and tools
      // off (a tool call is not speech either). Field shape this guards:
      // the model spends its whole completion inside <think> and the bubble
      // stays empty after the staged status line clears.
      const lastRound = roundStats[roundStats.length - 1];
      if (finalText.trim().length === 0 && !lastRound.interrupted) {
        if (!speechRetry) {
          speechRetry = true;
          logSystemNote(
            this.persona.id,
            'speechless round: retrying once with thinking suppressed',
          );
          continue;
        }
        // The forced retry came back empty too — close the turn honestly in
        // the app's own voice rather than with a blank bubble. Three cases,
        // and each says the true one: the packs do not carry this PERSON; a
        // lookup ran and the packs carry NOTHING on this; or nothing was
        // looked up at all and the Angel simply came up empty. Whimsy
        // ("slipped away into the dust") narrated a disappearance for all
        // three, which reads as a shrug over facts the app already knows.
        finalText = absentEntity
          ? absentNarration(absentEntity)
          : historyAbsence
          ? campHistoryAbsenceNarration(historyAbsence)
          : emptyLookup && toolResults.every(r => r.sources.length === 0)
          ? NOTHING_FOUND
          : toolResults.some(r => r.cards.length > 0)
          ? FOUND_UNWRITTEN
          : NO_ANSWER;
        appVoice = true;
        cb.onToken?.(finalText);
        markVisible();
      }
      break;
    }

    // App-owned structured rows are authoritative. Reconcile before logging,
    // inference history, UI return, or speech so no downstream surface can
    // preserve generated dates, counts, relationships, or an absolute denial
    // above real cards. Event rows deduplicate by database id; relational cards
    // deduplicate structurally so a repeated identical tool call cannot render
    // the same app-owned fact card twice.
    const seenFacts = new Set<string>();
    const eventCards = cappedEventCards(toolResults, 5);
    const factCards = toolResults.flatMap(result => result.cards).filter(card => {
      if (card.kind === 'event') {
        return false;
      }
      const key = JSON.stringify(card);
      if (seenFacts.has(key)) {
        return false;
      }
      seenFacts.add(key);
      return true;
    });
    const cards = [...eventCards, ...factCards];
    // Provenance follows the same rule as the cards: first mention of a
    // passage keeps its rank, and the whole turn stays inside the cap.
    let sources = mergeSourceRefs(toolResults.flatMap(result => result.sources));
    // Mutated by reconcileEvidenceState's closure; make that final state explicit
    // for TypeScript's control-flow analysis outside the closure.
    const reconciledHistoryAmbiguity =
      historyAmbiguity as HistoryAmbiguity | null;
    const historyCards = cards.some(
      card => card.kind !== 'event' && card.kind !== 'person',
    );
    const personCards = cards.some(card => card.kind === 'person');
    if (
      (historyCards || historyAbsence || reconciledHistoryAmbiguity) &&
      !personCards &&
      !compoundToolRound
    ) {
      // Relational rows carry their own evidence refs. Lower-authority document
      // passages from a competing tool call do not ride under that answer. A
      // surviving person card keeps the passage provenance it renders from.
      sources = [];
    }
    const finalEvents = cards.flatMap(card =>
      card.kind === 'event' ? [card.event] : [],
    );
    let eventSearches = authoritativeEventSearches(
      toolResults.flatMap(result =>
        result.eventSearch ? [result.eventSearch] : [],
      ),
      finalEvents,
    );
    if (
      eventSearches.length > 0 &&
      eventSearches.every(
        search => search.state === 'not-run' || search.state === 'empty',
      ) &&
      (
        sources.length > 0 ||
        cards.some(card => card.kind !== 'event') ||
        historyAbsence !== null ||
        reconciledHistoryAmbiguity !== null
      )
    ) {
      eventSearches = [];
    }
    const eventNarration = reconcileEventNarration(eventSearches, sources);
    const ownerPassageKeys = new Set<string>();
    // A MIXED deterministic round owns its factual text too (binding
    // review C13): gated on compoundToolRound alone, the forced lookup's
    // passages were dropped alongside the discarded model completion —
    // the answer became the event sentence with an orphaned source chip.
    // Passages compose whenever the APP owns the final text (binding
    // review C13, root form): `forced` was a proxy for app-owned, and it
    // dropped a MODEL-chosen lookup's passages in the same mixed round
    // whose model narration the event authority discards — the camper's
    // docs half became an orphaned source chip. The composition sites
    // below only fire under event narration or structured cards, so
    // unforced passages can never double a surviving model answer.
    const ownerFactualText =
      compoundToolRound || mixedDeterministicRound || eventNarration !== null
      ? toolResults
          .filter(result => result.toolName === 'lookup_facts')
          .flatMap(result => {
            const passages = result.sources
              .map(source => source.passage.trim())
              .filter(passage => {
                if (!passage || ownerPassageKeys.has(passage)) {
                  return false;
                }
                ownerPassageKeys.add(passage);
                return true;
              });
            // AN ABSENCE SENTENCE NEEDS A CLAUSE IT IS ABOUT (binding
            // re-review): the fallback was written for the multi-clause
            // turn where one clause genuinely found nothing. Widening the
            // gate to eventNarration let a SINGLE-clause event turn append
            // "…found nothing about parties are happening tonight" under
            // the event card that had just answered it, in the app's own
            // voice — the Angel contradicting its own authoritative
            // result, which CLAUDE.md pipeline rule 5 forbids. Passages
            // still compose everywhere; only the manufactured absence
            // stays bound to a turn that HAS a second clause, and only for
            // an app-FORCED lookup (a model's exploratory call is not a
            // clause the app promised to answer).
            return passages.length > 0
              ? passages
              : result.emptyLookup === true &&
                result.cards.length === 0 &&
                result.forced &&
                (compoundToolRound || mixedDeterministicRound)
              ? [nothingFoundNarration(groundingTopic(result.rawUserText))]
              : [];
          })
          .join(' ')
      : '';
    const ownerHistoryText = compoundToolRound || mixedDeterministicRound
      ? toolResults
          .filter(result =>
            result.forced &&
            result.toolName === 'lookup_history' &&
            result.historyAbsence !== undefined
          )
          .map(result => campHistoryAbsenceNarration(result.historyAbsence!))
          .join(' ')
      : '';
    const generatedOtherText = nonFactualOtherClauses.length > 0
      ? finalText.trim()
      : '';
    if (eventNarration) {
      finalText = [
        eventNarration.text,
        ownerHistoryText,
        ownerFactualText,
        generatedOtherText,
      ]
        .filter(Boolean)
        .join(' ');
      // The narration is DETERMINISTIC app text over the search outcome —
      // including the zero-result sentence. Without this mark, an empty
      // result carried no cards and no sources, answeredFrom fell through
      // to 'memory', and the bubble labeled the database's own authoritative
      // absence "from memory — could be wrong" (review batch 6.1).
      appVoice = true;
    }
    const structured = structuredCardNarration(
      cards.filter(card => card.kind !== 'event'),
    );
    if (structured !== null) {
      finalText = [
        eventNarration?.text,
        structured,
        ownerHistoryText,
        ownerFactualText,
        generatedOtherText,
      ]
        .filter(Boolean)
        .join(' ');
    } else if (
      reconciledHistoryAmbiguity !== null &&
      // Per-clause reconciliation (review batch 6.3): an EVENT card is not
      // an answer to the RELATIONAL clause — only a structured non-event
      // card (person/history) supersedes ambiguity narration. The event
      // narration still rides ahead of it in the composed sentence.
      cards.every(card => card.kind === 'event')
    ) {
      const candidates: PersonIdentityCandidate[] =
        reconciledHistoryAmbiguity.candidates.map(candidate => ({
          ...candidate,
          aliases: [],
        }));
      const ambiguity = personAmbiguityNarration(
        reconciledHistoryAmbiguity.query,
        candidates,
      );
      finalText = [
        eventNarration?.text,
        ambiguity,
        ownerHistoryText,
        ownerFactualText,
        generatedOtherText,
      ]
        .filter(Boolean)
        .join(' ');
      appVoice = true;
    } else if (absentEntity !== null && cards.every(card => card.kind === 'event')) {
      // A knowable absence leaves the model's mouth entirely, whether or not
      // it stayed silent: it DID speak here on device, and what it said was
      // an invented location for a dead camper. The packs were searched, the
      // packs carry nothing, and that sentence is the app's to write.
      finalText = [
        eventNarration?.text,
        absentNarration(absentEntity),
        ownerHistoryText,
        ownerFactualText,
        generatedOtherText,
      ]
        .filter(Boolean)
        .join(' ');
      appVoice = true;
    } else if (historyAbsence !== null && cards.every(card => card.kind === 'event')) {
      // Same rule for the relational half, for a sharper reason: the model's
      // own close here was TRUE and still wrong — it sent a camper asking
      // about camp lineage to a Black Rock City services desk. A camp-history
      // absence refers into the camp, and the app writes that sentence
      // (llm/factNarration.campHistoryAbsenceNarration).
      finalText = [
        eventNarration?.text,
        compoundToolRound ? '' : campHistoryAbsenceNarration(historyAbsence),
        ownerHistoryText,
        ownerFactualText,
        generatedOtherText,
      ]
        .filter(Boolean)
        .join(' ');
      appVoice = true;
    }
    if (
      !eventNarration &&
      structured === null &&
      reconciledHistoryAmbiguity === null &&
      absentEntity === null &&
      historyAbsence === null &&
      (ownerHistoryText || ownerFactualText)
    ) {
      finalText = [ownerHistoryText, ownerFactualText, generatedOtherText]
        .filter(Boolean)
        .join(' ');
      appVoice = true;
    }

    // Commit discourse identity only after the final card set is known. A
    // wrong/discarded tool result can no longer repoint a later pronoun.
    const singularPeople = new Map<string, PersonRef>();
    const directPerson = personAnchorFromCards(cards);
    if (directPerson) {
      singularPeople.set(
        `${directPerson.pack_id}\0${directPerson.id}`,
        directPerson,
      );
    }
    for (const result of toolResults) {
      if (!result.resolvedPerson || !result.cards.some(card =>
        card.kind === 'attendance' ||
        card.kind === 'projects' ||
        card.kind === 'lineage',
      )) {
        continue;
      }
      singularPeople.set(
        `${result.resolvedPerson.pack_id}\0${result.resolvedPerson.id}`,
        result.resolvedPerson,
      );
    }
    if (
      reconciledHistoryAmbiguity ||
      cards.some(card => card.kind === 'path' || card.kind === 'cohort') ||
      singularPeople.size > 1
    ) {
      this.lastPersonEntity = null;
    } else if (singularPeople.size === 1) {
      this.lastPersonEntity = [...singularPeople.values()][0];
    }

    // Assistant row: final text post-ThinkFilter plus the turn's aggregate
    // metrics. Token counts sum llama.rn's per-completion timings across all
    // rounds; null when no completion reported timings (mocked contexts).
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let thinkingChars = 0;
    for (const r of roundStats) {
      const t = r.timings as { prompt_n?: number; predicted_n?: number } | null;
      if (t && typeof t.prompt_n === 'number') {
        promptTokens = (promptTokens ?? 0) + t.prompt_n;
      }
      if (t && typeof t.predicted_n === 'number') {
        completionTokens = (completionTokens ?? 0) + t.predicted_n;
      }
      thinkingChars += r.thinking_chars;
    }
    logChat({
      role: 'assistant',
      persona: this.persona.id,
      text: finalText,
      model_file: modelName,
      sampler_json: samplerJson(),
      ttft_ms: firstVisibleAt === null ? null : firstVisibleAt - turnT0,
      total_ms: Date.now() - turnT0,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      thinking_chars: thinkingChars,
      timings_json: JSON.stringify(roundStats),
    });
    if (roundStats.some(r => r.interrupted)) {
      logSystemNote(
        this.persona.id,
        `turn interrupted (stop) after ${Date.now() - turnT0}ms`,
      );
    }

    if (evictedHistoryTurns.size > 0) {
      this.history = this.history.filter(turn => !evictedHistoryTurns.has(turn));
    }
    const nextEventQuery =
      clarifiedEvent === null && toolRounds === 0
        ? eventClarificationQuery(userText, finalText)
        : null;
    if (eventNarration || eventSearches.length === 0) {
      this.stripStructuredEventHistory();
    }
    const inferenceText = eventNarration
      ? `${finalText}\n${eventNarration.history}`
      : finalText;
    const historyTurn: HistoryTurn = {
      user: { role: 'user', content: userText },
      assistant: { role: 'assistant', content: inferenceText },
      raw: [
        // The forced-final nudge is a WITHIN-TURN steering mutation on a
        // tool message; replayed across turns it would nag every future
        // completion. The raw thread stores the un-nudged payload. The
        // assistant tail is inferenceText, not finalText: the event
        // narration's history annex exists precisely to ride into the next
        // turn's context, and the raw slice IS that context.
        ...messages.slice(turnBase).map((m, index) =>
          scopedNonFactualPrompt !== null && index === 0 && m.role === 'user'
            ? { ...m, content: userText }
            : m.role === 'tool' && m.content?.endsWith(FORCED_FINAL_NUDGE)
            ? { ...m, content: m.content.slice(0, -FORCED_FINAL_NUDGE.length) }
            : m,
        ),
        { role: 'assistant', content: inferenceText },
      ],
      noToolFailure: isNoToolFailure(finalText, toolRounds),
      omitFromInference: nextEventQuery !== null,
    };
    this.history.push(historyTurn);
    if (eventNarration) {
      this.structuredEventHistoryTurn = historyTurn;
    }
    this.pendingEventQuery = nextEventQuery;
    this.lastEventResults = eventSearches.length > 0 ? finalEvents : [];
    this.pendingEventFollowUp = null;

    const answeredFrom: ChatTurnResult['answeredFrom'] =
      cards.length > 0 || sources.length > 0 ? 'packs' : appVoice ? 'app' : 'memory';
    return {
      text: finalText,
      cards,
      sources,
      ...(eventSearches.length > 0 ? { eventSearches } : {}),
      toolRounds,
      answeredFrom,
    };
  }

  async stop(): Promise<void> {
    const contexts = new Set(this.activeContexts.keys());
    if (this.context) {
      contexts.add(this.context);
    }
    await Promise.allSettled([...contexts].map(context => context.stopCompletion()));
  }

  /**
   * PUT THE WEIGHTS DOWN WITHOUT ENDING THE SESSION — the "let her rest" half
   * of the Angel switch (llm/angelRest.ts). Everything release() does except
   * the tombstone, so a later load() on this same session wakes her again;
   * release() marks the session disposed and load() refuses forever after.
   *
   * The freeing is REAL and immediate, which is the whole point on a phone
   * that was being killed for holding ~1.4 GB it wasn't using: in-flight
   * generation is stopped, every context waited out and released natively.
   */
  async unload(): Promise<void> {
    // The CONVERSATION deliberately survives. It is a handful of strings,
    // not the ~1.4 GB this frees, and the camper can still read what she
    // said while she rests — so clearing it would leave the screen showing
    // turns the session no longer knows about, the ghost-history pair
    // inverted. Swapping models already preserves history for exactly this
    // reason; resting is the same move without a replacement.
    await this.releaseEveryContext();
  }

  /**
   * Release every native context still owned by this session. Ownership is
   * cleared only after native release succeeds, so a rejection is diagnosable
   * and the next call retries the same handle rather than leaking it.
   */
  async release(): Promise<void> {
    this.disposed = true;
    await this.releaseEveryContext();
    this.history = [];
    this.structuredEventHistoryTurn = null;
    this.lastPersonEntity = null;
    this.lastEventResults = [];
    this.pendingEventFollowUp = null;
    this.pendingEventQuery = null;
    this.personaRecoveryError = null;
  }

  private async releaseEveryContext(): Promise<void> {
    this.invalidateLoads();
    await this.stop();
    await Promise.allSettled([...this.pendingLoads]);
    await this.queueOperation(async () => {
      const contexts = [...this.ownedContexts].filter(
        context => !this.loadingContexts.has(context),
      );
      await Promise.all(contexts.map(context => this.waitForContextIdle(context)));
      const failures = (await Promise.allSettled(
        contexts.map(context => this.releaseOwned(context)),
      )).flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) {
        const details = failures
          .map(e => e instanceof Error ? e.message : String(e))
          .join('; ');
        throw new Error(
          `Failed to release ${failures.length} model context(s); ` +
            `${this.ownedContexts.size} remain owned and release() can retry: ${details}`,
        );
      }
    });
  }
}
