/**
 * Model-load status strip: idle (pick a model), loading/warming progress,
 * ready, or error.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import type { ModelStatus } from '../types';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  status: ModelStatus;
  onPickModel: () => void;
}

export function ModelStatusBar({ status, onPickModel }: Props) {
  if (status.state === 'ready') {
    return (
      <View style={styles.bar}>
        <View style={[styles.dot, { backgroundColor: colors.sage }]} />
        <Text style={styles.text} numberOfLines={1}>
          {status.detail ?? status.modelName}
        </Text>
        <Pressable
          accessibilityLabel="Choose replacement model"
          style={styles.button}
          onPress={onPickModel}
        >
          <Text style={styles.buttonText}>Change…</Text>
        </Pressable>
      </View>
    );
  }
  if (status.state === 'loading' || status.state === 'copying') {
    return (
      <View style={styles.bar}>
        <View style={[styles.dot, { backgroundColor: colors.gold }]} />
        <Text style={styles.text} numberOfLines={1}>
          {status.detail}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.bar}>
      <View
        style={[
          styles.dot,
          { backgroundColor: status.state === 'error' ? colors.clay : colors.haze },
        ]}
      />
      <Text style={styles.text} numberOfLines={1}>
        {status.state === 'error' ? status.detail : 'No model yet'}
      </Text>
      <Pressable style={styles.button} onPress={onPickModel}>
        <Text style={styles.buttonText}>Choose model…</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
  },
  text: { flex: 1, color: colors.faded, fontSize: type.small },
  button: {
    backgroundColor: colors.clay,
    borderRadius: radius.chip,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginLeft: spacing.sm,
  },
  buttonText: { color: colors.onAccent, fontSize: type.small, fontWeight: '700' },
});
