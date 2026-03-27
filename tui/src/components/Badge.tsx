/**
 * Badge component - renders a single status badge with color.
 *
 * Used in DetailView for rich colored badge rendering.
 */

import { memo } from "react"
import type { Badge as BadgeType } from "../types/status.js"

interface BadgeProps {
  badge: BadgeType
}

export const Badge = memo(function Badge({ badge }: BadgeProps) {
  return <span fg={badge.color}>{badge.symbol}</span>
})
