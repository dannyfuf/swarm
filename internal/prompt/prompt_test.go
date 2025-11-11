package prompt

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChoice(t *testing.T) {
	tests := []struct {
		name          string
		input         string
		options       []string
		defaultChoice int
		want          int
		wantErr       bool
	}{
		{
			name:          "valid choice",
			input:         "2\n",
			options:       []string{"opt1", "opt2", "opt3"},
			defaultChoice: 1,
			want:          1,
			wantErr:       false,
		},
		{
			name:          "default choice",
			input:         "\n",
			options:       []string{"opt1", "opt2"},
			defaultChoice: 1,
			want:          0, // default is 1, returns 0-indexed
			wantErr:       false,
		},
		{
			name:          "invalid choice - too high",
			input:         "5\n",
			options:       []string{"opt1", "opt2"},
			defaultChoice: 1,
			wantErr:       true,
		},
		{
			name:          "invalid choice - zero",
			input:         "0\n",
			options:       []string{"opt1", "opt2"},
			defaultChoice: 1,
			wantErr:       true,
		},
		{
			name:          "invalid choice - non-numeric",
			input:         "abc\n",
			options:       []string{"opt1", "opt2"},
			defaultChoice: 1,
			wantErr:       true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Mock stdin
			oldStdin := os.Stdin
			r, w, err := os.Pipe()
			require.NoError(t, err)
			os.Stdin = r

			// Write input in goroutine
			go func() {
				w.Write([]byte(tt.input))
				w.Close()
			}()

			got, err := Choice("Test?", tt.options, tt.defaultChoice)

			os.Stdin = oldStdin

			if tt.wantErr {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestConfirm(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		defaultYes bool
		want       bool
		wantErr    bool
	}{
		{
			name:       "yes response",
			input:      "y\n",
			defaultYes: false,
			want:       true,
			wantErr:    false,
		},
		{
			name:       "yes full word",
			input:      "yes\n",
			defaultYes: false,
			want:       true,
			wantErr:    false,
		},
		{
			name:       "no response",
			input:      "n\n",
			defaultYes: true,
			want:       false,
			wantErr:    false,
		},
		{
			name:       "default yes",
			input:      "\n",
			defaultYes: true,
			want:       true,
			wantErr:    false,
		},
		{
			name:       "default no",
			input:      "\n",
			defaultYes: false,
			want:       false,
			wantErr:    false,
		},
		{
			name:       "case insensitive yes",
			input:      "Y\n",
			defaultYes: false,
			want:       true,
			wantErr:    false,
		},
		{
			name:       "case insensitive YES",
			input:      "YES\n",
			defaultYes: false,
			want:       true,
			wantErr:    false,
		},
		{
			name:       "invalid input",
			input:      "maybe\n",
			defaultYes: false,
			want:       false,
			wantErr:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Mock stdin
			oldStdin := os.Stdin
			r, w, err := os.Pipe()
			require.NoError(t, err)
			os.Stdin = r

			// Write input in goroutine
			go func() {
				w.Write([]byte(tt.input))
				w.Close()
			}()

			got, err := Confirm("Test?", tt.defaultYes)

			os.Stdin = oldStdin

			if tt.wantErr {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestIsInteractive(t *testing.T) {
	// When running tests, stdin is typically not a TTY
	// This test just ensures the function doesn't panic
	result := IsInteractive()
	// Result depends on test environment
	assert.IsType(t, true, result)
}
