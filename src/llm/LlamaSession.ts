/**
 * llama.rn integration: model loading, per-persona KV warm-up, the
 * tool-calling chat loop, and context-overflow retry.
 *
 * Shipping configuration:
 *   - thinking stays enabled for routing precision, with safety budgets below
 *   - near-greedy sampler (see SAMPLER below)
 *   - n_predict 2048 because thinking shares the completion budget
 *   - four threads on the measured phone class; extra efficiency cores hurt
 *   - CPU by default on Android and Metal on iOS
 *   - at most two tool rounds, including multi-call responses
 *   - mandatory per-persona warm-up: the processed system prompt is cached by
 *     prompt hash, then the model remains resident for the app session
 *   - context overflow halves tool-result candidates and retries, floor two
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
  mkdir,
} from '@dr.pogodin/react-native-fs';
import type { ChatCard, ModelStatus, PersonRef, SourceRef } from '../types';
import { loadFailureMessage } from './loadFailure';
import { mergeSourceRefs } from '../docs/sourceRef';
import { identityAffiliationTerms } from '../events/db';
import { ALL_TOOLS, LOOKUP_HISTORY_TOOL } from './tools';
import { getPersona, Persona } from './personas';
import {
  ThinkFilter,
  streamChunkFromPartial,
  stripResidualMarkup,
} from './thinkFilter';
import { executeTool, ToolOutcome } from './toolExecutor';
import { reconcileEventNarration } from './eventNarration';
import {
  absentNarration,
  campHistoryAbsenceNarration,
  personAmbiguityNarration,
  personCardUnavailableNarration,
  personNotFoundNarration,
  structuredCardNarration,
  NOTHING_FOUND,
  NO_ANSWER,
  FOUND_UNWRITTEN,
} from './factNarration';
import { historyToolArgs, splitClauses, type HistoryToolArgs } from './historyIntent';
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
import { eventClarificationQuery } from './eventClarification';
import { isNoToolFailure, refersToPriorFailure } from './inferenceHistory';
import { parseDayOnly } from '../events/timeParser';
import { logChat, logSystemNote, rotateChatSession } from '../log/chatLog';

/** Near-greedy sampler for reliable tool routing with LFM2.5-2.6B. Keep the
 * evaluated app and model configuration aligned; do not lower n_predict
 * below 1024 because thinking and the final answer share that budget. */
export const SAMPLER = {
  temperature: 0.1,
  top_k: 50,
  penalty_repeat: 1.1,
  n_predict: 2048,
} as const;

/** Thinking latency is user-visible on a phone, so the app carries a safety
 * budget above normal trained responses but below a runaway completion. The
 * 200-token final budget bounds worst-case delay without clipping ordinary
 * answers. It is recorded in sampler_json so evaluation can detect a model
 * that regularly reaches the cap. Speech retry uses a zero thinking budget
 * because disabling thinking in the template is not reliably honored. */
export const THINK_BUDGET_TOKENS = 200;
/** Tool routing needs less deliberation than final prose. A 96-token budget
 * bounds each of the two possible tool rounds; the final answer gets 200. */
export const THINK_BUDGET_TOOL_ROUND_TOKENS = 96;
export const THINK_BUDGET_MESSAGE = ' Enough thinking. Answering now.';

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
/** Flip to experiment with GPU decode on Android (Vulkan: better tg, worse pp). */
const ANDROID_GPU_EXPERIMENT = false;

export interface ChatTurnResult {
  text: string;
  /** App-owned cards from tool calls; dates and counts never come from prose. */
  cards: ChatCard[];
  /** The passages this answer stood on, for the tappable source chips.
   * Empty on an untooled turn — an answer with no retrieval cites nothing. */
  sources: SourceRef[];
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
 * budget rides along (2026-08-17): a row without it ran the r8 uncapped
 * config; a row with it ran the safety-net config. */
const samplerJson = (): string =>
  JSON.stringify({
    ...SAMPLER,
    thinking_budget_tokens: THINK_BUDGET_TOKENS,
    thinking_budget_tool_turn_tokens: THINK_BUDGET_TOOL_ROUND_TOKENS,
  });

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

/** FNV-1a 32-bit — stable key for the system prompt -> session file. */
export function promptHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    // eslint-disable-next-line no-bitwise -- FNV-1a is inherently bitwise
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // eslint-disable-next-line no-bitwise -- unsigned coercion
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Warmed KV prefixes are valid only for this exact prompt + tool schema. */
export function toolSchemaHash(
  systemPrompt: string,
  tools: readonly unknown[] = ALL_TOOLS,
): string {
  return promptHash(`${systemPrompt}\0${JSON.stringify(tools)}`);
}

export class LlamaSession {
  private context: LlamaContext | null = null;
  private persona: Persona;
  private history: HistoryTurn[] = [];

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
  private pendingEventQuery: string | null = null;
  private modelName: string | null = null;

