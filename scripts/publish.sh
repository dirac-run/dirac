#!/bin/bash

# Unified publish script for Dirac (extension + CLI).
# Usage: ./scripts/publish.sh [patch|minor|major] [--dry-run]
#
# This script:
#   1. Bumps versions in package.json (extension) and cli/package.json (CLI) in lockstep
#   2. Builds the extension (.vsix) and CLI (npm package)
#   3. Generates a filtered changelog from commits since the last release tag
#   4. Publishes extension to VS Marketplace and Open VSX
#   5. Publishes CLI to npm and updates the Homebrew formula
#   6. Commits, tags (v0.4.6 + v0.4.6-cli), and pushes
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
if [ ! -f "package.json" ] || [ ! -d "cli" ]; then
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
OLD_CLI_VERSION=$(cd cli && node -p "require('./package.json').version")
log_info "Current extension version: $OLD_VERSION"
log_info "Current CLI version: $OLD_CLI_VERSION"

if [ "$OLD_VERSION" != "$OLD_CLI_VERSION" ]; then
    log_warn "Extension ($OLD_VERSION) and CLI ($OLD_CLI_VERSION) versions are out of sync."
    log_warn "Both will be bumped to the same new version."
fi

# 3. Find the last release tag (exclude -cli tags)
LAST_TAG=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-cli' | head -1)
if [ -z "$LAST_TAG" ]; then
    log_warn "No previous release tag found. Changelog will include all commits."
    LAST_TAG=""
fi
# Sync CLI version to extension if they differ, so bump produces the same result for both.
if [ "$OLD_VERSION" != "$OLD_CLI_VERSION" ]; then
    log_step "Syncing CLI version from $OLD_CLI_VERSION to $OLD_VERSION before bump..."
    cd cli
    npm version "$OLD_VERSION" --no-git-tag-version
    cd ..
fi

# 4. Bump versions (lockstep)
log_step "Bumping version ($BUMP_TYPE)..."
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")

# Rerun safety check — abort if tag already exists
if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
    log_error "Tag v${NEW_VERSION} already exists. This version was already released."
    log_step "Reverting version bump..."
    git checkout -- package.json package-lock.json cli/package.json 2>/dev/null || true
    git checkout -- cli/dirac.rb 2>/dev/null || true
    exit 1
fi

cd cli
npm version "$BUMP_TYPE" --no-git-tag-version
cd ..

log_info "Version bumped: $OLD_VERSION -> $NEW_VERSION (extension + CLI)"

# 5. Build extension
log_step "Building extension..."
npm run compile
npx @vscode/vsce package --allow-missing-repository

# 6. Build CLI
log_step "Building CLI..."
npm run compile-standalone-npm
npm run cli:build:production
cd cli
npm run package:brew
cd ..

# 7. Generate changelog
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
    log_info "Dry run complete."
    log_info "  Extension .vsix: dirac-${NEW_VERSION}.vsix"
    log_info "  CLI npm package: dist-standalone/"
    log_info "  Homebrew formula: cli/dirac.rb"
    log_info "Version bump: $OLD_VERSION -> $NEW_VERSION"
    log_info "Changelog written to: $CHANGELOG_FILE"
    # Revert the version bump since we're not actually releasing
    log_step "Reverting version bump..."
    git checkout -- package.json package-lock.json cli/package.json 2>/dev/null || true
    # Revert Homebrew formula if it was modified
    git checkout -- cli/dirac.rb 2>/dev/null || true
    log_info "Done. No changes were committed or published."
    exit 0
fi

# 8. Commit version bumps (vsce publish requires a clean working tree)
log_step "Committing version bumps..."
rm -f dirac-*.vsix  # Clean up .vsix file (don't commit it)
git add package.json package-lock.json cli/package.json cli/dirac.rb
git commit -m "chore: bump version to v${NEW_VERSION}"

# 9. Publish extension to VS Marketplace
log_step "Publishing to VS Marketplace..."
if [ -z "$VSCE_PAT" ]; then
    log_error "VSCE_PAT not set. Cannot publish to VS Marketplace."
    exit 1
fi
npx @vscode/vsce publish -p "$VSCE_PAT"
log_info "Published extension to VS Marketplace."

# 10. Publish extension to Open VSX
log_step "Publishing to Open VSX..."
if [ -z "$OVSX_PAT" ]; then
    log_error "OVSX_PAT not set. Cannot publish to Open VSX."
    exit 1
fi
npx ovsx publish -p "$OVSX_PAT"
log_info "Published extension to Open VSX."

# 11. Publish CLI to npm
log_step "Publishing CLI to npm..."
cd dist-standalone
npm publish
cd ..
log_info "Published CLI to npm."

# 12. Homebrew formula
log_step "Homebrew formula updated at cli/dirac.rb."
log_warn "Remember to commit the Homebrew formula update to homebrew-core separately."

# 13. Tag and push
log_step "Creating tags and pushing..."
git tag "v${NEW_VERSION}"
git tag "v${NEW_VERSION}-cli"
git push origin master
git push origin "v${NEW_VERSION}"
git push origin "v${NEW_VERSION}-cli"

# Cleanup
rm -f "$CHANGELOG_FILE"

echo ""
echo "--------------------------------------------------"
log_info "✅ Dirac v${NEW_VERSION} released successfully!"
echo ""
echo "  Extension:"
echo "    • Published to VS Marketplace"
echo "    • Published to Open VSX"
echo ""
echo "  CLI:"
echo "    • Published to npm (dirac-cli@${NEW_VERSION})"
echo "    • Homebrew formula updated (cli/dirac.rb)"
echo ""
echo "  Tag v${NEW_VERSION} pushed — GitHub Action will create the Release"
echo ""
echo "  Watch for the Release at:"
echo "  https://github.com/dirac-run/dirac/releases/tag/v${NEW_VERSION}"
echo "--------------------------------------------------"
