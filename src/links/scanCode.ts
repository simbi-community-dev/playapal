/**
 * "Scan their code" — the camera half of the in-app scanner.
 *
 * The whole flow in one place, because it is used from two surfaces (the
 * friend card's share row and the pod's swap/invite panel) and the sentence
 * a camper reads when it fails is the feature: a scan that quietly does
 * nothing, in front of a person waiting, is indistinguishable from a broken
 * phone.
 *
 * REUSED, NOT ADDED: `react-native-image-picker` already ships and already
 * carries the CAMERA permission on both platforms (AddNoteSheet photographs
 * art with it). The decode is pure JS in qrPhoto.ts, and the result goes to
 * the app's ONE URL handler through incoming.ts — no second importer, no
 * second consent ask.
 */

import { Alert, PermissionsAndroid, Platform } from 'react-native';
import {
  launchCamera,
  type ImagePickerResponse,
} from 'react-native-image-picker';
import { decodeQrFromJpegBase64 } from './qrPhoto';
import { deliverIncomingUrl } from './incoming';

/**
 * What the scan did. `delivered` means the URL reached the handler, which
 * then owns everything a camper sees about it; every other arm has already
 * been said out loud by the time this returns.
 */
export type ScanResult =
  | 'delivered'
  | 'cancelled'
  | 'no-permission'
  | 'camera-failed'
  | 'unreadable'
  | 'not-ours';

/**
 * The picker request. 1280 px is generous for a code filling half the frame
 * (a screen-sized QR is then ~10 px per module) and keeps the pure-JS decode
 * to about a megapixel. `compatible` forces a JPEG re-encode at the source —
 * iOS otherwise hands over HEIC, which jpeg-js cannot read (the same quirk
 * AddNoteSheet measured on image-picker 8.2.1).
 */
const CAMERA_OPTS = {
  mediaType: 'photo' as const,
  maxWidth: 1280,
  maxHeight: 1280,
  quality: 1 as const,
  includeBase64: true,
  saveToPhotos: false,
  selectionLimit: 1,
  assetRepresentationMode: 'compatible' as const,
  presentationStyle: 'fullScreen' as const,
  cameraType: 'back' as const,
};

/**
 * Take one photo of a code and act on it.
 *
 * `silent` is for callers that want the outcome without the alerts (nothing
 * uses it yet in app code; the suites do, and it keeps the copy testable
 * without a mocked Alert).
 */
export async function scanCodeAndDeliver(silent = false): Promise<ScanResult> {
  const say = (title: string, body: string) => {
    if (!silent) {
      Alert.alert(title, body);
    }
  };
  if (Platform.OS === 'android') {
    // Declaring CAMERA in the manifest makes the runtime grant MANDATORY
    // before launchCamera — image-picker refuses outright otherwise
    // (AddNoteSheet's measured note, same door).
    let granted = false;
    try {
      const got = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
        {
          title: 'Scan their code',
          message:
            "Playa Pal reads the QR code on your friend's screen. The picture is read on this phone and never saved or sent.",
          buttonPositive: 'OK',
          buttonNegative: 'Not now',
        },
      );
      granted = got === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      granted = false;
    }
    if (!granted) {
      say(
        'No camera permission',
        "Playa Pal can't open the camera. You can still scan their code with your normal camera app — Playa Pal opens when you tap the result.",
      );
      return 'no-permission';
    }
  }
  let res: ImagePickerResponse;
  try {
    res = await launchCamera(CAMERA_OPTS);
  } catch (e: any) {
    say('Could not open the camera', e?.message ?? String(e));
    return 'camera-failed';
  }
  if (res.didCancel) {
    return 'cancelled';
  }
  if (res.errorCode) {
    say(
      'Could not open the camera',
      res.errorMessage ?? String(res.errorCode),
    );
    return 'camera-failed';
  }
  const b64 = res.assets?.[0]?.base64 ?? '';
  if (b64.length === 0) {
    say(
      'That picture did not come through',
      'Try the shot again — or scan their code with your normal camera app.',
    );
    return 'camera-failed';
  }
  const text = decodeQrFromJpegBase64(b64);
  if (text === null) {
    // Every unreadable frame gets ONE sentence, and it is the sentence that
    // fixes the next attempt: the two things a camper controls are how much
    // of the frame the code fills and how still the phone is.
    say(
      "Couldn't read that code",
      'Fill the frame with their code, hold still, and try again. Their screen brightness helps in the dust.',
    );
    return 'unreadable';
  }
  if (!deliverIncomingUrl(text)) {
    say(
      'Not a Playa Pal code',
      'That code is something else — a ticket, a poster, a Wi-Fi code. Ask them for "Show QR" under their card.',
    );
    return 'not-ours';
  }
  return 'delivered';
}
