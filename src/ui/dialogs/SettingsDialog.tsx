import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import type { Controller, Store } from "../../core/app.ts";
import { AGENT_NAMES, type AgentName, type SleepPolicy } from "../../core/types.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, isListDown, isListUp, isSpace, toKeyEvent } from "../keys.ts";
import { cell, fitLine, type Line, pad, truncate } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import {
  DialogFrame,
  FieldLabel,
  SectionLabel,
  Spacer,
  TextField,
  useDialogInnerWidth,
} from "./chrome.tsx";

function checkbox(checked: boolean, selected: boolean): Line {
  return [
    cell(selected ? ` ${glyphs.cursor} ` : "   ", { fg: theme.accent }),
    cell("[", { fg: theme.dim }),
    cell(checked ? glyphs.checked : " ", { fg: checked ? theme.green : theme.dim }),
    cell("] ", { fg: theme.dim }),
  ];
}

export function SettingsDialog({ store, controller }: { store: Store; controller: Controller }) {
  const [agent, setAgent] = useState<AgentName>(() => controller.getConfig().agent);
  const [agentCommands, setAgentCommands] = useState<Record<AgentName, string>>(() => ({
    ...controller.getConfig().agentCommands,
  }));
  const [policy, setPolicy] = useState<SleepPolicy>(() => {
    const current = controller.getConfig().sleep;
    return { ...current, keepAlive: current.keepAlive.map((rule) => ({ ...rule })) };
  });
  const [cursor, setCursor] = useState(0);
  const config = controller.getConfig();
  const hosts = Object.entries(config.hosts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, host]) => `${id} (ssh ${host.ssh})`)
    .join(", ");
  const inner = useDialogInnerWidth(78);
  const rowCount = 3 + policy.keepAlive.length;
  const clamped = Math.min(cursor, rowCount - 1);
  const commandFocused = clamped === 1;
  const submitted = useRef(false);

  const cycleAgent = (delta: number) => {
    setAgent((current) => {
      const index = AGENT_NAMES.indexOf(current);
      return AGENT_NAMES[(index + delta + AGENT_NAMES.length) % AGENT_NAMES.length] ?? current;
    });
  };

  const toggle = () => {
    if (clamped === 0) {
      cycleAgent(1);
      return;
    }
    if (clamped === 2) {
      setPolicy((current) => ({ ...current, enabled: !current.enabled }));
      return;
    }
    if (commandFocused) return;
    const index = clamped - 3;
    setPolicy((current) => ({
      ...current,
      keepAlive: current.keepAlive.map((rule, position) =>
        position === index ? { ...rule, enabled: !rule.enabled } : rule,
      ),
    }));
  };

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
      return;
    }
    if (isListDown(event, commandFocused)) {
      raw.preventDefault();
      setCursor((value) => Math.min(value + 1, rowCount - 1));
      return;
    }
    if (isListUp(event, commandFocused)) {
      raw.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      if (!submitted.current) {
        submitted.current = true;
        const normalizedCommands = { ...agentCommands };
        for (const name of AGENT_NAMES) {
          normalizedCommands[name] = normalizedCommands[name].trim() || name;
        }
        store.dispatch({ type: "closeDialog" });
        void controller.saveConfig({
          agent,
          agentCommands: normalizedCommands,
          sleep: policy,
        });
      }
      return;
    }
    if (commandFocused) return;
    if (isSpace(event)) {
      raw.preventDefault();
      toggle();
      return;
    }
    if (clamped === 0 && (event.name === "left" || event.name === "right")) {
      raw.preventDefault();
      cycleAgent(event.name === "left" ? -1 : 1);
    }
  });

  const agentRow: Line = [
    cell(clamped === 0 ? ` ${glyphs.cursor} ` : "   ", { fg: theme.accent }),
    cell(pad("coding agent", 25), {
      fg: clamped === 0 ? theme.strong : theme.text,
      bold: clamped === 0,
    }),
    cell(agent, { fg: theme.magenta, bold: true }),
    cell("  ←/→ to change", { fg: theme.dim }),
  ];

  const sleepRows: Line[] = [
    [
      ...checkbox(policy.enabled, clamped === 2),
      cell(pad("sleep on switch", 22), {
        fg: clamped === 2 ? theme.strong : theme.text,
        bold: clamped === 2,
      }),
      cell("close windows when leaving a worktree", { fg: theme.dim }),
    ],
    [
      cell("       ", {}),
      cell(pad("grace", 22), { fg: theme.dim }),
      cell(`${policy.graceMs}ms before giving up on :qa`, { fg: theme.ghost }),
    ],
  ];

  const ruleRows: Line[] = policy.keepAlive.map((rule, index) => {
    const selected = clamped === index + 3;
    return [
      ...checkbox(rule.enabled, selected),
      cell(pad(truncate(rule.label, 14), 16), {
        fg: selected ? theme.strong : theme.text,
        bold: selected,
      }),
      cell(pad(rule.kind === "process" ? "process" : "port", 9), { fg: theme.magenta }),
      cell(truncate(rule.pattern || "any listening TCP port", 34), { fg: theme.dim }),
    ];
  });

  const windowRow: Line = [cell("       ", {})];
  config.windows.forEach((window, index) => {
    if (index > 0) windowRow.push(cell(`  ${glyphs.sep}  `, { fg: theme.dim }));
    windowRow.push(cell(window.name, { fg: theme.text }));
    windowRow.push(cell(` (${window.command})`, { fg: theme.dim }));
  });

  return (
    <DialogFrame
      title="Settings"
      width={78}
      hints={[
        { key: "type/space/←→", label: "change" },
        { key: glyphs.enter, label: "save" },
        { key: "↑↓", label: "select" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <SectionLabel text="  AGENT" />
      <LinesView lines={[fitLine(agentRow, inner)]} />
      <box height={1} flexDirection="row">
        <box width={28} paddingLeft={1}>
          <FieldLabel text="start command" focused={commandFocused} />
        </box>
        <box flexGrow={1}>
          <TextField
            key={agent}
            value={agentCommands[agent]}
            placeholder={agent}
            focused={commandFocused}
            onInput={(value) => setAgentCommands((current) => ({ ...current, [agent]: value }))}
          />
        </box>
      </box>
      <Spacer />
      <SectionLabel text="  SLEEP POLICY" />
      <LinesView lines={sleepRows.map((line) => fitLine(line, inner))} />
      <Spacer />
      <SectionLabel text="  KEEP ALIVE" />
      <LinesView lines={ruleRows.map((line) => fitLine(line, inner))} />
      <Spacer />
      <SectionLabel text="  WINDOWS" />
      <LinesView lines={[fitLine(windowRow, inner)]} />
      <LinesView
        lines={[
          fitLine(
            [
              cell("       ", {}),
              cell("hosts: ", { fg: theme.ghost }),
              cell(hosts || "none", { fg: theme.text }),
            ],
            inner,
          ),
        ]}
      />
      <LinesView
        lines={[
          [
            cell("       ", {}),
            cell("clone protocol ", { fg: theme.ghost }),
            cell(config.github.cloneProtocol, { fg: theme.text }),
            cell(`  ${glyphs.sep}  edit in `, { fg: theme.ghost }),
            cell("~/.swarm/config.json", { fg: theme.ghost }),
          ],
        ]}
      />
    </DialogFrame>
  );
}
