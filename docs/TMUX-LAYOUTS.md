# Tmux Layout System

Swarm now supports custom tmux layouts for your development sessions.

## Features

- **Default Layout**: 3-window setup (editor, shell, tests) if no custom layout configured
- **JSON Layouts**: Define static layouts in JSON files
- **Script Layouts**: Generate dynamic layouts using shell scripts
- **Layout Commands**: Commands run automatically when sessions are created
- **Pane Splits**: Create horizontal and vertical panes within windows

## Quick Start

### Using the Default Layout

By default, swarm creates sessions with:
- Window 1: editor (runs `nvim .`)
- Window 2: shell (empty prompt)
- Window 3: tests (runs `make test` with `make watch` in split pane)

### Custom Layout Configuration

Add to your `.swarm.toml`:

```toml
# Use a JSON layout file
tmux_layout_script = "/path/to/layout.json"

# Or use a shell script
tmux_layout_script = "/path/to/generate-layout.sh"
```

### Example JSON Layout

```json
{
  "windows": [
    {
      "name": "editor",
      "command": "nvim .",
      "panes": []
    },
    {
      "name": "shell",
      "command": "",
      "panes": [
        {
          "command": "git status",
          "direction": "vertical",
          "size": 30
        }
      ]
    }
  ]
}
```

### Example Script Layout

```bash
#!/bin/bash
cat <<EOF
{
  "windows": [
    {
      "name": "editor",
      "command": "nvim .",
      "panes": []
    }
  ]
}
EOF
```

Make the script executable: `chmod +x generate-layout.sh`

## Commands

### List Sessions

View all active tmux sessions:

```bash
# Show only swarm sessions
swarm sessions

# Show all tmux sessions
swarm sessions --all
```

### Open with Layout

When you open a worktree, the layout is automatically applied to new sessions:

```bash
swarm open myrepo feature-branch
```

If the session already exists, it attaches without modifying the layout.

## Layout Structure

### Windows

Windows are top-level containers in tmux:

```json
{
  "name": "window-name",      // Name shown in status bar
  "command": "command",        // Command to run (optional)
  "panes": [...]               // Additional pane splits (optional)
}
```

### Panes

Panes are splits within a window:

```json
{
  "command": "command",        // Command to run in pane (optional)
  "direction": "vertical",     // "vertical" or "horizontal"
  "size": 50                   // Percentage size (optional)
}
```

**Directions:**
- `horizontal`: Left-right split (side by side)
- `vertical`: Top-bottom split (stacked)

**Sizes:**
- Percentage of window size (e.g., `50` = 50%)
- If omitted, tmux uses equal splits

## Examples

See `docs/examples/` for complete examples:

- `simple-layout.json` - Minimal 2-window layout
- `dev-layout.json` - Full development setup with 4 windows
- `generate-layout.sh` - Dynamic layout generation script
- `README.md` - Complete documentation

## Troubleshooting

### Layout Not Applied

If your layout fails to load, swarm will:
1. Print a warning message
2. Fall back to the default layout
3. Continue creating the session

Check that:
- JSON is valid
- Script is executable (`chmod +x script.sh`)
- Script outputs valid JSON to stdout
- File path in `.swarm.toml` is correct

### Commands Not Running

If commands don't execute:
- Verify the command works in a normal shell
- Check for typos in the command string
- Some commands may need full paths
- Commands run from the worktree directory

### Panes Not Splitting

If pane splits don't work:
- Check direction is "horizontal" or "vertical"
- Verify window size is large enough for splits
- Try without size parameter first

## Implementation Details

The layout system consists of:

- `internal/tmux/layout.go` - Layout data structures and application logic
- `internal/tmux/loader.go` - JSON and script loading
- `cmd/sessions.go` - Session listing command
- `cmd/open.go` - Layout integration with open command

## Future Enhancements

Potential additions:
- Layout templates per project type (Go, Python, Node, etc.)
- Environment-based layout selection
- Window focus control
- More pane layout options
- Layout validation command
