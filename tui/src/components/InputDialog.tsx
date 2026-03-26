/**
 * InputDialog component - a modal with a text input field.
 *
 * Used for branch name input when creating a new worktree.
 * Handles its own keyboard: Enter to submit, Esc to cancel.
 */

import { useKeyboard } from "@opentui/react"
import { useCallback, useState } from "react"

interface InputDialogProps {
  title: string
  placeholder: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ title, placeholder, onSubmit, onCancel }: InputDialogProps) {
  const [value, setValue] = useState("")

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim()
    if (trimmed) {
      onSubmit(trimmed)
    }
  }, [value, onSubmit])

  useKeyboard((key) => {
    if (key.name === "enter" || key.name === "return") {
      handleSubmit()
    } else if (key.name === "escape") {
      onCancel()
    }
  })

  return (
    <box justifyContent="center" alignItems="center" width="100%" height="100%">
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
          <input
            value={value}
            onChange={setValue}
            placeholder={placeholder}
            focused
            width={44}
            backgroundColor="#1a1a2e"
            textColor="#FFFFFF"
            focusedBackgroundColor="#2a2a4e"
          />
        </box>
        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text fg="#888888">[Esc] Cancel</text>
          <text fg="#00FF00">[Enter] Create</text>
        </box>
      </box>
    </box>
  )
}
