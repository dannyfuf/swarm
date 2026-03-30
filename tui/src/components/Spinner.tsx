/**
 * Reusable Braille-dot spinner primitives for activity overlays.
 *
 * Uses a single shared interval via `useSpinnerFrame` hook.
 */

import { memo, useEffect, useState } from "react"
import { colors, spinnerFrames, spinnerIntervalMs } from "../theme.js"

interface SpinnerProps {
  frame: string
}

export const Spinner = memo(function Spinner({ frame }: SpinnerProps) {
  return <text fg={colors.accent}>{frame}</text>
})

export function useSpinnerFrame(): string {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setFrameIndex((current) => (current + 1) % spinnerFrames.length)
    }, spinnerIntervalMs)

    return () => {
      globalThis.clearInterval(intervalId)
    }
  }, [])

  return spinnerFrames[frameIndex] ?? spinnerFrames[0]
}
