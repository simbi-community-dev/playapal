/**
 * The Angel chat — persona conversation over the offline model with the
 * tool loop underneath. Secondary surface (Right Now is home).
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ChatMessage, ModelStatus, SourceRef } from '../types';
import type { HideTarget } from '../components/dontUseThis';
import { mergeSourceRefs } from '../docs/sourceRef';
import { LlamaSession } from '../llm/LlamaSession';
import { PERSONAS } from '../llm/personas';
import {
  loadSpeechSettings,
  SentenceFeed,
  speechForAssistantMessage,
  toMarkdownlessSpeech,
  useSpeaker,
} from '../speech';
import { MessageBubble } from '../components/MessageBubble';
import { ModelStatusBar } from '../components/ModelStatusBar';
import { PulsingLabel } from '../components/PulsingLabel';
import { hideItem, listPacks } from '../events/db';
import {
  enabledKnowledgePacks,
  knowledgeEmptyState,
} from './chatKnowledge';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  session: LlamaSession;
  status: ModelStatus;
  onPickModel: () => void;
  onStatus: (s: ModelStatus) => void;
  /** Prefilled question routed from the Right Now screen. */
  pendingQuestion?: string | null;
  onPendingConsumed?: () => void;
}

let nextId = 1;
const msgId = (): string => `m${nextId++}`;

/** One rung of the staged status line — label plus a DISTINCT subtle
 * animation (pulse period / drift), so the silent pipeline reads as live
 * progress, not a frozen spinner. */
interface StageLine {
  label: string;
  period: number;
  drift?: boolean;
}

const STAGE_THINKING: StageLine = { label: 'thinking…', period: 1200 };
const STAGE_READING: StageLine = {
  label: 'reading what I found…',
  period: 900,
  drift: true,
};

/** Tool-emit stage: name the actual tool the model chose. */
function stageForTool(name: string): StageLine {
  return {
    label:
      name === 'search_events'
        ? 'checking the event guide…'
        : name === 'lookup_facts'
        ? 'checking the survival guide…'
        : name === 'lookup_history'
        ? 'checking camp history…'
        : name === 'lookup_person'
        ? 'checking the camp list…'
        : 'checking your packs…',
    period: 700,
    drift: true,
  };
}

