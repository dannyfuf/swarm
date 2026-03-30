/**
 * InputDialog component - a modal with a text input field.
 *
 * Used for branch name input when creating a new worktree.
 * Handles its own keyboard: Enter to submit, Esc to cancel.
 */

import { useKeyboard } from "@opentui/react"
import { useCallback, useRef, useState } from "react"
import { borders, colors, spacing } from "../theme.js"

interface InputDialogProps {
  title: string
  placeholder: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ title, placeholder, onSubmit, onCancel }: InputDialogProps) {
  const [value, setValue] = useState("")
  const submittedRef = useRef(false)

  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return
    const trimmed = value.trim()
    if (trimmed) {
      submittedRef.current = true
      onSubmit(trimmed)
    }
  }, [value, onSubmit])

  useKeyboard((key) => {
    if (submittedRef.current) return
    if (key.name === "enter" || key.name === "return") {
      handleSubmit()
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
          <input
            value={value}
            onChange={setValue}
            placeholder={placeholder}
            focused
            width={spacing.dialogWidth - spacing.dialogPaddingX * 2 - 2}
            backgroundColor={colors.bgSurface}
            textColor={colors.textPrimary}
            focusedBackgroundColor={colors.bgOverlay}
          />
        </box>
        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text>
            <span fg={colors.accent} bg={colors.bgHighlight}>
              {" Esc "}
            </span>
            <span fg={colors.textSecondary}>{" Cancel"}</span>
          </text>
          <text>
            <span fg={colors.success} bg={colors.bgHighlight}>
              {" Enter "}
            </span>
            <span fg={colors.success}>{" Create"}</span>
          </text>
        </box>
      </box>
    </box>
  )
}