  constructor(personaId: string) {
    this.persona = getPersona(personaId);
  }

  get isReady(): boolean {
    return this.context !== null;
  }

  /** The loaded model's filename, for status restoration after a failed
   * download (a failed pull must never brick a resident model). */
  get loadedModelName(): string | null {
    return this.modelName;
  }

  get personaId(): string {
    return this.persona.id;
  }

  private sessionFile(): string {
    return `${DocumentDirectoryPath}/sessions/${toolSchemaHash(
      this.persona.systemPrompt,
    )}.llama-session`;
  }

  /**
   * Load a GGUF model, then restore this persona's warmed KV session — or
   * warm it up now (one-time "warming up your Angel..." moment).
   */
  async load(modelPath: string, onStatus: (s: ModelStatus) => void): Promise<void> {
    onStatus({ state: 'loading', detail: 'Loading model…' });
    try {
      this.context = await initLlama(
        {
          model: modelPath,
          n_ctx: N_CTX,
          n_threads: N_THREADS,
          // Metal on iOS. Android runs CPU by default (Pixel 7: CPU -t4
          // pp 13.3 t/s beats Vulkan prefill; flip the experiment flag to
          // trade prefill for Vulkan's slightly better decode).
          n_gpu_layers:
            Platform.OS === 'ios' || ANDROID_GPU_EXPERIMENT ? 99 : 0,
          use_mlock: true,
        },
        progress =>
          onStatus({ state: 'loading', detail: `Loading model… ${progress}%` }),
      );
      await mkdir(`${DocumentDirectoryPath}/sessions`);
      await this.restoreOrWarmUp(onStatus);
      this.modelName = modelPath.split('/').pop() ?? modelPath;
      logSystemNote(this.persona.id, `model loaded: ${this.modelName}`);
      onStatus({ state: 'ready', modelName: this.modelName });
    } catch (e: any) {
      this.context = null;
      const raw = e?.message ?? String(e);
      logSystemNote(this.persona.id, `model load failed: ${raw}`);
      // CAMPER-ACTIONABLE ERRORS (P2-5): a raw native exception ("failed to
      // mmap model", "gguf tensor data offset is not within file bounds")
      // reads as a crash to a camper who can FIX it — full storage, a
      // truncated download, or a phone that can't hold the model. Map the
      // common shapes to the fix; keep the raw string in console.warn for
      // diagnostics. Unknown errors stay honest, never dressed up.
      console.warn('[llm] model load failed (raw):', raw);
      onStatus({ state: 'error', detail: loadFailureMessage(raw) });
      throw e;
    }
  }

  /**
   * MANDATORY warm-up (Pixel 7: ~16s prefill for a 200-token system prompt).
   * Processes the persona's system prompt once and saves the KV state keyed
   * by prompt hash; later launches reload it for ~1-2s TTFT.
   */
  private async restoreOrWarmUp(onStatus: (s: ModelStatus) => void): Promise<void> {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const file = this.sessionFile();
    if (await exists(file)) {
      try {
        await ctx.loadSession(file);
        return;
      } catch (e) {
        console.warn('[llm] stale session ignored, re-warming:', e);
      }
    }
    // Persona chip label ("Angel"/"Historian"/"Teller"), not the full display
    // name — "Warming up your The Teller" was the owner-reported string bug.
    onStatus({ state: 'loading', detail: `Warming up the ${this.persona.label}…` });
    // Process the system prompt through the chat template; generate nothing.
    // Tools MUST be passed here: the template renders tool specs into the
    // prompt prefix, so a tool-less warm-up produces a prefix that never
    // matches a real chat turn and the warmed state is useless
    // (device-validated 2026-08-13).
    await ctx.completion({
      messages: [{ role: 'system', content: this.persona.systemPrompt }] as any,
      jinja: true,
      tools: ALL_TOOLS as any,
      tool_choice: 'auto',
      n_predict: 1,
      enable_thinking: true,
    });
    try {
      await ctx.saveSession(file, { tokenSize: N_CTX });
    } catch (e) {
      console.warn('[llm] saveSession failed (warm-up not persisted):', e);
    }
  }

