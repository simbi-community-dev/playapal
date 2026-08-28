# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Please do not open a public issue for
anything security-sensitive.

What counts as sensitive here, beyond the usual: anything touching the camp
board's beam/import path (untrusted pack ingestion), the model-download
digest verification, the on-device chat/query logs, or any of the
radio-facing parsers listed under *Scope notes*.

## When you report — or file any issue

**Never attach** chat logs, question logs, camp-board beams, passphrases, or
device captures that show them. They can contain private camp data and other
people's names. Reproduce with synthetic data where you can.

## Scope notes

- Playa Pal runs offline by design; its network surface is limited to the
  one-time model download (digest-verified) and whatever your OS speech
  engine does. Reports about those boundaries are especially welcome.
- Packs imported from files or beams are untrusted input and are validated
  on install (`src/packs/installPack.ts`); bypasses of that validation are
  in scope.
- **Anything a nearby stranger's radio can reach is untrusted input**, and
  since 0.8.2 there is more of it. In scope, in the order we would want to
  hear about them:
  - the **`PW` frame parser**, which now decodes frames arriving over three
    transports — LAN/hotspot UDP, a Wi-Fi Aware datapath, and BLE GATT
    writes — through one receive path per platform. The pod gate, the
    sender identity, the sequence discipline and the drop-an-unknown-codec
    rule are the security properties; a frame that reaches an audio track
    or a decoder without passing them is a finding.
  - the **BLE GATT server**: it accepts connections and writes from any
    device that can reach it, and admits a peer only after an identity read
    naming the same pod. Anything that gets past that gate, or that a
    malformed write can do to the service, is in scope.
  - the **call-signalling path** (`callSignal.ts`): chunked, reassembled and
    deduped SDP/ICE arriving from a peer. A ring the user did not consent
    to, a reassembly that can be driven out of bounds, or media that starts
    before the callee accepts, are all findings. Media itself is WebRTC
    with an empty ICE server list on purpose — a configuration that would
    route a call through any relay is a finding in itself.
  - the **QR photo decoder** (`src/links/qrPhoto.ts`, jpeg-js + jsQR): an
    arbitrary image chosen by the user, decoded in-process, whose output is
    handed to the app's single URL handler. Both the image parsers and the
    step where decoded text becomes an action are in scope; a scanned pod
    invite that joins without asking would be one.
- **Not** in scope, because they are documented properties rather than
  defects: a pod code is four digits and a captured beacon yields it; camp
  beams are integrity-checked with a shared passphrase and are not
  encrypted; friend-card share scope ("just for them") is honored by the
  receiving app and is not enforced by cryptography. Each is stated in the
  README and in the app. A way to make any of them *worse* than documented
  is very much in scope.

## Known dependency-audit residual

`npm audit` reports high-severity nodes that all root in two `image-size`
infinite-loop DoS advisories, reached through the Metro bundler chain.
`image-size` runs only during static asset inspection at build time, on the
developer's machine, and is absent from the shipped mobile runtime;
exploitation requires a malicious ICNS/JXL/HEIF payload placed in the source
asset tree, which normal in-app content never reaches. No patched upstream
release existed as of 2026-08-19. **Do not run `npm audit fix --force`** —
its proposed React Native downgrade is a destructive false fix. Review
untrusted binary assets before adding them to the tree, and reassess this
note at every dependency upgrade.

(The advisory count is deliberately not written down here: it moves with
every lockfile change, and a stale number reads as a fresh measurement.)

