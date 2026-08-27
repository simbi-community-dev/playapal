#!/usr/bin/env python3
"""Build embeddings.json for a data pack — the semantic arm's PRECOMPUTED
half (RAG-ARCHITECTURE-RESEARCH §3.1: corpus vectors computed at pack build
time on the desktop; the phone embeds QUERIES ONLY).

Runs against a BUILT pack folder (pack.json + *.md) — embeds every chunk
produced by the same line-faithful chunker port the app installs with, so
the "<source_file>:<idx>" keys the installer verifies are exact by
construction. Model: bge-small-en-v1.5 (384-dim, ~33MB Q8 — the confirmed
pick; the app's vec0 table + EMBEDDER_MODEL_ID stamp match it).

Compute path: llama-server --embeddings on your build machine, one
/embedding call per chunk (batched). The server is started by this script
if not already up, against a bge-small-en-v1.5 GGUF.

Usage:
  build_embeddings.py --pack /path/to/pack-folder --gguf /path/to/bge.gguf
                      [--server http://127.0.0.1:8090] [--out embeddings.json]

Output: <pack>/embeddings.json
  { "model": "bge-small-en-v1.5-q8", "dim": 384,
    "vectors": { "<source_file>:<chunk_idx>": [float, ... 384] } }

Vectors are L2-normalized (server-side --embd-normalize 2) — cosine then
equals dot product, and sqlite-vec's vec_distance_cosine matches.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

MODEL_ID = "bge-small-en-v1.5-q8"
DIM = 384

# --- the chunker: imported from the pack doctor (tools/check_pack.py), the
# --- repository's verified-parity port of the app's src/packs/chunker.ts —
# --- exact JS semantics (UTF-16 units, ECMAScript whitespace, CRLF,
# --- overlong-bullet splitting). One implementation, no drift (gpt handoff
# --- 2026-08-19: case-insensitive .md/.txt + exact JS chunking).

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_pack as _doctor

DEFAULT_MAX_CHARS = _doctor.DEFAULT_MAX_CHARS

RESERVED = {"pack.json", "nodes.json", "edges.json", "embeddings.json", "flags.json"}


def doc_files(pack_dir):
    """The doc sources the installer will chunk, as (source_name, text).

    TWO SHAPES, because BUILT packs ship two ways (measured 2026-08-24: this
    tool silently produced ZERO vectors for the art and camps packs — it only
    looked for raw .md, and those packs ship .md.json wrappers; the raw .md
    files are gitignored build intermediates that do not exist in a clone):
      - raw .md/.txt on disk (imported packs, the lore packs)
      - {"file": "<name>.md", "markdown": "..."} wrappers (.md.json), which
        Metro can bundle and src/packs/builtins.ts installs under the
        wrapper's OWN `file` name

    The embedding KEY must be the name the installer uses — the wrapper's
    `file`, never the wrapper's own filename — or every key is stale and
    installPack.ts refuses the pack ("stale vector build"). Deterministic
    lowercased-name order; reserved manifests skipped.
    """
    out = []
    for path in sorted(pathlib.Path(pack_dir).iterdir(), key=lambda p: p.name.lower()):
        if not path.is_file() or path.name.lower() in RESERVED:
            continue
        lower = path.name.lower()
        if lower.endswith(".md.json"):
            wrapper = json.loads(path.read_text(encoding="utf-8"))
            name = wrapper.get("file")
            markdown = wrapper.get("markdown")
            if not isinstance(name, str) or not isinstance(markdown, str):
                raise SystemExit(
                    f"{path.name}: not a {{file, markdown}} pack wrapper")
            out.append((name, markdown))
            continue
        suffix = lower.rsplit(".", 1)[-1] if "." in lower else ""
        if suffix in {"md", "txt"}:
            out.append((path.name, _doctor.read_text(path)))
    return out


def pack_chunks(pack_dir, max_chars=DEFAULT_MAX_CHARS):
    """Every chunk the app will install, keyed "<source_file>:<idx>" in the
    installer's own per-source ordinal order.

    REFUSES an empty result: a pack folder that yields no chunks means the
    reader missed the pack's shape, and writing an empty embeddings.json
    silently ships a pack with a dead semantic arm (exactly what happened
    before the .md.json shape was handled).
    """
    out = {}
    for name, text in doc_files(pack_dir):
        per_source_idx = 0
        for heading, content in _doctor.chunk_document(text, max_chars):
            out[f"{name}:{per_source_idx}"] = {"heading": heading, "content": content}
            per_source_idx += 1
    if not out:
        raise SystemExit(
            f"{pack_dir}: no doc chunks found (.md/.txt or .md.json wrappers) "
            "— refusing to write an empty embeddings.json")
    return out


def embed_batch(server, texts):
    body = json.dumps({"content": texts}).encode()
    req = urllib.request.Request(
        server + "/embedding", data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.loads(r.read())
    # llama-server returns a list aligned with the input batch; each item
    # carries {"embedding": [[...384...]]} (nested once for single input).
    vectors = []
    for item in out:
        emb = item["embedding"]
        vectors.append(emb[0] if emb and isinstance(emb[0], list) else emb)
    return vectors


# llama-server (b10411) HTTP 500s on any input OVER ~510 tokens instead of
# truncating (measured 2026-08-15: "word "*511 fails; the pack's real
# 506-521-token chunks fail — MANY, not 1-in-4000, because email prose
# tokenizes dense). A vector computed on a TRUNCATED chunk would be
# silently wrong against the full text the phone excerpts at query time,
# so the honest move is to split at a TOKEN-SAFE boundary (~1500 chars ≈
# 400 tokens worst-case for dense prose) and MEAN-POOL the sub-embeddings
# — the standard long-document recipe (the same mean-pooling the model
# uses internally).
def embed_long(server, text, max_chars_per_pass=1500):
    def split(t, cap):
        parts = []
        rest = t
        while rest:
            if len(rest) <= cap:
                parts.append(rest)
                break
            cut = rest.rfind(" ", 0, cap + 1)
            at = cut if cut > cap / 2 else cap
            parts.append(rest[:at].strip())
            rest = rest[at:].strip()
        return parts

    # Dense prose (short words, few spaces) can exceed the ~510-token server
    # window even at 1500 chars (measured: a 603-token 1497-char part in
    # lore-2010.md:150). Tokenize-probe each part and halve until it fits —
    # the server's own /tokenize is the only honest measure of its window.
    def safe_parts(t):
        out = []
        for p in split(t, max_chars_per_pass):
            while True:
                body = json.dumps({"content": p}).encode()
                req = urllib.request.Request(
                    server + "/tokenize", data=body,
                    headers={"Content-Type": "application/json"})
                n = len(json.loads(urllib.request.urlopen(req, timeout=60)
                                  .read())["tokens"])
                if n <= 500:
                    out.append(p)
                    break
                half = len(p) // 2
                cut = p.rfind(" ", 0, half + 1)
                at = cut if cut > half / 2 else half
                rest = p[at:].strip()
                out.append(p[:at].strip())
                p = rest
        return [x for x in out if x]

    parts = safe_parts(text)
    if len(parts) == 1:
        return embed_batch(server, [text])[0]
    embs = embed_batch(server, parts)
    n = len(embs[0])
    return [sum(e[i] for e in embs) / len(embs) for i in range(n)]


def ensure_server(server, gguf, llama_server_bin):
    try:
        with urllib.request.urlopen(server + "/health", timeout=3) as r:
            if r.status == 200:
                return None
    except Exception:
        pass
    if not gguf:
        raise SystemExit(
            f"no embedding server at {server} and no --gguf given to start one")
    proc = subprocess.Popen(
        [llama_server_bin, "--model", gguf, "--embeddings",
         "--embd-normalize", "2", "--port", server.rsplit(":", 1)[1],
         "--host", "127.0.0.1", "-c", "2048", "-ngl", "0"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(120):
        try:
            with urllib.request.urlopen(server + "/health", timeout=2) as r:
                if r.status == 200:
                    return proc
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"embedding server failed to come up on {server}")


def embed_pack(pack_dir, server, out_path=None, batch=4,
               max_chars=DEFAULT_MAX_CHARS, log=lambda m: print(m, file=sys.stderr)):
    """Library entry (used by build_camp_lore_pack.py --embeddings-server):
    embed every chunk of a built pack folder and write embeddings.json.
    Returns the output path."""
    pack_dir = pathlib.Path(pack_dir)
    chunks = pack_chunks(pack_dir, max_chars)
    log(f"embedding {len(chunks)} chunks via {server} ...")
    keys = sorted(chunks.keys())
    vectors = {}
    t0 = time.time()
    for i in range(0, len(keys), batch):
        batch_keys = keys[i:i + batch]
        try:
            embs = embed_batch(server, [chunks[k]["content"] for k in batch_keys])
        except urllib.error.HTTPError:
            # A >~510-token chunk 500s the whole batch (server window bug,
            # MANY dense-prose chunks); re-drive this batch per-chunk
            # through the mean-pool path.
            embs = []
            for k in batch_keys:
                try:
                    embs.append(embed_batch(server, [chunks[k]["content"]])[0])
                except urllib.error.HTTPError:
                    embs.append(embed_long(server, chunks[k]["content"]))
        if len(embs) != len(batch_keys):
            raise SystemExit(
                f"server returned {len(embs)} vectors for {len(batch_keys)} "
                f"chunks (batch at {i}) — refusing a mis-keyed file")
        for k, v in zip(batch_keys, embs):
            if len(v) != DIM:
                raise SystemExit(
                    f"{k}: expected dim {DIM}, got {len(v)} — wrong model?")
            vectors[k] = [round(x, 6) for x in v]
        if (i // batch) % 25 == 0:
            log(f"  {i + len(batch_keys)}/{len(keys)} ({time.time() - t0:.0f}s)")
    out = pathlib.Path(out_path) if out_path else pack_dir / "embeddings.json"
    payload = {"model": MODEL_ID, "dim": DIM, "vectors": vectors}
    out.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    log(f"wrote {out} — {len(vectors)} vectors, "
        f"{out.stat().st_size / 1e6:.1f}MB, {time.time() - t0:.0f}s")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True, help="built pack folder")
    ap.add_argument("--gguf", help="bge-small-en-v1.5 GGUF (starts server)")
    ap.add_argument("--server", default="http://127.0.0.1:8090")
    ap.add_argument("--llama-server", default="llama-server")
    ap.add_argument("--out", help="output path (default <pack>/embeddings.json)")
    ap.add_argument("--batch", type=int, default=4,
                    help="chunks per /embedding call; 2000-char chunks ≈ "
                         "500 tokens each and llama-server's default 4 "
                         "embedding slots cap a larger batch with HTTP 500")
    ap.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    args = ap.parse_args()

    pack_dir = pathlib.Path(args.pack)
    if not (pack_dir / "pack.json").exists():
        raise SystemExit(f"{pack_dir} has no pack.json — build the pack first")

    chunks = pack_chunks(pack_dir, args.max_chars)
    print(f"embedding {len(chunks)} chunks via {args.server} ...", file=sys.stderr)
    proc = ensure_server(args.server, args.gguf, args.llama_server)
    if proc:
        print(f"started llama-server (pid {proc.pid})", file=sys.stderr)

    keys = sorted(chunks.keys())
    embed_pack(pack_dir, args.server,
               out_path=args.out, batch=args.batch, max_chars=args.max_chars)
    if proc:
        proc.terminate()


if __name__ == "__main__":
    main()
