/**
 * Reusable ASCII spinner primitives for activity overlays.
 */

import { useEffect, useState } from "react"

const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const
const SPINNER_INTERVAL_MS = 80

interface SpinnerProps {
  frame: string
}

export function Spinner({ frame }: SpinnerProps) {
  return <text fg="#6366F1">{frame}</text>
}

export function useSpinnerFrame(): string {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length)
    }, SPINNER_INTERVAL_MS)

    return () => {
      globalThis.clearInterval(intervalId)
    }
  }, [])

  return SPINNER_FRAMES[frameIndex]
}
