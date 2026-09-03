# swarm keymap

## Normal mode

| Key | Command |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Move the cursor down / up |
| `gg` / `G` | Jump to the top / bottom |
| `ctrl-d` / `ctrl-u` | Move half a page down / up |
| `h`, `←`, `S-Tab` | Focus repos |
| `l`, `→`, `Tab` | Focus worktrees |
| `Enter`, `o` | Open a worktree, or focus its repo's worktrees |
| `O` | Open without sleeping the previous worktree |
| `n` | Create a worktree, or clone a repo from the repos pane |
| `N` | Create a context |
| `d` | Delete the selected item after confirmation |
| `D` | Delete the active context after confirmation |
| `s` / `K` | Sleep the worktree / kill its session |
| `m` | Move the repo to another context |
| `r` | Refresh |
| `U` | Update swarm from `origin/main`, rebuild, and restart |
| `/` | Enter filter mode |
| `:` | Open the command palette |
| `,` | Open settings |
| `gt` / `gT` | Select the next / previous context |
| `1`–`9` | Select the nth context |
| `b` | Open the selected worktree branch's pull request in the browser, if one exists |
| `y` | Copy the worktree path |
| `?` | Open help |
| `q`, `Esc`, `ctrl-c` | Quit the popup |

## Filter mode

| Key | Command |
| --- | --- |
| Printable characters | Update the worktree filter |
| `Backspace` | Remove the last filter character |
| `ctrl-n` / `ctrl-p`, `↓` / `↑` | Select the next / previous match |
| `Enter` | Open the selected match |
| `Esc` | Leave filter input and retain the filter |
| `Esc` again in normal mode | Clear the retained filter |
| `ctrl-c` | Quit the popup |

## Dialogs and lists

| Key | Command |
| --- | --- |
| `Esc` | Cancel and close |
| `Enter` | Confirm or select |
| `Tab` / `S-Tab` | Focus the next / previous field |
| `ctrl-n` / `ctrl-p`, `↓` / `↑` | Select the next / previous list item |
