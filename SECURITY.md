# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Please do not open a public issue for
anything security-sensitive.

What counts as sensitive here, beyond the usual: anything touching the camp
board's beam/import path (untrusted pack ingestion), the model-download
digest verification, or the on-device chat/query logs.

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

## Known audit posture

`npm audit` currently reports high-severity findings that all root in
`image-size` via the Metro bundler chain — build-time tooling that processes
this repository's own assets on the developer machine and does not ship in
the app or parse user input at runtime. They are queued for the next React
Native/Metro upgrade rather than a forced major bump. Reassess this note at
every dependency upgrade.

## Known dependency-audit residual

`npm audit` reports 11 high-severity dependency nodes, all transitively
derived from two `image-size` infinite-loop DoS advisories. `image-size@1.2.1`
is used only by Metro during static asset inspection at build time and is
absent from the shipped mobile runtime. Exploitation requires a malicious
ICNS/JXL/HEIF payload in the source asset tree; normal in-app content never
reaches it. No patched upstream release exists as of 2026-08-19; do not apply
`npm audit fix --force` — its proposed React Native downgrade is a destructive
false fix. Review untrusted binary assets before adding them to the tree.

