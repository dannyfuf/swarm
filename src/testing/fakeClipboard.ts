import type { Clipboard } from "../core/ports.ts";

export type FakeClipboard = Clipboard & {
  copies: string[];
};

export function createFakeClipboard(): FakeClipboard {
  const copies: string[] = [];
  return {
    copies,
    async copy(text) {
      copies.push(text);
    },
  };
}
