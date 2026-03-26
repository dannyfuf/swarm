/**
 * Badge component - renders a single status badge with color.
 */

import type { Badge as BadgeType } from "../types/status.js"

interface BadgeProps {
  badge: BadgeType
}

export function Badge({ badge }: BadgeProps) {
  return <span fg={badge.color}>{badge.symbol}</span>
}
