/**
 * DetailView component - shows full details for the selected worktree.
 *
 * Organized into logical sections: Git Info, Container Info, Timestamps.
 * Uses colored badges for status rendering.
 */

import type { ReactNode } from "react"
import { memo } from "react"
import { colors, spacing } from "../theme.js"
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

function SectionHeader({ label }: { label: string }) {
  return (
    <text>
      <span fg={colors.accent}>
        <strong>{label}</strong>
      </span>
    </text>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <box flexDirection="row">
      <box width={14}>
        <text>
          <span fg={colors.textSecondary}>{label}</span>
        </text>
      </box>
      <box flexGrow={1}>
        {typeof children === "string" ? (
          <text>
            <span fg={colors.textPrimary}>{children}</span>
          </text>
        ) : (
          children
        )}
      </box>
    </box>
  )
}

function formatDate(date: Date): string {
  return date.toLocaleString()
}

function formatConfigState(summary: ContainerConfigSummary): string {
  switch (summary.state) {
    case "missing":
      return "missing"
    case "present":
      return summary.preset ? `present (${summary.preset})` : "present"
    case "invalid":
      return "invalid"
  }
}

function getContainerStateLabel(state: string): { label: string; color: string } {
  switch (state) {
    case "running":
      return { label: "▲ running", color: colors.containerUp }
    case "stopped":
      return { label: "▽ stopped", color: colors.containerDown }
    case "failed":
      return { label: "✗ failed", color: colors.containerFail }
    default:
      return { label: state, color: colors.textSecondary }
  }
}

export const DetailView = memo(function DetailView({
  worktree,
  status,
  containerStatus,
  containerConfigSummary,
  activeOperationLabel,
}: DetailViewProps) {
  if (!worktree) {
    return (
      <text>
        <span fg={colors.textMuted}>
          <em>Select a worktree to view details</em>
        </span>
      </text>
    )
  }

  const badges = status ? getBadges(status) : []
  const configStateLabel = containerConfigSummary
    ? formatConfigState(containerConfigSummary)
    : "loading"
  const configPath =
    containerConfigSummary?.resolvedPath ?? containerConfigSummary?.path ?? "loading"

  return (
    <box flexDirection="column" gap={spacing.sectionGap}>
      {/* Git section */}
      <SectionHeader label="Git" />
      <DetailRow label="Branch">{worktree.branch}</DetailRow>
      <DetailRow label="Slug">{worktree.slug}</DetailRow>
      <DetailRow label="Path">{worktree.path}</DetailRow>
      <DetailRow label="Repo">{worktree.repoName}</DetailRow>
      <DetailRow label="Session">{worktree.tmuxSession}</DetailRow>
      <DetailRow label="Status">
        {badges.length > 0 ? (
          <text>
            {badges.map((b, i) => (
              <span key={b.hint}>
                <span fg={b.color}>{b.symbol}</span>
                <span fg={colors.textSecondary}>{` ${b.hint}`}</span>
                {i < badges.length - 1 ? "  " : ""}
              </span>
            ))}
          </text>
        ) : (
          <text>
            <span fg={colors.textMuted}>none</span>
          </text>
        )}
      </DetailRow>

      {worktree.isOrphaned ? (
        <text>
          <span fg={colors.error}>
            <strong>ORPHANED</strong>
          </span>
        </text>
      ) : null}

      {/* Container section */}
      <SectionHeader label="Container" />
      <DetailRow label="Config">{configStateLabel}</DetailRow>
      <DetailRow label="Config Path">{configPath}</DetailRow>
      {containerConfigSummary?.state === "invalid" ? (
        <text>
          <span fg={colors.warning}>
            <strong>Config Error:</strong> {containerConfigSummary.error}
          </span>
        </text>
      ) : null}

      <DetailRow label="State">
        {containerStatus ? (
          <text>
            <span fg={getContainerStateLabel(containerStatus.state).color}>
              {getContainerStateLabel(containerStatus.state).label}
            </span>
          </text>
        ) : (
          <text>
            <span fg={colors.textMuted}>not-configured</span>
          </text>
        )}
      </DetailRow>

      {worktree.container ? (
        <>
          <DetailRow label="URL">
            {containerStatus?.primaryUrl ??
              `http://127.0.0.1:${worktree.container.primaryHostPort}`}
          </DetailRow>
          <DetailRow label="Health">{containerStatus?.health ?? "unknown"}</DetailRow>
          <DetailRow label="Name">{worktree.container.containerName}</DetailRow>
          <DetailRow label="Network">{worktree.container.networkName}</DetailRow>
          <DetailRow label="Images">
            {`${worktree.container.baseImageTag} / ${worktree.container.dependencyImageTag}`}
          </DetailRow>
          <DetailRow label="Fingerprint">{worktree.container.dependencyFingerprint}</DetailRow>
          {containerStatus?.warning ? (
            <text>
              <span fg={colors.warning}>
                <strong>Warning:</strong> {containerStatus.warning}
              </span>
            </text>
          ) : null}
        </>
      ) : null}

      {activeOperationLabel ? (
        <text>
          <span fg={colors.warning}>
            <strong>Operation:</strong> {activeOperationLabel}
          </span>
        </text>
      ) : null}

      {/* Timestamps section */}
      <SectionHeader label="Timestamps" />
      <DetailRow label="Created">{formatDate(worktree.createdAt)}</DetailRow>
      <DetailRow label="Last Opened">{formatDate(worktree.lastOpenedAt)}</DetailRow>

      {/* Hint line */}
      <box marginTop={1}>
        <text>
          <span fg={colors.accent} bg={colors.bgHighlight}>
            {" y "}
          </span>
          <span fg={colors.textMuted}>{" copy config path"}</span>
        </text>
      </box>
    </box>
  )
})
