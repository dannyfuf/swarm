/**
 * Passive overlay that shows concurrent long-running activities.
 */

import type { ActiveOperation } from "../types/activity.js"
import { Spinner, useSpinnerFrame } from "./Spinner.js"

const MAX_VISIBLE_ACTIVITIES = 3
const MAX_LABEL_LENGTH = 44

interface ActivityOverlayProps {
  activities: ActiveOperation[]
}

export function ActivityOverlay({ activities }: ActivityOverlayProps) {
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
          borderStyle="rounded"
          borderColor="#6366F1"
          paddingX={1}
          flexDirection="row"
          gap={1}
        >
          <Spinner frame={frame} />
          <text>{truncateActivityLabel(activity.label)}</text>
        </box>
      ))}
      {hiddenCount > 0 ? (
        <box border borderStyle="rounded" borderColor="#4B5563" paddingX={1}>
          <text fg="#888888">
            +{hiddenCount} more task{hiddenCount === 1 ? "" : "s"}
          </text>
        </box>
      ) : null}
    </box>
  )
}

function truncateActivityLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) {
    return label
  }

  return `${label.slice(0, MAX_LABEL_LENGTH - 3)}...`
}
