import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { LinesView } from "../components/LineView.tsx";
import type { Line } from "../text.ts";
import { cell } from "../text.ts";
import { glyphs, theme } from "../theme.ts";

export interface HintSpec {
  key: string;
  label: string;
}

export function hintLine(hints: HintSpec[]): Line {
  const line: Line = [];
  hints.forEach((hint, index) => {
    if (index > 0) line.push(cell("   ", {}));
    line.push(cell(hint.key, { fg: theme.accent, bold: true }));
    line.push(cell(` ${hint.label}`, { fg: theme.dim }));
  });
  return line;
}

export function dialogWidth(terminalWidth: number, preferred: number): number {
  return Math.max(28, Math.min(preferred, terminalWidth - 8));
}

/**
 * Content width inside a dialog of the given preferred width, so list rows can
 * be fitted exactly instead of spilling past the border on a small terminal.
 */
export function useDialogInnerWidth(preferred: number): number {
  const { width } = useTerminalDimensions();
  return Math.max(16, dialogWidth(width, preferred) - 4);
}

/**
 * Centered, bordered surface. The base screen behind it is repainted in a
 * single flat shade so it reads as background rather than as competing content.
 */
export function DialogFrame({
  title,
  danger = false,
  width: preferredWidth = 74,
  hints,
  children,
}: {
  title: string;
  danger?: boolean;
  width?: number;
  hints: HintSpec[];
  children: ReactNode;
}) {
  const { width, height } = useTerminalDimensions();
  const inner = dialogWidth(width, preferredWidth);
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
      zIndex={100}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={danger ? theme.red : theme.dialogBorder}
        backgroundColor={theme.dialogBg}
        title={` ${title} `}
        titleColor={danger ? theme.red : theme.dialogTitle}
        titleAlignment="left"
        width={inner}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        {children}
        <box height={1} />
        <LinesView lines={[hintLine(hints)]} />
      </box>
    </box>
  );
}

export function FieldLabel({ text, focused }: { text: string; focused: boolean }) {
  return (
    <text wrapMode="none">
      <span fg={focused ? theme.accent : theme.dim} attributes={focused ? TextAttributes.BOLD : 0}>
        {focused ? `${glyphs.cursor} ${text}` : `  ${text}`}
      </span>
    </text>
  );
}

export function TextField({
  value,
  placeholder,
  focused,
  onInput,
}: {
  value: string;
  placeholder?: string;
  focused: boolean;
  onInput: (value: string) => void;
}) {
  return (
    <box
      height={1}
      paddingLeft={2}
      paddingRight={1}
      backgroundColor={focused ? theme.inputBg : theme.dialogBg}
    >
      <input
        flexGrow={1}
        focused={focused}
        value={value}
        placeholder={placeholder ?? ""}
        onInput={onInput}
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor={focused ? theme.inputFg : theme.muted}
        focusedTextColor={theme.inputFg}
        placeholderColor={theme.ghost}
        cursorColor={theme.accent}
      />
    </box>
  );
}

export function Spacer() {
  return <box height={1} />;
}

export function SectionLabel({ text }: { text: string }) {
  return (
    <text wrapMode="none">
      <span fg={theme.dim} attributes={TextAttributes.BOLD}>
        {text}
      </span>
    </text>
  );
}
