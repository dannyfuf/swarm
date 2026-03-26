/**
 * Hook to access service instances from the AppContext.
 */

import { useContext } from "react"
import { AppContext, type Services } from "../state/AppContext.js"

export function useServices(): Services {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error("useServices must be used within an AppProvider")
  }
  return ctx.services
}
