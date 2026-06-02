import React from "react";

/**
 * Wrap the first case-insensitive occurrence of `query` in `text` with a
 * `<mark>`. Returns the text unchanged when `query` is empty or not found.
 * `markClassName` styles the `<mark>` — each surface passes its own CSS-module
 * class so the highlight matches local theming.
 */
export function highlightMatch(
  text: string,
  query: string,
  markClassName?: string,
): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={markClassName}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
