/**
 * GGUF model file management: document-picker import or a well-known
 * "bundled" path for dev (adb push / Finder drop).
 */

import { pick, keepLocalCopy } from '@react-native-documents/picker';
import { DocumentDirectoryPath, exists } from '@dr.pogodin/react-native-fs';
import { getSetting, setSetting } from '../events/db';

/**
 * Dev fast-path: drop a model here and it loads without any picking.
 *   Android: adb push model.gguf /data/user/0/<pkg>/files/model.gguf
 *   iOS: Finder -> device -> app's Documents (enable UIFileSharingEnabled)
 */
export const DEV_MODEL_PATH = `${DocumentDirectoryPath}/model.gguf`;

const SETTING_KEY = 'model_path';

/** Best known model path: previously imported, else the dev path, else null.
 *
 * PATH HEALING (owner field report 2026-08-19): iOS regenerates the app
 * container UUID on every reinstall/upgrade and MIGRATES Documents into it —
 * the file survives, but an absolute saved path points at the dead
 * container, so exists() fails and the app re-downloaded a model it already
 * had, every reinstall. The cure: when the saved absolute path is gone, look
 * for the SAME FILENAME under the CURRENT documents dir, heal the setting,
 * and carry on. Android paths are stable, so this is a no-op there. */
export async function findModel(): Promise<string | null> {
  const saved = getSetting(SETTING_KEY);
  if (saved && (await exists(saved))) {
    return saved;
  }
  if (saved) {
    const base = saved.split('/').pop();
    if (base) {
      const healed = `${DocumentDirectoryPath}/${base}`;
      if (healed !== saved && (await exists(healed))) {
        setSetting(SETTING_KEY, healed);
        return healed;
      }
    }
  }
  if (await exists(DEV_MODEL_PATH)) {
    return DEV_MODEL_PATH;
  }
  return null;
}

/**
 * Let the user pick a .gguf; copy it into app documents (llama.rn needs a
 * real file path, not a content:// URI). Returns null on cancel.
 */
export async function pickModel(): Promise<string | null> {
  let picked;
  try {
    // GGUF has no registered MIME type — allow all files.
    picked = await pick({ mode: 'import' });
  } catch (e: any) {
    if (e?.code === 'OPERATION_CANCELED') {
      return null;
    }
    throw e;
  }
  const file = picked[0];
  if (!file) {
    return null;
  }
  if (file.name && !file.name.toLowerCase().endsWith('.gguf')) {
    throw new Error("That file isn't a model — it needs to end in .gguf.");
  }
  const [copy] = await keepLocalCopy({
    files: [{ uri: file.uri, fileName: file.name ?? 'model.gguf' }],
    destination: 'documentDirectory',
  });
  if (copy.status !== 'success') {
    throw new Error(`Could not import model: ${copy.copyError}`);
  }
  const path = copy.localUri.replace(/^file:\/\//, '');
  setSetting(SETTING_KEY, path);
  return path;
}
