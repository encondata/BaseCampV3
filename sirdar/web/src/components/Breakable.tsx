/** A URL, email or other long token with line-break opportunities at
 *  sensible points, so a narrow card wraps it as `http://` / `npm.lab` /
 *  `.example.com` rather than mid-word. The CSS still sets
 *  `overflow-wrap: anywhere` as the fallback for a piece that alone is too
 *  long for the line. */
import { Fragment } from 'react';

/** Splits after a run of slashes and before `.`, `@`, `?`, `#`, `&` or a
 *  `:` that isn't the scheme's `://`. Joining the pieces gives `text` back. */
export function breakPoints(text: string): string[] {
  return text.split(/(?<=\/)(?!\/)|(?<=.)(?=[.@?#&]|:(?!\/))/);
}

export default function Breakable({ text }: { text: string }) {
  const pieces = breakPoints(text);
  return (
    <>
      {pieces.map((p, i) => (
        // Index keys: the pieces of one string never reorder.
        <Fragment key={i}>{i > 0 && <wbr />}{p}</Fragment>
      ))}
    </>
  );
}
