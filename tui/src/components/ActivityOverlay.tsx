/**
 * Passive overlay that shows concurrent long-running activities.
 *
 * Displays up to 3 activity cards with Braille-dot spinners,
 * styled with theme colors. Positioned top-right as floating cards.
 */

import { memo } from "react"
import { borders, colors } from "../theme.js"
import type { ActiveOperation } from "../types/activity.js"
import { Spinner, useSpinnerFrame } from "./Spinner.js"

const MAX_VISIBLE_ACTIVITIES = 3
const MAX_LABEL_LENGTH = 44

interface ActivityOverlayProps {
  activities: ActiveOperation[]
}

export const ActivityOverlay = memo(function ActivityOverlay({ activities }: ActivityOverlayProps) {
  const frame = useSpinnerFrame()

  if (activities.length === 0) {
    return null
  }

  const orderedActivities = [...activities].sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  )
  const visibleActivities = orderedActivities.slice(0, MAX_VISIBLE_ACTIVITIES)
  const hiddenCount = orderedActivities.length - visibleActivities.length

  return (
    <box position="absolute" top={1} right={1} flexDirection="column" alignItems="flex-end" gap={1}>
      {visibleActivities.map((activity) => (
        <box
          key={activity.id}
          border
          borderStyle={borders.activity}
          borderColor={colors.borderDefault}
          backgroundColor={colors.bgSurface}
          paddingX={1}
          flexDirection="row"
          gap={1}
        >
          <Spinner frame={frame} />
          <text>
            <span fg={colors.textSecondary}>{truncateActivityLabel(activity.label)}</span>
          </text>
        </box>
      ))}
      {hiddenCount > 0 ? (
        <box
          border
          borderStyle={borders.activity}
          borderColor={colors.borderMuted}
          backgroundColor={colors.bgSurface}
          paddingX={1}
        >
          <text>
            <span fg={colors.textMuted}>
              +{hiddenCount} more task{hiddenCount === 1 ? "" : "s"}
            </span>
          </text>
        </box>
      ) : null}
    </box>
  )
})

function truncateActivityLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) {
    return label
  }

  return `${label.slice(0, MAX_LABEL_LENGTH - 3)}...`
}
