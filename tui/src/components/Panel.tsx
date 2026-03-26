/**
 * Panel component - a bordered container with a title.
 *
 * Highlights border color when focused (blue vs gray).
 */

import type { ReactNode } from "react"

interface PanelProps {
  title: string
  focused: boolean
  children: ReactNode
}

export function Panel({ title, focused, children }: PanelProps) {
  const borderColor = focused ? "#4455FF" : "#555555"
  const titleColor = "#6366F1"

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      flexGrow={1}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={titleColor}>
          <strong>{title}</strong>
        </span>
      </text>
      <box flexGrow={1} flexDirection="column" marginTop={1}>
        {children}
      </box>
    </box>
  )
}
