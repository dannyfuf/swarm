/**
 * Hook to access app state and dispatch from the AppContext.
 *
 * Returns the full state and dispatch function for firing actions.
 */

import { useContext } from "react"
import { AppContext } from "../state/AppContext.js"
import type { AppAction } from "../state/actions.js"
import type { AppState } from "../state/appReducer.js"

interface UseAppState {
  state: AppState
  dispatch: React.Dispatch<AppAction>
}

export function useAppState(): UseAppState {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error("useAppState must be used within an AppProvider")
  }
  return { state: ctx.state, dispatch: ctx.dispatch }
}
