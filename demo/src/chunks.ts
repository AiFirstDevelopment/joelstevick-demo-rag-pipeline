// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * A page's text, cut into the pieces the demo retrieves.
 *
 * The shape of Howard's Lantern's worker/src/code-chunks.ts: about
 * CHUNK_CHARS a piece, cut at a sentence end where one is near, else at a
 * space. A piece never crosses a page, so every source names one page, and
 * every piece is a verbatim slice of that page's text, so "Show the passage"
 * shows the words as they were extracted.
 */

/** Roughly a paragraph: long enough for a whole point, short enough that five are a page. */
export const CHUNK_CHARS = 900

/** `text` cut into pieces of at most CHUNK_CHARS, in reading order; a blank page gives none. */
export function chunkPage(text: string): string[] {
  const pieces: string[] = []
  let rest = text.trim()
  // Cut pieces off the front of `rest` until what is left fits; that remainder is the last piece.
  while (rest.length > CHUNK_CHARS) {
    const window = rest.slice(0, CHUNK_CHARS)
    // The page sends each line of the PDF on its own line, so a sentence can end in ".\n" as well as ". ".
    const sentence = Math.max(...['. ', '? ', '! ', '.\n', '?\n', '!\n'].map((end) => window.lastIndexOf(end)))
    // The fallback: the last space in the window, so a word is not split in two.
    const space = window.lastIndexOf(' ')
    // Cut after the last sentence end if it is past the halfway mark (so no piece is a stub), else at the last space, else mid-word at the limit.
    const cut = sentence > CHUNK_CHARS / 2 ? sentence + 1 : space > 0 ? space : CHUNK_CHARS
    // The piece goes out trimmed, and the rest starts after the cut, its leading space or line break dropped.
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  // What is left fits in one piece; nothing is left only when the page was blank.
  if (rest.length > 0) pieces.push(rest)
  return pieces
}
