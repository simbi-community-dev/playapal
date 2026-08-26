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
import { Dimensions, Keyboard, Platform } from 'react-native';

export function useKeyboardInset(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    // Measure the IME as WINDOW BOTTOM minus endCoordinates.screenY (the
    // IME's top edge in screen coordinates). endCoordinates.height proved
    // untrustworthy on Android edge-to-edge: the risen input still sat one
    // gesture-bar short of the keyboard (Pixel 7, 2026-08-19, measured via
    // uiautomator bounds) because height and the safe-area inset disagree
    // about whether the gesture region belongs to the keyboard. screenY is
    // an absolute coordinate, so no inset arithmetic can double-count.
    const offsetFrom = (e: { endCoordinates?: { screenY?: number } }) => {
      const screenY = e.endCoordinates?.screenY;
      if (screenY == null) {
        return;
      }
      setKb(Math.max(0, Dimensions.get('window').height - screenY));
    };
    const show = Keyboard.addListener(showEvt, offsetFrom);
    const change = Keyboard.addListener('keyboardDidChangeFrame', offsetFrom);
    const hide = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => {
      show.remove();
      change.remove();
      hide.remove();
    };
  }, []);
  // Raw distance from the window bottom to the IME top; 0 when closed.
  // Consumers combine it with the safe-area inset as
  // Math.max(insets.bottom, inset) — never by adding the two.
  return kb;
}
