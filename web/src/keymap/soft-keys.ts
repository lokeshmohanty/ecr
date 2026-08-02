/**
 * What a soft keyboard sends, as the keys a hardware one would have sent.
 *
 * Android's IME does not report which key was pressed: `keydown` arrives as
 * `Unidentified` and the text itself comes in `beforeinput`. Translating that
 * back into keys means the mode still decides what they mean — `j` moves down
 * in normal mode and types a `j` in insert mode, from Gboard exactly as from a
 * laptop — rather than the editor needing to know a phone exists.
 *
 * Returns the keys to feed the state machine, in order, or nothing for an
 * input type the editor has no key for.
 */
export function softKeys(inputType: string, data: string | null): string[] {
  switch (inputType) {
    case "insertText":
    case "insertCompositionText":
      // A word committed by autocorrect arrives whole; a vim command is one
      // character. Splitting covers both, and by code point rather than by
      // UTF-16 unit so an emoji is not torn in half.
      return [...(data ?? "")];
    case "deleteContentBackward":
      return ["Backspace"];
    case "insertLineBreak":
    case "insertParagraph":
      return ["Enter"];
    default:
      return [];
  }
}
