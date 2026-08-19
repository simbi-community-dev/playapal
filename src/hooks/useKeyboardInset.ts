/**
 * Deterministic keyboard inset. RN 0.87 runs Android edge-to-edge, where the
 * window never resizes for the IME (adjustResize is inert) and
 * KeyboardAvoidingView's overlap math works in parent-relative layout coords
 * against window-relative keyboard coords — on the Pixel 7 it produced no
 * padding at all and the keyboard covered the input. So: listen to the
 * Keyboard events ourselves and return the exact extra bottom padding the
 * ROOT view needs (keyboard height minus the safe-area inset the root
 * already pads).
 */

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useKeyboardInset(): number {
  const insets = useSafeAreaInsets();
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e =>
      setKb(e.endCoordinates?.height ?? 0),
    );
    const hide = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return Math.max(0, kb - insets.bottom);
}
