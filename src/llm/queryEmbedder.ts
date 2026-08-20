/**
 * THE DEVICE QUERY EMBEDDER — the semantic arm's production half.
 *
 * Pairs with the PRECOMPUTED half in the pack build: corpus vectors ship
 * inside the pack (embeddings.json) and the phone embeds QUERIES ONLY,
 * because building the index on-device is the one genuinely thermal workload
 * in the whole app — a hot phone in a hot desert with no shade is the
 * failure this asymmetry exists to avoid.
 *
 * Design, each point load-bearing:
 *
 * - LAZY, NEVER AT BOOT: the second llama.rn context (bge-small, ~35MB)
 *   initializes on the FIRST semantic search, not app start — a user who
 *   never triggers the arm never pays the load, and boot latency (already
 *   ~35s persona warm-up) is untouched.
 * - FAIL-SOFT BY CONSTRUCTION: any load/embed failure leaves the embedder
 *   NULL, so searchDocsSemantic degrades to the keyword ladder exactly as
 *   if the arm were absent — chat is never blocked on the embedder.
 * - THE SAME-MODEL GUARD: the query context must produce vectors the
 *   pack's precomputed ones can be compared against — same GGUF family,
 *   same dim, and the same EMBEDDER_MODEL_ID stamp the installer verified
 *   at pack install. A model that reports a different nEmbd never gets
 *   wired (the arm stays inert rather than silently wrong).
 * - FILE LOCATION mirrors modelFile.ts: a well-known dev path
 *   (files/embedder.gguf — adb push / Finder drop) beside model.gguf.
 */

import type { LlamaContext } from 'llama.rn';
import { setQueryEmbedder, VECTOR_DIM } from '../docs/vectorSearch';

// BOTH native modules (llama.rn, react-native-fs) are required lazily — a
// top-level import of either drags un-transformable ESM into every Jest
// suite that merely imports the retrieval chain (lookupFacts → here). Types
// stay static; modules load only on a real device load attempt.
function requireInitLlama(): typeof import('llama.rn').initLlama {
  // Same ESM-interop shape as requireFs below (cert round-2 lesson).
  const m = require('llama.rn');
  return (m && m.initLlama !== undefined ? m : (m.default ?? m)).initLlama;
}

function requireFs(): typeof import('@dr.pogodin/react-native-fs') {
  // ESM-interop safe (certification round-2 lesson, docs/29 13:20Z): under
  // Metro, this package's named exports can land behind .default when
  // reached via require(), so the bare require(...).DocumentDirectoryPath
  // shape returns UNDEFINED on device while the static-import form works —
  // and the fail-soft layer would hide it ('undefined/embedder.gguf',
  // exists() false, arm inert, no error anywhere). Resolve the namespace
  // or its .default, whichever actually carries the named export. Do NOT
  // simplify this back to bare require() — the repo paid for that bug once.
  const m = require('@dr.pogodin/react-native-fs');
  return m && m.DocumentDirectoryPath !== undefined ? m : (m.default ?? m);
}

// The path is computed INSIDE the load function — evaluating it at module
// scope would call requireFs() at import time and re-break the laziness.
function devEmbedderPath(): string {
  return `${requireFs().DocumentDirectoryPath}/embedder.gguf`;
}

async function embedderFileExists(): Promise<boolean> {
  return requireFs().exists(devEmbedderPath());
}

/** Dev fast-path (same pattern as model.gguf).
 *   Android: adb push embedder.gguf /data/user/0/<pkg>/files/embedder.gguf
 *   iOS: Finder -> device -> app's Documents. Exported as a getter so the
 *   fs module is only touched on a real load attempt. */
export function embedderPath(): string {
  return devEmbedderPath();
}

let embedderContext: LlamaContext | null = null;
let loadPromise: Promise<void> | null = null;

async function loadEmbedder(): Promise<void> {
  try {
    if (!(await embedderFileExists())) {
      // No embedder file on device — the arm is simply absent. Not an
      // error: keyword-only is the designed degrade.
      return;
    }
    const ctx = await requireInitLlama()({
      model: devEmbedderPath(),
      // Short query strings only — a tiny context is correct and cheap.
      n_ctx: 512,
      n_threads: 2,
      n_gpu_layers: 0, // CPU: a 22M-param forward is milliseconds
      use_mlock: false, // the LLM's mlock matters; the embedder can page
      embedding: true,
    } as any);
    // The dim guard: a wrong GGUF (different nEmbd) must never be wired —
    // its vectors would be incomparable to the pack's 384-dim ones.
    const nEmbd = (ctx as any)?.model?.nEmbd;
    if (typeof nEmbd === 'number' && nEmbd !== VECTOR_DIM) {
      console.warn(
        `[queryEmbedder] embedder nEmbd ${nEmbd} != ${VECTOR_DIM} — arm inert`,
      );
      embedderContext = null;
      return;
    }
    embedderContext = ctx;
    setQueryEmbedder(async (text: string) => {
      try {
        const res = await embedderContext!.embedding(text);
        return res.embedding as number[];
      } catch (e) {
        console.warn('[queryEmbedder] embed failed, keyword-only:', e);
        return null; // fail-soft: this query degrades, the arm stays loaded
      }
    });
  } catch (e) {
    embedderContext = null;
    console.warn('[queryEmbedder] load failed, keyword-only:', e);
  }
}

/**
 * Ensure the query embedder is wired (idempotent). Called lazily from the
 * semantic search path; safe to call on every search — the first call
 * loads, later calls return the in-flight or settled promise.
 */
export function ensureQueryEmbedder(): Promise<void> {
  if (!loadPromise) {
    loadPromise = loadEmbedder();
  }
  return loadPromise;
}

/** Test hook: reset the lazy singleton so suites can re-drive load paths. */
export function __resetQueryEmbedderForTests(): void {
  embedderContext = null;
  loadPromise = null;
  setQueryEmbedder(null);
}
