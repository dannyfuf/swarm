package prompt

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Choice presents numbered options and returns selection
func Choice(question string, options []string, defaultChoice int) (int, error) {
	fmt.Println(question)
	fmt.Println()

	for i, opt := range options {
		fmt.Printf("  %d. %s\n", i+1, opt)
	}
	fmt.Println()

	fmt.Printf("Choice [%d]: ", defaultChoice)

	reader := bufio.NewReader(os.Stdin)
	input, err := reader.ReadString('\n')
	if err != nil {
		return 0, fmt.Errorf("reading input: %w", err)
	}

	input = strings.TrimSpace(input)

	// Empty input uses default
	if input == "" {
		return defaultChoice - 1, nil
	}

	// Parse choice
	choice, err := strconv.Atoi(input)
	if err != nil || choice < 1 || choice > len(options) {
		return 0, fmt.Errorf("invalid choice: must be 1-%d", len(options))
	}

	return choice - 1, nil
}

// Confirm asks a yes/no question
func Confirm(question string, defaultYes bool) (bool, error) {
	prompt := "[y/N]"
	if defaultYes {
		prompt = "[Y/n]"
	}

	fmt.Printf("%s %s: ", question, prompt)

	reader := bufio.NewReader(os.Stdin)
	input, err := reader.ReadString('\n')
	if err != nil {
		return false, fmt.Errorf("reading input: %w", err)
	}

	input = strings.ToLower(strings.TrimSpace(input))

	if input == "" {
		return defaultYes, nil
	}

	return input == "y" || input == "yes", nil
}

// IsInteractive checks if we're in an interactive terminal
func IsInteractive() bool {
	fileInfo, _ := os.Stdin.Stat()
	return (fileInfo.Mode() & os.ModeCharDevice) != 0
}
