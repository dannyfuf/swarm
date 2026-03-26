/**
 * DetailView component - shows full details for the selected worktree.
 *
 * Displays branch, slug, path, repo, status badges, and timestamps.
 */

import type { ContainerConfigSummary, ContainerRuntimeStatus } from "../types/container.js"
import type { Status } from "../types/status.js"
import { getBadges } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"

interface DetailViewProps {
  worktree: Worktree | null
  status: Status | undefined
  containerStatus: ContainerRuntimeStatus | undefined
  containerConfigSummary: ContainerConfigSummary | null
  activeOperationLabel?: string | null
}

function formatDate(date: Date): string {
  return date.toLocaleString()
}

export function DetailView({
  worktree,
  status,
  containerStatus,
  containerConfigSummary,
  activeOperationLabel,
}: DetailViewProps) {
  if (!worktree) {
    return (
      <text fg="#888888">
        <em>Select a worktree to view details</em>
      </text>
    )
  }

  const badges = status ? getBadges(status) : []
  const badgeStr =
    badges.length > 0 ? badges.map((b) => `${b.symbol} ${b.hint}`).join("  ") : "none"
  const configStateLabel = containerConfigSummary
    ? formatConfigState(containerConfigSummary)
    : "loading"
  const configPath =
    containerConfigSummary?.resolvedPath ?? containerConfigSummary?.path ?? "loading"

  return (
    <box flexDirection="column" gap={1}>
      <text>
        <span fg="#6366F1">
          <strong>Branch:</strong>
        </span>{" "}
        {worktree.branch}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Slug:</strong>
        </span>{" "}
        {worktree.slug}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Path:</strong>
        </span>{" "}
        {worktree.path}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Repo:</strong>
        </span>{" "}
        {worktree.repoName}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Session:</strong>
        </span>{" "}
        {worktree.tmuxSession}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Status:</strong>
        </span>{" "}
        {badgeStr}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Config:</strong>
        </span>{" "}
        {configStateLabel}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Config Path:</strong>
        </span>{" "}
        {configPath}
      </text>
      {containerConfigSummary?.preset && (
        <text>
          <span fg="#6366F1">
            <strong>Preset:</strong>
          </span>{" "}
          {containerConfigSummary.preset}
        </text>
      )}
      {containerConfigSummary?.state === "invalid" && (
        <text fg="#FFFF00">
          <strong>Config Error:</strong> {containerConfigSummary.error}
        </text>
      )}
      {activeOperationLabel ? (
        <text fg="#FFFF00">
          <strong>Operation:</strong> {activeOperationLabel}
        </text>
      ) : null}
      <text fg="#888888">Hint: press y to copy config path</text>
      <text>
        <span fg="#6366F1">
          <strong>Container:</strong>
        </span>{" "}
        {containerStatus?.state ?? "not-configured"}
      </text>
      {worktree.container && (
        <>
          <text>
            <span fg="#6366F1">
              <strong>URL:</strong>
            </span>{" "}
            {containerStatus?.primaryUrl ??
              `http://127.0.0.1:${worktree.container.primaryHostPort}`}
          </text>
          <text>
            <span fg="#6366F1">
              <strong>Health:</strong>
            </span>{" "}
            {containerStatus?.health ?? "unknown"}
          </text>
          <text>
            <span fg="#6366F1">
              <strong>Container Name:</strong>
            </span>{" "}
            {worktree.container.containerName}
          </text>
          <text>
            <span fg="#6366F1">
              <strong>Network:</strong>
            </span>{" "}
            {worktree.container.networkName}
          </text>
          <text>
            <span fg="#6366F1">
              <strong>Images:</strong>
            </span>{" "}
            {worktree.container.baseImageTag} / {worktree.container.dependencyImageTag}
          </text>
          <text>
            <span fg="#6366F1">
              <strong>Fingerprint:</strong>
            </span>{" "}
            {worktree.container.dependencyFingerprint}
          </text>
          {containerStatus?.warning && (
            <text fg="#FFFF00">
              <strong>Warning:</strong> {containerStatus.warning}
            </text>
          )}
        </>
      )}
      {worktree.isOrphaned && (
        <text fg="#FF0000">
          <strong>ORPHANED</strong>
        </text>
      )}
      <text>
        <span fg="#6366F1">
          <strong>Created:</strong>
        </span>{" "}
        {formatDate(worktree.createdAt)}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Last Opened:</strong>
        </span>{" "}
        {formatDate(worktree.lastOpenedAt)}
      </text>
    </box>
  )
}

function formatConfigState(summary: ContainerConfigSummary): string {
  switch (summary.state) {
    case "missing":
      return "missing"
    case "present":
      return "present"
    case "invalid":
      return "invalid"
  }
}
