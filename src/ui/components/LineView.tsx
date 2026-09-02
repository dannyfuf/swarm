import { TextAttributes } from "@opentui/core";
import type { Cell, Line } from "../text.ts";

function attributesOf(part: Cell): number {
  let attributes = 0;
  if (part.bold) attributes |= TextAttributes.BOLD;
  if (part.dim) attributes |= TextAttributes.DIM;
  if (part.italic) attributes |= TextAttributes.ITALIC;
  if (part.underline) attributes |= TextAttributes.UNDERLINE;
  return attributes;
}

/**
 * Render one composed line. Every screen row is a single `text` renderable with
 * one `span` per styled run, which keeps the renderable count proportional to
 * the terminal height rather than to the number of worktrees.
 */
export function LineView({ line }: { line: Line }) {
  return (
    <text wrapMode="none">
      {line
        .filter((part) => part.text.length > 0)
        .map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional by nature
          <span key={index} fg={part.fg} bg={part.bg} attributes={attributesOf(part)}>
            {part.text}
          </span>
        ))}
    </text>
  );
}

export function LinesView({ lines }: { lines: Line[] }) {
  return (
    <>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional by nature
        <LineView key={index} line={line} />
      ))}
    </>
  );
}
