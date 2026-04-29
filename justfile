# Dirac - Justfile
# Quick reference for common development tasks

# Default recipe - shows available commands
[private]
default:
    @just --list --unsorted

# --- Setup & Installation ---

# Install dependencies for all workspaces
install:
    npm run install:all

# Clean build artifacts
clean:
    npm run clean:build

# Clean everything including node_modules
clean-all:
    npm run clean:all

# --- Development ---

# Start development mode (protos + watch)
dev:
    npm run dev

# Watch mode only (requires protos already built)
watch:
    npm run watch

# Build protobuf definitions
protos:
    npm run protos

# --- Building ---

# Full build for VS Code extension
build:
    npm run compile

# Build for production/package
build-prod:
    npm run package

# Build standalone version
build-standalone:
    npm run compile-standalone

# Build webview UI
build-webview:
    npm run build:webview

# Dev mode for webview UI
dev-webview:
    npm run dev:webview

# --- CLI ---

# Build CLI
cli-build:
    npm run cli:build

# Build CLI for production
cli-build-prod:
    npm run cli:build:production

# Link CLI globally
cli-link:
    npm run cli:link

# Unlink CLI
cli-unlink:
    npm run cli:unlink

# Run CLI (after building)
cli-run *ARGS:
    npm run cli:run -- {{ARGS}}

# CLI dev mode (link + watch)
cli-dev:
    npm run cli:dev

# --- Testing ---

# Run all tests
test:
    npm test

# Run unit tests only
test-unit:
    npm run test:unit

# Run integration tests
test-integration:
    npm run test:integration

# Run E2E tests
test-e2e:
    npm run test:e2e

# Run CLI tests
test-cli:
    npm run cli:test

# Run webview UI tests
test-webview:
    npm run test:webview

# --- Code Quality ---

# Check types across all workspaces
check-types:
    npm run check-types

# Run linter
lint:
    npm run lint

# Run linter with auto-fix
lint-fix:
    npm run fix:all

# Check formatting
format-check:
    npm run format

# Fix formatting
format-fix:
    npm run format:fix

# Run all CI checks (types, lint, format in parallel)
ci-check:
    npm run ci:check-all

# --- Storybook ---

# Run Storybook for UI development
storybook:
    npm run storybook

# --- Evaluation / Smoke Tests ---

# Build and run smoke tests
eval-smoke:
    npm run eval:smoke

# Run smoke tests (requires build)
eval-smoke-run:
    npm run eval:smoke:run

# CI smoke tests (1 trial, parallel)
eval-smoke-ci:
    npm run eval:smoke:ci

# --- Publishing ---

# Publish to VS Code marketplace
publish:
    npm run publish:marketplace

# Publish pre-release
publish-prerelease:
    npm run publish:marketplace:prerelease

# Publish nightly build
publish-nightly:
    npm run publish:marketplace:nightly

# --- Documentation ---

# Run docs dev server
docs:
    npm run docs

# Check docs for broken links
docs-check:
    npm run docs:check-links

# --- Utilities ---

# Generate git commit message with Dirac
commit-msg:
    npm run generate-git-commit-message

# Report an issue
report-issue:
    npm run report-issue
