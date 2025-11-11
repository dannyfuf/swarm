package tmux

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// LoadLayout loads custom layout from config
func LoadLayout(configPath string) (*Layout, error) {
	if configPath == "" {
		return DefaultLayout(), nil
	}

	// Check if it's a script
	if filepath.Ext(configPath) == ".sh" {
		return loadFromScript(configPath)
	}

	// Load as JSON
	return loadFromJSON(configPath)
}

func loadFromJSON(path string) (*Layout, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading layout file: %w", err)
	}

	var layout Layout
	if err := json.Unmarshal(data, &layout); err != nil {
		return nil, fmt.Errorf("parsing layout JSON: %w", err)
	}

	return &layout, nil
}

func loadFromScript(scriptPath string) (*Layout, error) {
	// Script should output JSON layout to stdout
	cmd := exec.Command(scriptPath)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("executing layout script: %w", err)
	}

	var layout Layout
	if err := json.Unmarshal(output, &layout); err != nil {
		return nil, fmt.Errorf("parsing script output: %w", err)
	}

	return &layout, nil
}
