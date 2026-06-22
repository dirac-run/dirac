#!/bin/bash

# Script to automate version bumping, publishing, and tagging for the Dirac VS Code extension.
# Usage: ./scripts/publish-extension.sh [patch|minor|major] [--dry-run]
#
# This script:
#   1. Bumps the version in package.json
#   2. Builds the .vsix
#   3. Generates a changelog from commits since the last release tag
#   4. Publishes to VS Marketplace and Open VSX
#   5. Commits, tags, and pushes (triggers GitHub Action to create the Release)
#
# With --dry-run, it does everything except: publish, commit, tag, and push.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

function log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

function log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

function log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

function log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

# Parse arguments
BUMP_TYPE=""
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        patch|minor|major)
            BUMP_TYPE="$arg"
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        *)
            log_error "Unknown argument: $arg"
            echo "Usage: $0 [patch|minor|major] [--dry-run]"
            exit 1
            ;;
    esac
done

if [ -z "$BUMP_TYPE" ]; then
    log_error "Usage: $0 [patch|minor|major] [--dry-run]"
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    log_warn "DRY RUN mode — will not publish, commit, tag, or push."
fi

# 1. Validate environment
if [ ! -f "package.json" ]; then
    log_error "This script must be run from the repository root."
    exit 1
fi

# Check required tools
for cmd in git node npx; do
    if ! command -v "$cmd" &>/dev/null; then
        log_error "Required command not found: $cmd"
        exit 1
    fi
done

# Check working tree is clean (skip in dry-run)
if [ "$DRY_RUN" = false ] && [ -n "$(git status --porcelain)" ]; then
    log_error "Working tree is dirty. Please commit or stash changes first."
    exit 1
fi

# 2. Determine versions
OLD_VERSION=$(node -p "require('./package.json').version")
log_info "Current version: $OLD_VERSION"

# 3. Find the last extension release tag (exclude -cli tags)
LAST_TAG=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-cli' | head -1)
if [ -z "$LAST_TAG" ]; then
    log_warn "No previous release tag found. Changelog will include all commits."
    LAST_TAG=""
fi

# 4. Bump version
log_step "Bumping version ($BUMP_TYPE) in package.json..."
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
log_info "Version bumped: $OLD_VERSION -> $NEW_VERSION"

# 5. Build the extension
log_step "Building extension..."
npm run compile
npx @vscode/vsce package --allow-missing-repository

# 6. Generate changelog
log_step "Generating changelog..."
CHANGELOG_FILE=".scratch-release-changelog.md"
{
    echo "## What's Changed in v${NEW_VERSION}"
    echo ""
    if [ -n "$LAST_TAG" ]; then
        git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges \
            | grep -iE '^- (feat|fix|perf|docs|revert)[:(]' \
            || echo "- (no user-facing changes)"
    else
        git log --pretty=format:"- %s" --no-merges \
            | grep -iE '^- (feat|fix|perf|docs|revert)[:(]' \
            | head -50 \
            || echo "- (no user-facing changes)"
    fi
    echo ""
    echo ""
    echo "**Full Changelog**: https://github.com/dirac-run/dirac/compare/${LAST_TAG:-v0.0.0}...v${NEW_VERSION}"
} > "$CHANGELOG_FILE"

echo ""
echo -e "${CYAN}--- Changelog ---${NC}"
cat "$CHANGELOG_FILE"
echo -e "${CYAN}--- End Changelog ---${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    log_info "Dry run complete. Built .vsix and generated changelog."
    log_info "Version bump: $OLD_VERSION -> $NEW_VERSION"
    log_info "Changelog written to: $CHANGELOG_FILE"
    # Revert the version bump since we're not actually releasing
    log_step "Reverting version bump..."
    git checkout -- package.json package-lock.json 2>/dev/null || true
    log_info "Done. No changes were committed or published."
    exit 0
fi

# 7. Publish to VS Marketplace
log_step "Publishing to VS Marketplace..."
if [ -z "$VSCE_PAT" ]; then
    log_error "VSCE_PAT not set. Cannot publish to VS Marketplace."
    exit 1
fi
npx @vscode/vsce publish -p "$VSCE_PAT"
log_info "Published to VS Marketplace."

# 8. Publish to Open VSX
log_step "Publishing to Open VSX..."
if [ -z "$OVSX_PAT" ]; then
    log_error "OVSX_PAT not set. Cannot publish to Open VSX."
    exit 1
fi
npx ovsx publish -p "$OVSX_PAT"
log_info "Published to Open VSX."

# 9. Commit and tag
log_step "Committing version bump and creating tag..."
rm -f dirac-*.vsix  # Clean up .vsix file (don't commit it)
git add package.json package-lock.json
git commit -m "chore: bump extension version to v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

# 10. Push
log_step "Pushing commit and tag..."
git push origin main
git push origin "v${NEW_VERSION}"

# Cleanup
rm -f "$CHANGELOG_FILE"

echo ""
echo "--------------------------------------------------"
log_info "✅ Extension v${NEW_VERSION} released successfully!"
echo ""
echo "  • Published to VS Marketplace"
echo "  • Published to Open VSX"
echo "  • Tag v${NEW_VERSION} pushed — GitHub Action will create the Release"
echo ""
echo "  Watch for the Release at:"
echo "  https://github.com/dirac-run/dirac/releases/tag/v${NEW_VERSION}"
echo "--------------------------------------------------"
