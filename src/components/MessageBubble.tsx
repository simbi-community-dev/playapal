/**
 * Chat message bubble. Assistant messages may carry app-owned structured cards
 * below the prose — cards render from DB rows, never from the prose — then the
 * tappable source chips for whatever passages the answer stood on, and a
 * speaker button (present regardless of the auto-speak toggle).
 *
 * Order is deliberate: the answer, then what it is built on, then the sources
 * it came from. Provenance sits UNDER the cards because a card is already the
 * pack's own words; the chip is the door behind them.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import type { ChatMessage } from '../types';
import type { OnHide } from './dontUseThis';
import { colors, radius, spacing, type } from '../theme';
import { EventCard } from './EventCard';
import { FactCard } from './FactCard';
import { PulsingLabel } from './PulsingLabel';
import { SourceChips } from './SourceChips';

interface Props {
  message: ChatMessage;
  /** Toggle spoken playback of this message (assistant messages only). */
  onSpeakToggle?: (message: ChatMessage) => void;
  /** True while THIS message is being spoken. */
  speaking?: boolean;
  /** "Don't use this": long-press on a person card, an event card, or a
   * source passage. Threaded to each; a bubble rendered without it shows
   * the cards without the affordance. */
  onHide?: OnHide;
}

export function MessageBubble({
  message,
  onSpeakToggle,
  speaking,
  onHide,
}: Props) {
  const isUser = message.role === 'user';
  const speakable =
    !isUser && !message.streaming && message.text.length > 0 && onSpeakToggle;
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
        {message.text.length > 0 ? (
          <Text style={isUser ? styles.userText : styles.assistantText}>
            {message.text}
            {message.streaming ? ' ▍' : ''}
          </Text>
        ) : message.streaming ? (
          // Nothing visible yet (prefill or suppressed reasoning): pulse
          // quietly instead of sitting frozen.
          <PulsingLabel label="…" style={styles.assistantText} />
        ) : null}
        {message.cards && message.cards.length > 0 ? (
          <View style={styles.cards}>
            {message.cards.map((card, index) =>
              card.kind === 'event' ? (
                <EventCard key={`event:${card.event.id}`} event={card.event} onHide={onHide} />
              ) : (
                <FactCard
                  key={`fact:${card.kind}:${index}`}
                  fact={card}
                  onHide={onHide}
                />
              ),
            )}
          </View>
        ) : null}
        {!isUser && message.sources && message.sources.length > 0 ? (
          <SourceChips sources={message.sources} onHide={onHide} />
        ) : null}
        {!isUser && !message.streaming && message.answeredFrom === 'memory' ? (
          // The Ranger says which one it used. A looked-up answer shows its
          // passages above; an answer from memory says so, quietly, so a
          // stale-weights slip is never mistaken for something in your packs.
          <Text style={styles.memoryNote}>From memory, not your packs — could be wrong. Verify anything important.</Text>
        ) : null}
        {speakable ? (
          <Pressable
            style={styles.speakBtn}
            hitSlop={8}
            onPress={() => onSpeakToggle(message)}
            accessibilityLabel={speaking ? 'Stop speaking' : 'Speak this reply'}>
            <Text style={styles.speakIcon}>{speaking ? '⏹' : '🔊'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  memoryNote: {
    color: colors.faded,
    fontSize: type.tiny,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },
  row: { flexDirection: 'row', marginVertical: spacing.xs },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '88%',
    borderRadius: radius.bubble,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  user: {
    backgroundColor: colors.clay,
    borderBottomRightRadius: 4,
  },
  assistant: {
    backgroundColor: colors.sand,
    borderBottomLeftRadius: 4,
  },
  userText: { color: colors.onAccent, fontSize: type.body },
  assistantText: { color: colors.night, fontSize: type.body },
  cards: { marginTop: spacing.sm },
  speakBtn: { alignSelf: 'flex-end', marginTop: spacing.xs },
  speakIcon: { fontSize: type.body, color: colors.faded },
});