  /**
   * Switch persona ON THE RESIDENT MODEL: personas are system prompts + their
   * own saved KV session on the one loaded GGUF (owner ruling 2026-08-13) —
   * the model is NEVER reloaded here. Swap = clear cache, then loadSession
   * (or a one-time warm-up if this persona has no session yet).
   */
  /** Reset to a clean warmed context for the CURRENT persona — the "new
   * chat" boundary without a persona swap. Same hard-clear rules as a
   * switch: LFM2-class recurrent state only fully clears via clearCache. */
  async newConversation(
    onStatus: (s: ModelStatus) => void = () => {},
  ): Promise<void> {
    this.history = [];
    this.pendingEventQuery = null;
    // The anchor is conversation state: a pronoun in a NEW chat has no
    // antecedent, and inheriting one across the boundary would resolve it to
    // someone the asker never mentioned.
    this.lastPersonEntity = null;
    rotateChatSession();
    logSystemNote(this.persona.id, 'new conversation');
    if (this.context) {
      await this.context.clearCache(true);
      await this.restoreOrWarmUp(onStatus);
      onStatus({ state: 'ready', modelName: this.modelName ?? 'model' });
    }
  }

  async setPersona(
    personaId: string,
    onStatus: (s: ModelStatus) => void = () => {},
  ): Promise<void> {
    if (personaId === this.persona.id) {
      return;
    }
    const previousId = this.persona.id;
    this.persona = getPersona(personaId);
    this.history = [];
    this.lastPersonEntity = null;
    // The transcript clears here — this is the app's "new chat" boundary, so
    // the field log starts a fresh session and records the switch in it.
    rotateChatSession();
    logSystemNote(personaId, `persona switch: ${previousId} -> ${personaId}`);
    if (this.context) {
      // LFM2-class hybrid models keep recurrent state that can only be fully
      // cleared — always hard-clear on persona switch.
      await this.context.clearCache(true);
      await this.restoreOrWarmUp(onStatus);
      // restoreOrWarmUp reports "loading" while warming; without this the
      // status bar stayed on "Warming up…" forever and the input never
      // re-enabled — the bug that made persona switching look broken.
      onStatus({ state: 'ready', modelName: this.modelName ?? 'model' });
    }
  }

