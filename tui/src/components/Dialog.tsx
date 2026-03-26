/**
 * Dialog component - a centered modal with title, message, and confirm/cancel.
 *
 * Handles its own keyboard: Enter to confirm, Esc to cancel.
 */

import { useKeyboard } from "@opentui/react"
import { useRef } from "react"

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

  return (
    <box
      justifyContent="center"
      alignItems="center"
      width="100%"
      height="100%"
      backgroundColor="#000000"
    >
      <box
        border
        borderStyle="rounded"
        borderColor="#6366F1"
        width={50}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg="#6366F1">
            <strong>{title}</strong>
          </span>
        </text>
        <box marginTop={1}>
          <text>{message}</text>
        </box>
        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text fg="#888888">[Esc] {cancelLabel}</text>
          <text fg="#00FF00">[Enter] {confirmLabel}</text>
        </box>
      </box>
    </box>
  )
}
