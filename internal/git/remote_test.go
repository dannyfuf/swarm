package git

import (
	"os/exec"
	"testing"

	"github.com/microsoft/amplifier/swarm/internal/errors"
	"github.com/stretchr/testify/assert"
)

func TestGhCliAvailable(t *testing.T) {
	t.Run("runs without panic", func(t *testing.T) {
		// Should not panic
		assert.NotPanics(t, func() {
			GhCliAvailable()
		})
	})

	t.Run("returns bool value", func(t *testing.T) {
		result := GhCliAvailable()
		// Result should be true or false
		assert.IsType(t, true, result)
	})
}

func TestGhCliNotInstalled(t *testing.T) {
	// Check if gh is actually installed
	_, err := exec.LookPath("gh")
	if err == nil {
		t.Skip("gh CLI is installed, skipping not-installed test")
	}

	available := GhCliAvailable()
	assert.False(t, available, "gh CLI should not be available")
}

func TestGhCliInstalled(t *testing.T) {
	// Check if gh is actually installed
	_, err := exec.LookPath("gh")
	if err != nil {
		t.Skip("gh CLI not installed, skipping installed test")
	}

	available := GhCliAvailable()
	assert.True(t, available, "gh CLI should be available")
}

func TestGhCliAuthenticated(t *testing.T) {
	// Check if gh is installed
	if !GhCliAvailable() {
		t.Skip("gh CLI not installed, skipping auth test")
	}

	err := GhCliAuthenticated()

	// Should return either nil or ErrGhNotAuthenticated
	if err != nil {
		assert.ErrorIs(t, err, errors.ErrGhNotAuthenticated)
	}
}

func TestGhCliAuthenticatedWithoutGh(t *testing.T) {
	// Check if gh is actually NOT installed
	_, err := exec.LookPath("gh")
	if err == nil {
		t.Skip("gh CLI is installed, skipping not-installed test")
	}

	err = GhCliAuthenticated()
	assert.ErrorIs(t, err, errors.ErrGhCliNotFound)
}