  private historyMessages(turns: HistoryTurn[]): ChatMsg[] {
    // Newest turns keep their place; oldest whole turns are evicted when the
    // budget fills. Eviction never orphans a tool message because a turn's
    // raw slice is self-contained (assistant-with-tool_calls + its results).
    const kept: ChatMsg[][] = [];
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
        kept.unshift(slice);
        budget -= cost;
      } else {
        // even the newest turn overflows alone: keep its user+final only
        kept.unshift([turn.user, turn.assistant]);
        break;
      }
    }
    return kept.flat();
  }

  private inferenceHistory(userText: string): ChatMsg[] {
    let end = this.history.length;
    if (!refersToPriorFailure(userText)) {
      while (end > 0 && this.history[end - 1].noToolFailure) {
        end -= 1;
      }
    }
    return this.historyMessages(this.history.slice(0, end));
  }

  private finishIdentityTurn(
    userText: string,
    intent: IdentityIntent,
    outcome: PersonIdentityOutcome,
    cb: TurnCallbacks,
    turnT0: number,
    relational: HistoryToolArgs | null = null,
  ): ChatTurnResult {
    cb.onToolCall?.('lookup_person', true);
    logChat({
      role: 'user',
      persona: this.persona.id,
      text: userText,
      model_file: this.modelName,
    });
    logChat({
      role: 'tool_call',
      persona: this.persona.id,
      text: JSON.stringify({ name: 'lookup_person', args: { topic: intent.topic } }),
      model_file: this.modelName,
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
      if (relational && 'entity' in relational) {
        const args = { ...relational, entity: outcome.person.name };
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
        if (rel.absence) {
          text = `${text} ${campHistoryAbsenceNarration(rel.absence)}`;
        } else if (rel.cards.length > 0) {
          text = `${text} ${relationalFollowUpLine(relational.query)}`;
        }
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
      model_file: this.modelName,
    });
    logChat({
      role: 'assistant',
      persona: this.persona.id,
      text,
      model_file: this.modelName,
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
      assistant: { role: 'assistant', content: text },
      raw: [
        { role: 'user', content: userText },
        { role: 'assistant', content: text },
      ],
      noToolFailure: false,
      omitFromInference: false,
    });
    this.pendingEventQuery = null;
    this.lastPersonEntity = outcome.status === 'resolved' ? outcome.person : null;
    return { text, cards, sources, toolRounds: 1, answeredFrom: cards.length > 0 ? 'packs' : 'app' };
  }

  /** Run one user turn through the capped tool loop. */
  async chat(userText: string, cb: TurnCallbacks = {}): Promise<ChatTurnResult> {
    const turnT0 = Date.now();
    try {
      return await this.runTurn(userText, cb, turnT0);
    } catch (e: any) {
      // Field log: failures are rows too — the error string, in-session.
      logSystemNote(
        this.persona.id,
        `turn failed after ${Date.now() - turnT0}ms: ${e?.message ?? e}`,
      );
      throw e;
    }
  }

  private async runTurn(
    userText: string,
    cb: TurnCallbacks,
    turnT0: number,
  ): Promise<ChatTurnResult> {
    const ctx = this.context;
    if (!ctx) {
      throw new Error('Model not loaded');
    }
    const pendingEventQuery = this.pendingEventQuery;
    this.pendingEventQuery = null;
    const clarifiedDay =
      pendingEventQuery === null ? null : parseDayOnly(userText);
    const clarifiedEvent =
      clarifiedDay === null
        ? null
        : { query: pendingEventQuery ?? '', day: clarifiedDay };
    // THE PRONOUN ANCHOR, read ONCE, before this turn looks anything up: the
    // antecedent of "her" is who the session had resolved when the question
    // was asked, so a lookup made later in this same turn can never re-point
    // the pronoun that lookup is answering. Null on a fresh conversation, and
    // null makes every slot filler below behave exactly as it does today.
    const personAnchor = this.lastPersonEntity;
    const affiliations = identityAffiliationTerms();
    const forcedHistoryArgs =
      historyToolArgs(userText, personAnchor);
    const forceHistoryTool =
      forcedHistoryArgs !== null;
    // Identity is resolved before the model can stream a syllable. The exact
    // graph match (or explicit ambiguity) claims broad real-world names;
    // syntactically conservative unknowns close honestly; topic-like unknowns
    // fall through to ordinary routing.
    // A compound question — "who is X and who has he sponsored" — is an
    // identity question about its FIRST clause plus a relational follow-up
    // (historyToolArgs already parsed the whole sentence, resolving "he" to
    // X). Only that shape reaches the compound path; a lone identity or a
    // lone relational question behaves exactly as before.
    const clauses = splitClauses(userText);
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
          compoundIdentity !== null ? forcedHistoryArgs : null,
        );
      }
    }
    // The model's failed ask-for-a-day exchange stays in the transcript/log,
    // but the forced retry sees a clean event request plus its tool result.
    const priorMessages = clarifiedEvent
      ? this.historyMessages(this.history.slice(0, -1))
      : this.inferenceHistory(userText);
    const promptUserText = clarifiedEvent
      ? `${clarifiedEvent.query || 'events'} ${clarifiedEvent.day}`
      : userText;
    const messages: ChatMsg[] = [
      { role: 'system', content: this.persona.systemPrompt },
      ...priorMessages,
      { role: 'user', content: promptUserText },
    ];
    // The raw thread: this turn's contribution = everything appended from
    // here on (its user message, tool exchanges with reasoning, notes),
    // plus the final. History replays it verbatim next turn.
    const turnBase = messages.length - 1;
    // Signatures of tool calls already EXECUTED this turn (name + exact
    // args). A model that repeats the identical call is not gathering — it
    // is stuck (measured 2026-08-17: search_events("Robot Heart", today)
    // twice back-to-back, then a speechless final). The repeat costs a full
    // device round (~30 s) and buys nothing; the dup guard answers it with
    // an in-context instruction instead of re-executing.
    const executedCalls = new Set<string>();
    const toolResults: {
      cards: ChatCard[];
      sources: SourceRef[];
      resolvedPerson?: PersonRef;
      noCoverage?: string;
      emptyLookup?: boolean;
      historyAbsence?: HistoryAbsence;
      historyAmbiguity?: HistoryAmbiguity;
    }[] = [];
    let toolRounds = 0;
    let finalText = '';
    // Context-overflow retry state (iBurn withContextWindowRetry pattern):
    // shrinkers for the most recent round's tool-result messages, so a
    // context_full completion can rebuild them with fewer candidates.
    let lastToolMsgs: {
      msgIndex: number;
      outcome: ToolOutcome;
      result: { cards: ChatCard[]; sources: SourceRef[] };
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
      model_file: this.modelName,
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
      const documentPositive = toolResults.some(
        result => result.sources.length > 0,
      );
      historyAmbiguity = toolResults
        .flatMap(result => result.historyAmbiguity ? [result.historyAmbiguity] : [])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] ?? null;
      const history = toolResults
        .flatMap(result => result.historyAbsence ? [result.historyAbsence] : [])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] ?? null;
      historyAbsence = structuredPositive || historyAmbiguity ? null : history;
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

    const runToolCall = async (call: ToolCall, forced = false): Promise<void> => {
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
      cb.onToolCall?.(call.function.name, forced);
      logChat({
        role: 'tool_call',
        persona: this.persona.id,
        text: JSON.stringify({ name: call.function.name, args: argsStr }),
        model_file: this.modelName,
      });
      const outcome = await executeTool(
        call,
        userText,
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
        model_file: this.modelName,
      });
      cb.onToolDone?.(call.function.name, outcome.cards, stored.sources);
    };

    if (clarifiedEvent) {
      toolRounds = 1;
      const call: ToolCall = {
        type: 'function',
        function: {
          name: 'search_events',
          arguments: JSON.stringify(clarifiedEvent),
        },
      };
      messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      await runToolCall(call, true);
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
      const forceAnswer =
        clarifiedEvent !== null ||
        (forceHistoryTool && toolRounds > 0) ||
        hasStructuredCards ||
        toolRounds >= TOOL_ROUND_CAP ||
        speechRetry;
      const forceHistoryCall = forceHistoryTool && toolRounds === 0;
      if (forceAnswer && (toolRounds >= TOOL_ROUND_CAP || speechRetry)) {
        // Say out loud that the tools are gone (see FORCED_FINAL_NUDGE).
        nudgeLastToolMessage(messages);
      }
      const filter = new ThinkFilter();
      // Forensics (logcat/ReactNativeJS): the exact assembly every completion
      // sees — role:chars per message, in order. A duplicated exchange or a
      // double-fed tool result shows up here immediately (owner field bug
      // 2026-08-13 was unclassifiable without this).
      if (__DEV__) console.log(
        `[llm] round=${toolRounds} assembly=${messages
          .map(m => `${m.role}:${m.content.length}${m.tool_calls ? '+tc' : ''}${m.reasoning_content ? '+r' + m.reasoning_content.length : ''}`)
          .join(',')}`,
      );
      const result = await ctx.completion(
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
          // Uncapped thinking (r8) — the graded config. Suppressed only on
          // the answer-forcing retry: the think already happened once and
          // produced no speech; a second silent think helps no one.
          enable_thinking: !speechRetry,
          // The safety-net budget (see THINK_BUDGET_TOKENS). llama.rn closes
          // the think block at the budget by emitting the message + end tag;
          // it only activates when the template exposes think tags, which
          // LFM2.5's does. Zero on the speech retry = answer immediately.
          thinking_budget_tokens: speechRetry
            ? 0
            : forceAnswer
            ? THINK_BUDGET_TOKENS
            : THINK_BUDGET_TOOL_ROUND_TOKENS,
          thinking_budget_message: THINK_BUDGET_MESSAGE,
          reasoning_format: 'auto',
          ...SAMPLER,
        },
        data => {
          // ONLY data.token is a delta. data.content / reasoning_content are
          // ACCUMULATED parsed snapshots (llama.rn re-parses the whole
          // completion on every token) — streaming them as deltas replayed
          // raw <think> text into the bubble for ~10 s (the owner-visible
          // thinking leak, Pixel 7 2026-08-13). See streamChunkFromPartial.
          const chunk = streamChunkFromPartial(data);
          if (chunk.length > 0) {
            const { visible, thinking } = filter.push(chunk);
            cb.onThinking?.(thinking);
            if (visible.length > 0) {
              markVisible();
              cb.onToken?.(visible);
            }
          }
        },
      );

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
        }
        reconcileEvidenceState();
        continue;
      }

      const toolCalls = result.tool_calls ?? [];
      if (toolCalls.length > 0 && !forceAnswer) {
        toolRounds += 1;
        // A narrow relational question exposes only lookup_history. Keep the
        // model's tool selection, but replace drifted free-text slots (device:
        // query="years attended") with the app's confidently parsed enum slots.
        const routedToolCalls = toolCalls.map(call =>
          forcedHistoryArgs !== null && call.function.name === 'lookup_history'
            ? {
                ...call,
                function: {
                  ...call.function,
                  arguments: JSON.stringify(forcedHistoryArgs),
                },
              }
            : call,
        );
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
        // message per call, in order.
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
        const call: ToolCall = {
          type: 'function',
          function: {
            name: 'lookup_facts',
            arguments: JSON.stringify({ topic: groundingTopic(userText) }),
          },
        };
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        lastToolMsgs = [];
        await runToolCall(call, true);
        continue;
      }

      const tail = filter.flush();
      if (tail.length > 0) {
        markVisible();
        cb.onToken?.(tail);
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
    const seenEvents = new Set<number>();
    const seenFacts = new Set<string>();
    const cards = toolResults.flatMap(result => result.cards).filter(card => {
      if (card.kind === 'event') {
        if (seenEvents.has(card.event.id)) {
          return false;
        }
        seenEvents.add(card.event.id);
        return true;
      }
      const key = JSON.stringify(card);
      if (seenFacts.has(key)) {
        return false;
      }
      seenFacts.add(key);
      return true;
    });
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
    if ((historyCards || historyAbsence || reconciledHistoryAmbiguity) && !personCards) {
      // Relational rows carry their own evidence refs. Lower-authority document
      // passages from a competing tool call do not ride under that answer. A
      // surviving person card keeps the passage provenance it renders from.
      sources = [];
    }
    const eventCount = cards.filter(card => card.kind === 'event').length;
    finalText = reconcileEventNarration(finalText, eventCount);
    const structured = structuredCardNarration(cards);
    if (structured !== null) {
      finalText = structured;
    } else if (reconciledHistoryAmbiguity !== null && cards.length === 0) {
      const candidates: PersonIdentityCandidate[] =
        reconciledHistoryAmbiguity.candidates.map(candidate => ({
          ...candidate,
          aliases: [],
        }));
      finalText = personAmbiguityNarration(
        reconciledHistoryAmbiguity.query,
        candidates,
      );
      appVoice = true;
    } else if (absentEntity !== null && cards.length === 0) {
      // A knowable absence leaves the model's mouth entirely, whether or not
      // it stayed silent: it DID speak here on device, and what it said was
      // an invented location for a dead camper. The packs were searched, the
      // packs carry nothing, and that sentence is the app's to write.
      finalText = absentNarration(absentEntity);
      appVoice = true;
    } else if (historyAbsence !== null && cards.length === 0) {
      // Same rule for the relational half, for a sharper reason: the model's
      // own close here was TRUE and still wrong — it sent a camper asking
      // about camp lineage to a Black Rock City services desk. A camp-history
      // absence refers into the camp, and the app writes that sentence
      // (llm/factNarration.campHistoryAbsenceNarration).
      finalText = campHistoryAbsenceNarration(historyAbsence);
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
      model_file: this.modelName,
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

    const nextEventQuery =
      clarifiedEvent === null && toolRounds === 0
        ? eventClarificationQuery(userText, finalText)
        : null;
    this.history.push({
      user: { role: 'user', content: userText },
      assistant: { role: 'assistant', content: finalText },
      raw: [
        // The forced-final nudge is a WITHIN-TURN steering mutation on a
        // tool message; replayed across turns it would nag every future
        // completion. The raw thread stores the un-nudged payload.
        ...messages.slice(turnBase).map(m =>
          m.role === 'tool' && m.content?.endsWith(FORCED_FINAL_NUDGE)
            ? { ...m, content: m.content.slice(0, -FORCED_FINAL_NUDGE.length) }
            : m,
        ),
        { role: 'assistant', content: finalText },
      ],
      noToolFailure: isNoToolFailure(finalText, toolRounds),
      omitFromInference: nextEventQuery !== null,
    });
    this.pendingEventQuery = nextEventQuery;

    const answeredFrom: ChatTurnResult['answeredFrom'] =
      cards.length > 0 || sources.length > 0 ? 'packs' : appVoice ? 'app' : 'memory';
    return { text: finalText, cards, sources, toolRounds, answeredFrom };
  }

  async stop(): Promise<void> {
    await this.context?.stopCompletion();
  }

  /** Release the model. ONLY on app teardown — never between messages. */
  async release(): Promise<void> {
    await this.context?.release();
    this.context = null;
  }
}
