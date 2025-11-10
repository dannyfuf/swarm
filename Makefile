.PHONY: help build install test test-integration test-e2e test-all clean fmt lint vet check coverage doctor

# Variables
BINARY_NAME=swarm
BUILD_DIR=bin
INSTALL_PATH=/usr/local/bin
GO=go
GOFLAGS=-v

# Help target
help:
	@echo "Swarm - Git Worktree + Tmux Session Manager"
	@echo ""
	@echo "Available targets:"
	@echo "  make build            - Build the binary"
	@echo "  make install          - Build and install to $(INSTALL_PATH)"
	@echo "  make test             - Run unit tests"
	@echo "  make test-integration - Run integration tests (requires git + tmux)"
	@echo "  make test-e2e         - Run end-to-end tests"
	@echo "  make test-all         - Run all tests"
	@echo "  make coverage         - Generate test coverage report"
	@echo "  make fmt              - Format code"
	@echo "  make lint             - Run linter"
	@echo "  make vet              - Run go vet"
	@echo "  make check            - Run fmt, vet, lint, and tests"
	@echo "  make clean            - Remove build artifacts"
	@echo "  make doctor           - Check environment setup"

# Build targets
build:
	@echo "Building $(BINARY_NAME)..."
	@mkdir -p $(BUILD_DIR)
	$(GO) build $(GOFLAGS) -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/swarm
	@echo "Built: $(BUILD_DIR)/$(BINARY_NAME)"

build-release:
	@echo "Building optimized release binary..."
	@mkdir -p $(BUILD_DIR)
	$(GO) build -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/swarm
	@echo "Built: $(BUILD_DIR)/$(BINARY_NAME)"

install: build
	@echo "Installing to $(INSTALL_PATH)..."
	@sudo cp $(BUILD_DIR)/$(BINARY_NAME) $(INSTALL_PATH)/
	@echo "Installed: $(INSTALL_PATH)/$(BINARY_NAME)"
	@echo "Run 'swarm --help' to get started"

# Test targets
test:
	@echo "Running unit tests..."
	$(GO) test ./... $(GOFLAGS)

test-integration:
	@echo "Running integration tests (requires git + tmux)..."
	$(GO) test -tags=integration ./... $(GOFLAGS)

test-e2e:
	@echo "Running end-to-end tests..."
	$(GO) test -tags=e2e ./test/e2e/ $(GOFLAGS)
	@if [ -d test/e2e ] && [ -f test/e2e/run_all.sh ]; then \
		echo "Running shell-based E2E tests..."; \
		./test/e2e/run_all.sh; \
	fi

test-all: test test-integration test-e2e

coverage:
	@echo "Generating coverage report..."
	$(GO) test ./... -coverprofile=coverage.out
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"
	@$(GO) tool cover -func=coverage.out | grep total

# Code quality targets
fmt:
	@echo "Formatting code..."
	$(GO) fmt ./...

lint:
	@echo "Running linter..."
	@if command -v golangci-lint > /dev/null; then \
		golangci-lint run; \
	else \
		echo "golangci-lint not installed. Install with:"; \
		echo "  curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $$(go env GOPATH)/bin"; \
	fi

vet:
	@echo "Running go vet..."
	$(GO) vet ./...

check: fmt vet test
	@echo "✓ All checks passed!"

# Utility targets
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR)
	@rm -f coverage.out coverage.html
	@echo "Cleaned!"

doctor:
	@echo "Checking environment setup..."
	@echo ""
	@echo "Go version:"
	@$(GO) version || echo "✗ Go not installed"
	@echo ""
	@echo "Git version:"
	@git --version || echo "✗ Git not installed"
	@echo ""
	@echo "Tmux version:"
	@tmux -V || echo "✗ Tmux not installed"
	@echo ""
	@echo "AI_WORKING_DIR:"
	@if [ -n "$$AI_WORKING_DIR" ]; then \
		echo "  ✓ $$AI_WORKING_DIR"; \
		if [ -d "$$AI_WORKING_DIR" ]; then \
			echo "  ✓ Directory exists"; \
		else \
			echo "  ✗ Directory does not exist"; \
		fi \
	else \
		echo "  ✗ Not set (will default to ~/amplifier/ai_working)"; \
	fi
	@echo ""
	@echo "Build directory:"
	@if [ -d "$(BUILD_DIR)" ]; then \
		echo "  ✓ $(BUILD_DIR) exists"; \
	else \
		echo "  - $(BUILD_DIR) will be created on build"; \
	fi

# Development targets
dev-setup:
	@echo "Setting up development environment..."
	$(GO) mod download
	@echo "Installing dev tools..."
	@if ! command -v golangci-lint > /dev/null; then \
		echo "Installing golangci-lint..."; \
		curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $$(go env GOPATH)/bin; \
	fi
	@echo "✓ Development environment ready!"

run: build
	@$(BUILD_DIR)/$(BINARY_NAME) $(ARGS)

# Multi-platform builds
build-all:
	@echo "Building for multiple platforms..."
	@mkdir -p $(BUILD_DIR)
	GOOS=darwin GOARCH=amd64 $(GO) build -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME)-darwin-amd64 ./cmd/swarm
	GOOS=darwin GOARCH=arm64 $(GO) build -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME)-darwin-arm64 ./cmd/swarm
	GOOS=linux GOARCH=amd64 $(GO) build -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME)-linux-amd64 ./cmd/swarm
	@echo "Built binaries:"
	@ls -lh $(BUILD_DIR)

.DEFAULT_GOAL := help
