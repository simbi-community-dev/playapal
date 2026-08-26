/**
 * useSpeaker — the chat screen's handle on spoken replies. All speech flows
 * through ONE sequential utterance queue, which is what makes STREAMED
 * replies possible: sentences are enqueued as they decode and each one is
 * spoken only after the previous finishes, on any SpeechBackend, with no
 * backend queue support required. Tracks WHICH message is speaking (for the
 * per-message speaker button), speaks with the persisted voice/rate, and
 * guarantees silence on unmount (screen exit), new sends, and stop taps —
 * stop() flushes the whole queue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSpeechBackend } from './backend';
import { loadSpeechSettings } from './settings';

export interface Speaker {
  /** Message id currently being spoken (or queued), or null. */
  speakingId: string | null;
  /** Replace everything with one utterance for a message (🔊 replay). */
  speak: (messageId: string, text: string) => void;
  /** Enqueue one utterance for a message (streamed sentences, event cards).
   * Starting a different message's stream implicitly clears the queue. */
  speakQueued: (messageId: string, text: string) => void;
  /** Silence now: flush the queue and stop the backend. */
  stop: () => void;
}

interface QueueState {
  messageId: string | null;
  texts: string[];
  pumping: boolean;
  /** Bumped by stop()/speak() so an in-flight pump loop retires quietly. */
  generation: number;
}

export function useSpeaker(): Speaker {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const queueRef = useRef<QueueState>({
    messageId: null,
    texts: [],
    pumping: false,
    generation: 0,
  });

  const backendFor = () => {
    const settings = loadSpeechSettings();
    return { backend: getSpeechBackend(settings.backendId), settings };
  };

  const hardStop = useCallback(() => {
    const q = queueRef.current;
    q.texts = [];
    q.messageId = null;
    q.generation += 1;
    backendFor()
      .backend.stop()
      .catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Screen exit: silence, always. Fire-and-forget by design.
      hardStop();
    };
  }, [hardStop]);

  const pump = useCallback(async () => {
    const q = queueRef.current;
    if (q.pumping) {
      return;
    }
    q.pumping = true;
    const generation = q.generation;
    try {
      while (q.generation === generation && q.texts.length > 0) {
        const text = q.texts.shift()!;
        const { backend, settings } = backendFor();
        // One utterance at a time: resolve on finish/stop/error, then loop.
        await new Promise<void>(resolve => {
          backend
            .speak(text, {
              voiceId: settings.voiceId,
              rate: settings.rate,
              onDone: resolve,
            })
            .catch(() => resolve());
        });
      }
    } finally {
      q.pumping = false;
    }
    if (q.texts.length > 0) {
      // A newer generation enqueued while this loop was retiring: hand over.
      pump();
      return;
    }
    if (q.generation === generation && mountedRef.current) {
      q.messageId = null;
      setSpeakingId(null);
    }
  }, []);

  const speakQueued = useCallback(
    (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      const q = queueRef.current;
      if (q.messageId !== messageId) {
        // A different message takes the floor: flush the old queue.
        q.texts = [];
        q.generation += 1;
        q.messageId = messageId;
      }
      q.texts.push(trimmed);
      if (mountedRef.current) {
        setSpeakingId(messageId);
      }
      pump();
    },
    [pump],
  );

  const speak = useCallback(
    (messageId: string, text: string) => {
      hardStop();
      speakQueued(messageId, text);
    },
    [hardStop, speakQueued],
  );

  const stop = useCallback(() => {
    hardStop();
    setSpeakingId(null);
  }, [hardStop]);

  return useMemo(
    () => ({ speakingId, speak, speakQueued, stop }),
    [speakingId, speak, speakQueued, stop],
  );
}
