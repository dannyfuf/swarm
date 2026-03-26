/**
 * Helpers for tracking long-running UI activities in reducer state.
 */

import type { AppAction } from "../state/actions.js"
import type { ActiveOperation, ActivityDraft } from "../types/activity.js"

interface CreateActivityTrackerOptions {
  dispatch: (action: AppAction) => void
  createId?: () => string
  now?: () => Date
}

export function createActivityTracker({
  dispatch,
  createId = createActivityId,
  now = () => new Date(),
}: CreateActivityTrackerOptions) {
  return async function trackActivity<TResult>(
    activity: ActivityDraft,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const activeOperation: ActiveOperation = {
      ...activity,
      id: createId(),
      startedAt: now(),
    }

    dispatch({ type: "BEGIN_ACTIVITY", activity: activeOperation })

    await yieldToRenderer()

    try {
      return await operation()
    } finally {
      dispatch({ type: "END_ACTIVITY", id: activeOperation.id })
    }
  }
}

function createActivityId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Yield control to the event loop so React can process pending state
 * updates and the OpenTUI renderer can flush changes to the terminal.
 *
 * Uses setTimeout(0) rather than queueMicrotask because microtasks
 * run before the event loop processes I/O and timer callbacks,
 * which means React's commit phase (which uses MessageChannel or
 * setTimeout internally) may not have run yet.
 */
function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
