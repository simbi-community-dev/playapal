/**
 * ONE TEXT SANITISER FOR USER-TYPED INPUT.
 *
 * campBoard.ts, campNotes.ts and friendCard.ts each carried this, byte for
 * byte. It matters that they agreed: the same string is written by one path
 * and read by another, and a sanitiser that differed between them would let
 * text through one door that the next door strips -- a note that beams fine
 * and arrives altered, or a name that saves and then fails its own validator.
 *
 * THEY WERE NEARLY SIGNED AS THREE DIFFERENT FUNCTIONS. The duplicate detector
 * that should have caught them could not read a CONCISE ARROW body -- it had
 * no braces to balance, so the scan ran past the end of the function and
 * compared each copy together with whatever code happened to follow it in that
 * file. Three identical functions looked like three different ones, and the
 * ledger entry pardoning them was one commit from being permanent.
 */

/**
 * Strip control characters, collapse runs of whitespace, trim the ends.
 *
 * Controls are removed rather than rejected because they arrive from ordinary
 * paste, not from malice -- and separators in particular make the canonical
 * camp-board rows ambiguous, which is a correctness problem before it is a
 * safety one.
 */
export const cleanText = (raw: string): string =>
  // eslint-disable-next-line no-control-regex -- stripping controls IS the point
  raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
