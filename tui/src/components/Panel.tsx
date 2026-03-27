/**
 * Panel component - a bordered container with a title embedded in the border.
 *
 * Uses the `<box title>` prop for space-efficient title rendering.
 * Highlights border color and adds subtle background when focused.
 */

import type { ReactNode } from "react"
import { memo } from "react"
import { borders, colors, spacing } from "../theme.js"

interface PanelProps {
  title: string
  focused: boolean
  children: ReactNode
}

export const Panel = memo(function Panel({ title, focused, children }: PanelProps) {
  return (
    <box
      border
      borderStyle={borders.panel}
      borderColor={focused ? colors.borderFocused : colors.borderDefault}
      backgroundColor={focused ? colors.bgSurface : undefined}
      title={`  ${title}  `}
      titleAlignment="left"
      flexGrow={1}
      flexDirection="column"
      paddingX={spacing.panelPaddingX}
    >
      {children}
    </box>
  )
})
