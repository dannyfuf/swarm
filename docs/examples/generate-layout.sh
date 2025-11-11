#!/bin/bash
# Example script that generates a layout dynamically
# This could be customized based on project type, environment, etc.

cat <<EOF
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
      "panes": []
    },
    {
      "name": "tests",
      "command": "make test",
      "panes": [
        {
          "command": "make watch",
          "direction": "vertical",
          "size": 50
        }
      ]
    }
  ]
}
EOF
