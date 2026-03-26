/**
 * Minimal argument parsing for `swarm container ...` commands.
 */

export type ContainerCliAction = "up" | "down" | "build" | "status" | "logs" | "init"

export interface ParsedContainerCliArgs {
  action: ContainerCliAction
}

const VALID_ACTIONS: ReadonlyArray<ContainerCliAction> = [
  "up",
  "down",
  "build",
  "status",
  "logs",
  "init",
]

export function parseContainerCliArgs(args: string[]): ParsedContainerCliArgs {
  const [action] = args

  if (!action || !VALID_ACTIONS.includes(action as ContainerCliAction)) {
    throw new Error(`Unknown container command. Expected one of: ${VALID_ACTIONS.join(", ")}.`)
  }

  return {
    action: action as ContainerCliAction,
  }
}
