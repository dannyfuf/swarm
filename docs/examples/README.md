# Tmux Layout Examples

This directory contains example layouts for customizing your tmux sessions.

## Using Layouts

You can configure a custom layout by setting `tmux_layout_script` in your `.swarm.toml`:

```toml
tmux_layout_script = "/path/to/layout.json"
# or
tmux_layout_script = "/path/to/generate-layout.sh"
```

## Layout Format

Layouts are defined as JSON with the following structure:

```json
{
  "windows": [
    {
      "name": "window-name",
      "command": "command to run",
      "panes": [
        {
          "command": "command for pane",
          "direction": "horizontal|vertical",
          "size": 50
        }
      ]
    }
  ]
}
```

### Fields

- **windows**: Array of window definitions
  - **name**: Name of the tmux window
  - **command**: Initial command to run in the main pane (optional)
  - **panes**: Array of additional pane splits (optional)
    - **command**: Command to run in the pane (optional)
    - **direction**: Split direction - "horizontal" (side-by-side) or "vertical" (top-bottom)
    - **size**: Percentage size of the pane (e.g., 50 for 50%)

## Examples

### simple-layout.json

Minimal 2-window layout:
- Editor window with nvim
- Shell window

```bash
tmux_layout_script = "docs/examples/simple-layout.json"
```

### dev-layout.json

Full development layout with 4 windows:
- Editor window with nvim
- Shell window with git status pane
- Tests window with watch pane
- Logs window

```bash
tmux_layout_script = "docs/examples/dev-layout.json"
```

### generate-layout.sh

Dynamic layout script that outputs JSON. This allows you to:
- Generate layouts based on environment variables
- Detect project type and customize layout
- Include conditional panes

```bash
tmux_layout_script = "docs/examples/generate-layout.sh"
```

Make sure the script is executable:
```bash
chmod +x docs/examples/generate-layout.sh
```

## Default Layout

If no layout is configured, swarm uses this default 3-window layout:

1. **editor** - Opens nvim
2. **shell** - Empty shell
3. **tests** - Runs `make test` with `make watch` in split pane

## Tips

- Window names appear in the tmux status bar
- Commands run automatically when the session is created
- Pane sizes are percentages (50 = 50% of window)
- Direction "horizontal" splits left-right, "vertical" splits top-bottom
- Empty command ("") gives you a clean shell prompt
- Scripts must output valid JSON to stdout