export function ChatScreen({
  session,
  status,
  onPickModel,
  onStatus,
  pendingQuestion,
  onPendingConsumed,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<StageLine | null>(null);
  const [personaId, setPersonaId] = useState(session.personaId);
  const [packs] = useState(() => listPacks());
  const knowledgePacks = enabledKnowledgePacks(packs);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Spoken replies: stops on unmount (screen exit) automatically.
  const speaker = useSpeaker();

  // Seam guard (defense-in-depth behind App.tsx keeping this screen
  // mounted): if this screen mounts FRESH while the session still carries
  // exchanges, the pair desynced — the user sees an empty thread, so the
  // session must BE empty, or the next question rides invisible history
  // (the ghost-history bug, Pixel 7 2026-08-17). Empty UI wins: reset.
  React.useEffect(() => {
    if (session.hasHistory()) {
      void session.newConversation(onStatus);
    }
    // mount-only: messages is [] by construction on first render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (pendingQuestion && pendingQuestion.trim().length > 0) {
      setInput(pendingQuestion.trim());
      onPendingConsumed?.();
    }
  }, [pendingQuestion, onPendingConsumed]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (text.length === 0 || busy || !session.isReady) {
      return;
    }
    setInput('');
    setBusy(true);
    // A new question silences the previous answer.
    speaker.stop();
    // Streamed speech: completed sentences are enqueued AS THEY DECODE, so
    // the reply starts speaking at the first sentence boundary instead of
    // after the whole turn (owner field report: 30 s tooled turns felt long).
    const speechOn = loadSpeechSettings().enabled;
    let feed = new SentenceFeed();
    let queuedAny = false;
    // STAGED STATUS LINE: the pipeline is silent for many seconds (prefill ->
    // think -> tool -> round-2 prefill -> think) before any text; each real
    // stage flips the line so the wait reads as progress. Stage timestamps go
    // to logcat (ReactNativeJS) for on-device timing verification.
    const turnStart = Date.now();
    let lastStageTag = '';
    let sawTool = false;
    let sawCardTool = false;
    let sawText = false;
    // The passages this answer stands on, accumulated as each tool lands.
    let found: SourceRef[] = [];
    const setStage = (line: StageLine | null, tag: string) => {
      if (tag === lastStageTag) {
        return;
      }
      lastStageTag = tag;
      setActivity(line);
      console.log(`[stage] +${Date.now() - turnStart}ms ${tag}`);
    };
    // Show the indicator immediately: prefill takes seconds before the first
    // token callback ever fires, and the whole reasoning phase is suppressed.
    setStage(STAGE_THINKING, 'thinking');
    const assistantId = msgId();
    setMessages(prev => [
      ...prev,
      { id: msgId(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '', streaming: true },
    ]);
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages(prev => prev.map(m => (m.id === assistantId ? fn(m) : m)));
    // The app owns this turn's answer: drop whatever prose already streamed
    // and switch to final-only speech, so no provisional model sentence can
    // outrun the structured rows. Idempotent — a turn may arm it twice.
    const enterCardTurn = () => {
      if (sawCardTool) {
        return;
      }
      sawCardTool = true;
      sawText = false;
      feed = new SentenceFeed();
      queuedAny = false;
      speaker.stop();
      patch(m => ({ ...m, text: '' }));
    };
    try {
      const result = await session.chat(text, {
        onToken: visible => {
          // Structured-card prose is provisional until it is checked against
          // app-owned rows. Keep it out of the bubble and TTS; the guarded final
          // arrives below. Ordinary document turns retain live streaming.
          if (sawCardTool) {
            return;
          }
          if (!sawText && visible.trim().length > 0) {
            sawText = true;
            setStage(null, 'first-visible-text');
          }
          patch(m => ({ ...m, text: m.text + visible }));
          if (speechOn) {
            for (const sentence of feed.push(visible)) {
              const speech = toMarkdownlessSpeech(sentence);
              if (speech.length > 0) {
                speaker.speakQueued(assistantId, speech);
                queuedAny = true;
              }
            }
          }
        },
        // Thinking phases keep whichever stage the turn is in: round 1 is
        // "thinking…", any post-tool thinking belongs to "reading what I
        // found…". The line only clears when visible text arrives.
        onThinking: thinking => {
          if (thinking && !sawText) {
            setStage(
              sawTool ? STAGE_READING : STAGE_THINKING,
              sawTool ? 'reading' : 'thinking',
            );
          }
        },
        onToolCall: (name, forced) => {
          sawTool = true;
          // `forced` = the app supplied this call because the model answered
          // without one (the deterministic pre-routes). Whatever it already
          // streamed was written before any lookup — exactly the fabricated
          // sentence the floor exists to kill — so it must not survive in the
          // bubble or escape through TTS.
          if (forced || name === 'search_events' || name === 'lookup_history') {
            enterCardTurn();
          }
          setStage(stageForTool(name), `tool:${name}`);
        },
        // Tool executed (local, instant); the long tail after this is the
        // round-2 prefill of the results + the second think.
        onToolDone: (name, cards, sources) => {
          // GROUNDING FIRST (the presence rule): the passages are
          // known the instant retrieval lands, seconds before the prose that
          // rests on them. Show them now — the chips stay collapsed, so this
          // costs the reader nothing and proves the Angel actually looked.
          if (sources.length > 0) {
            found = mergeSourceRefs([...found, ...sources]);
            patch(m => ({ ...m, sources: found }));
          }
          // lookup_facts answers most questions in prose and only SOMETIMES
          // owns the answer (a person card). Which one it was is knowable
          // here and not at onToolCall, so the card-turn contract is armed
          // late — otherwise the model's provisional prose, including the
          // false IDK this card path exists to kill, still escapes through
          // TTS while the bubble ends up correct.
          if (cards.length > 0) {
            enterCardTurn();
          }
          setStage(STAGE_READING, `reading (after ${name})`);
        },
      });
      if (sawCardTool) {
        setStage(null, 'final-visible-text');
      }
      patch(m => ({
        ...m,
        // Final prose may under- or over-shoot the stream; cards come only from
        // structured tool results and are rendered by the app.
        text: result.text,
        cards: result.cards,
        sources: result.sources,
        answeredFrom: result.answeredFrom,
        streaming: false,
      }));
      // Close out the stream, then speak app-owned cards in their fixed shape.
      // Card-producing turns use final-only speech so provisional model dates,
      // counts, relationships, or event denials can never escape through TTS.
      if (speechOn) {
        if (sawCardTool) {
          const speech = speechForAssistantMessage(result.text, result.cards);
          if (speech.length > 0) {
            speaker.speak(assistantId, speech);
          }
        } else {
          const rest = toMarkdownlessSpeech(feed.flush());
          if (rest.length > 0) {
            speaker.speakQueued(assistantId, rest);
            queuedAny = true;
          }
          if (queuedAny) {
            const cardSpeech = speechForAssistantMessage('', result.cards);
            if (cardSpeech.length > 0) {
              speaker.speakQueued(assistantId, cardSpeech);
            }
          } else {
            const speech = speechForAssistantMessage(result.text, result.cards);
            if (speech.length > 0) {
              speaker.speakQueued(assistantId, speech);
            }
          }
        }
      }
    } catch (e: any) {
      // Raw native/model exceptions are diagnostics, not conversation: they
      // go to the console; the bubble keeps its voice (public-QA P2).
      console.warn('[chat] generation failed:', e?.message ?? e);
      patch(m => ({
        ...m,
        text: 'Something broke in the dust — ask me again.',
        streaming: false,
      }));
    } finally {
      setActivity(null);
      setBusy(false);
    }
  }, [input, busy, session, speaker]);

  const switchPersona = useCallback(
    async (id: string) => {
      if (busy || id === personaId) {
        return;
      }
      speaker.stop();
      setPersonaId(id);
      setMessages([]);
      await session.setPersona(id, onStatus);
    },
    [busy, personaId, session, onStatus, speaker],
  );

  const onSpeakToggle = useCallback(
    (message: ChatMessage) => {
      if (speaker.speakingId === message.id) {
        speaker.stop();
        return;
      }
      speaker.speak(
        message.id,
        speechForAssistantMessage(message.text, message.cards),
      );
    },
    [speaker],
  );

  // "Don't use this" -- long-press on a person card, an event card, or a
  // source passage. One handler; the target says what kind it is and
  // events/db.hideItem does the right hide (a graph-node exclusion for a
  // person, a filter row for a passage or event). Nothing is deleted; the
  // dialog already told the user the undo lives in Settings > Hidden.
  // Cards already on screen keep rendering -- they are the pack's own words,
  // still true -- the thing just stops surfacing in NEW answers.
  const onHide = useCallback((t: HideTarget) => {
    try {
      hideItem(t);
    } catch (e: any) {
      Alert.alert("Couldn't do that", e?.message ?? String(e));
    }
  }, []);

  const personaLabel = PERSONAS.find(p => p.id === personaId)?.label ?? 'Angel';

  const newConversation = useCallback(async () => {
    if (busy || messages.length === 0) {
      return;
    }
    // "Clear" says what happens; the confirm says where it goes. The owner
    // hit the unlabeled version cold ("horrible UX", 2026-08-19): a destroy
    // affordance must name its consequence and its recovery story.
    Alert.alert('Clear this chat?', 'The Angel forgets this conversation. It stays in your on-device field log (Settings).', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Clear chat',
        style: 'destructive',
        onPress: () => {
          speaker.stop();
          setMessages([]);
          session.newConversation(onStatus).catch(() => {});
        },
      },
    ]);
  }, [busy, messages.length, session, onStatus, speaker]);

  // Keyboard insets are handled at the App root (useKeyboardInset): the
  // whole layout rises above the IME. KeyboardAvoidingView could not do this
  // under RN 0.87 Android edge-to-edge (device-verified: zero padding).
  return (
    <View style={styles.container}>
      {PERSONAS.length > 1 && (
        <View style={styles.personaRow}>
          {PERSONAS.map(p => (
            <Pressable
              key={p.id}
              onPress={() => switchPersona(p.id)}
              style={[styles.personaChip, personaId === p.id && styles.personaActive]}>
              <Text
                style={[
                  styles.personaText,
                  personaId === p.id && styles.personaTextActive,
                ]}>
                {p.label}
                {p.ready ? '' : ' (soon)'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <ModelStatusBar status={status} onPickModel={onPickModel} />
      {knowledgePacks.length > 0 ? (
        <View style={styles.knowledgeRow}>
          <Text style={styles.knowledgeLabel}>Offline knowledge</Text>
          {knowledgePacks.map(pack => (
            <View key={pack.id} style={styles.knowledgeChip}>
              <Text style={styles.knowledgeChipText}>{pack.name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {messages.length > 0 && !busy && (
        <Pressable onPress={newConversation} style={styles.newChatBtn}>
          <Text style={styles.newChatText}>✨ Clear chat</Text>
        </Pressable>
      )}
      <FlatList
        ref={listRef}
        style={styles.list}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            onSpeakToggle={onSpeakToggle}
            speaking={speaker.speakingId === item.id}
            onHide={onHide}
          />
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={styles.empty}>{knowledgeEmptyState(packs)}</Text>
        }
      />
      {activity ? (
        <PulsingLabel
          label={activity.label}
          period={activity.period}
          drift={activity.drift}
          style={styles.activity}
        />
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder={
            status.state === 'ready'
              ? `Ask the ${personaLabel}…`
              : `The ${personaLabel} is asleep — load a model above`
          }
          placeholderTextColor={colors.faded}
          value={input}
          onChangeText={setInput}
          editable={status.state === 'ready' && !busy}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
        />
        <Pressable
          style={[
            styles.send,
            (busy || status.state !== 'ready') && styles.sendDisabled,
          ]}
          onPress={send}
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={busy || status.state !== 'ready'}>
          <Text style={styles.sendText}>{busy ? '…' : '➤'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  personaRow: { flexDirection: 'row', marginBottom: spacing.sm },
  personaChip: {
    backgroundColor: colors.sand,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  personaActive: { backgroundColor: colors.plum, borderColor: colors.plum },
  personaText: { color: colors.night, fontSize: type.small },
  personaTextActive: { color: colors.cream, fontWeight: '700' },
  knowledgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  knowledgeLabel: {
    color: colors.faded,
    fontSize: type.tiny,
    marginRight: spacing.xs,
  },
  knowledgeChip: {
    backgroundColor: colors.haze,
    borderRadius: radius.chip,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    maxWidth: '100%',
  },
  knowledgeChipText: {
    color: colors.faded,
    fontSize: type.tiny,
  },
  newChatBtn: { alignSelf: 'flex-end', paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  newChatText: { color: colors.faded, fontSize: type.small },
  list: { flex: 1 },
  empty: {
    color: colors.faded,
    fontSize: type.body,
    textAlign: 'center',
    marginTop: spacing.xl * 2,
  },
  activity: {
    color: colors.gold,
    fontSize: type.small,
    fontStyle: 'italic',
    marginVertical: spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingVertical: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.night,
    fontSize: type.body,
    maxHeight: 120,
  },
  send: {
    backgroundColor: colors.clay,
    borderRadius: radius.chip,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  sendDisabled: { backgroundColor: colors.haze },
  sendText: { color: colors.cream, fontSize: 18, fontWeight: '700' },
});
