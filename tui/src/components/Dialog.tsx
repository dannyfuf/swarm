/**
 * Dialog component - a centered modal with title, message, and confirm/cancel.
 *
 * Handles its own keyboard: Enter to confirm, Esc to cancel.
 * Uses theme colors and styled key badges for actions.
 */

import { useKeyboard } from "@opentui/react"
import { useRef } from "react"
import { borders, colors, spacing } from "../theme.js"

interface DialogProps {
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  cancelLabel?: string
}

export function Dialog({
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
}: DialogProps) {
  const confirmedRef = useRef(false)

  useKeyboard((key) => {
    if (confirmedRef.current) return
    if (key.name === "enter" || key.name === "return") {
      confirmedRef.current = true
      onConfirm()
    } else if (key.name === "escape") {
      onCancel()
    }
  })

  const isDestructive = confirmLabel === "Delete"
  const confirmColor = isDestructive ? colors.error : colors.success

  return (
    <box
      justifyContent="center"
      alignItems="center"
      width="100%"
      height="100%"
      backgroundColor={colors.bg}
    >
      <box
        border
        borderStyle={borders.dialog}
        borderColor={colors.borderFocused}
        width={spacing.dialogWidth}
        flexDirection="column"
        paddingX={spacing.dialogPaddingX}
        paddingY={spacing.dialogPaddingY}
      >
        <text>
          <span fg={colors.accent}>
            <strong>{title}</strong>
          </span>
        </text>
        <box marginTop={1}>
          <text>
            <span fg={colors.textPrimary}>{message}</span>
          </text>
        </box>
        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text>
            <span fg={colors.accent} bg={colors.bgHighlight}>
              {" Esc "}
            </span>
            <span fg={colors.textSecondary}>{` ${cancelLabel}`}</span>
          </text>
          <text>
            <span fg={confirmColor} bg={colors.bgHighlight}>
              {" Enter "}
            </span>
            <span fg={confirmColor}>{` ${confirmLabel}`}</span>
          </text>
        </box>
      </box>
    </box>
  )
}
