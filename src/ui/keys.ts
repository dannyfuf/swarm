import type { KeyEvent as CoreKeyEvent } from "@opentui/core";
import type { KeyEvent } from "../core/app.ts";

/**
 * OpenTUI reports letters with a lowercase `name` plus a `shift` flag and the
 * literal character in `sequence`; the app-level `KeyEvent` in core/app.ts is
 * the smaller shape the keymap resolves against.
 */
export function toKeyEvent(event: CoreKeyEvent): KeyEvent {
  return {
    name: event.name,
    ctrl: Boolean(event.ctrl),
    shift: Boolean(event.shift),
    meta: Boolean(event.meta),
    sequence: event.sequence ?? "",
  };
}

export function isEscape(event: KeyEvent): boolean {
  return event.name === "escape" || event.name === "esc";
}

export function isEnter(event: KeyEvent): boolean {
  return event.name === "return" || event.name === "enter" || event.name === "kpenter";
}

export function isTab(event: KeyEvent): boolean {
  return event.name === "tab";
}

export function isSpace(event: KeyEvent): boolean {
  return event.name === "space";
}

/** Down in a list: `j` is only a motion when no text field owns the keyboard. */
export function isListDown(event: KeyEvent, textFieldFocused: boolean): boolean {
  if (event.name === "down") return true;
  if (event.ctrl && event.name === "n") return true;
  return !textFieldFocused && !event.ctrl && event.name === "j";
}

export function isListUp(event: KeyEvent, textFieldFocused: boolean): boolean {
  if (event.name === "up") return true;
  if (event.ctrl && event.name === "p") return true;
  return !textFieldFocused && !event.ctrl && event.name === "k";
}

export function isQuitKey(event: KeyEvent): boolean {
  return event.ctrl && event.name === "c";
}
