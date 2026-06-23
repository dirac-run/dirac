#!/bin/bash

# Unified local publish script for Dirac (extension + CLI).
# Usage: ./scripts/publish.sh [patch|minor|major] [--dry-run]
#
# This script:
#   1. Bumps versions in package.json, package-lock.json, and cli/package.json in lockstep
#   2. Builds the extension (.vsix) and CLI npm package
#   3. Generates annotated Git tags with changelog messages (vX.Y.Z and vX.Y.Z-cli)
#   4. Publishes extension to VS Marketplace and Open VSX from this machine
#   5. Publishes CLI to npm from this machine and updates the Homebrew formula
#   6. Commits, tags, and pushes only after local publishing succeeds
#
# This script intentionally does not dispatch GitHub release workflows.
# With --dry-run, it builds and packages but does not publish, commit, tag, or push.

set -euo pipefail

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

function usage() {
    echo "Usage: $0 [patch|minor|major] [--dry-run]"
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
            usage
            exit 1
            ;;
    esac
done

if [ -z "$BUMP_TYPE" ]; then
    log_error "Missing version bump type."
    usage
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    log_warn "DRY RUN mode — will not publish, commit, tag, or push."
fi

# 1. Validate environment
if [ ! -f "package.json" ] || [ ! -f "package-lock.json" ] || [ ! -d "cli" ]; then
    log_error "This script must be run from the repository root."
    exit 1
fi

for cmd in git node npm npx; do
    if ! command -v "$cmd" &>/dev/null; then
        log_error "Required command not found: $cmd"
        exit 1
    fi
done

MUTATED_FILES=(package.json package-lock.json cli/package.json cli/dirac.rb)
CHANGELOG_FILE=".scratch-release-changelog.md"
CLI_CHANGELOG_FILE=".scratch-release-cli-changelog.md"
ARTIFACT_DIR=".scratch-release-artifacts"
VSIX_FILE=""
NPM_TARBALL=""

function cleanup_generated_files() {
    local exit_code=$?

    if [ "$DRY_RUN" = true ]; then
        git checkout -- "${MUTATED_FILES[@]}" 2>/dev/null || true
    fi

    if [ -n "$VSIX_FILE" ]; then
        rm -f "$VSIX_FILE"
    fi
    rm -f "$CHANGELOG_FILE" "$CLI_CHANGELOG_FILE"
    rm -rf "$ARTIFACT_DIR"

    return "$exit_code"
}
trap cleanup_generated_files EXIT

function assert_mutated_files_clean() {
    local dirty
    dirty=$(git status --porcelain -- "${MUTATED_FILES[@]}")
    if [ -n "$dirty" ]; then
        log_error "Release-managed files already have local changes. Commit or stash them before running publish."
        echo "$dirty"
        exit 1
    fi
}

if [ "$DRY_RUN" = false ]; then
    if [ -n "$(git status --porcelain)" ]; then
        log_error "Working tree is dirty. Please commit or stash changes first."
        exit 1
    fi
    if [ -z "${VSCE_PAT:-}" ]; then
        log_error "VSCE_PAT not set. Cannot publish to VS Marketplace."
        exit 1
    fi
    if [ -z "${OVSX_PAT:-}" ]; then
        log_error "OVSX_PAT not set. Cannot publish to Open VSX."
        exit 1
    fi
else
    assert_mutated_files_clean
fi

function compute_new_version() {
    node -e '
const [version, bumpType] = process.argv.slice(1)
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match) {
  throw new Error(`Cannot bump non-standard semver version: ${version}`)
}
let major = Number(match[1])
let minor = Number(match[2])
let patch = Number(match[3])
switch (bumpType) {
  case "major": major += 1; minor = 0; patch = 0; break
  case "minor": minor += 1; patch = 0; break
  case "patch": patch += 1; break
  default: throw new Error(`Unknown bump type: ${bumpType}`)
}
process.stdout.write(`${major}.${minor}.${patch}`)
' "$1" "$2"
}

function write_versions() {
    VERSION_TO_WRITE="$1" node <<'NODE'
const fs = require("node:fs")
const version = process.env.VERSION_TO_WRITE

function readJson(path) {
    return JSON.parse(fs.readFileSync(path, "utf8"))
}

function writeJson(path, value, indent) {
    fs.writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`)
}

const rootPackage = readJson("package.json")
const cliPackage = readJson("cli/package.json")
const lockfile = readJson("package-lock.json")

rootPackage.version = version
cliPackage.version = version
lockfile.version = version

if (lockfile.packages?.[""]) {
    lockfile.packages[""].version = version
}
if (lockfile.packages?.cli) {
    lockfile.packages.cli.version = version
}
if (lockfile.dependencies?.["dirac-cli"]) {
    lockfile.dependencies["dirac-cli"].version = version
}

writeJson("package.json", rootPackage, 4)
writeJson("cli/package.json", cliPackage, "\t")
writeJson("package-lock.json", lockfile, 4)
NODE
}

function tag_exists() {
    local tag="$1"
    git rev-parse "$tag" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1
}

function generate_changelog() {
    local output_file="$1"
    local title="$2"
    local previous_tag="$3"
    local new_tag="$4"
    local changes

    if [ -n "$previous_tag" ]; then
        changes=$(git log "${previous_tag}..HEAD" --pretty=format:"- %s" --no-merges \
            | grep -iE '^- (feat|fix|perf|docs|revert)[:(]' || true)
    else
        changes=$(git log --pretty=format:"- %s" --no-merges \
            | grep -iE '^- (feat|fix|perf|docs|revert)[:(]' \
            | head -50 || true)
    fi

    {
        echo "## What's Changed in ${new_tag}"
        echo ""
        if [ -n "$changes" ]; then
            printf '%s\n' "$changes"
        else
            echo "- (no user-facing changes)"
        fi
        echo ""
        echo ""
        echo "**Full Changelog**: https://github.com/dirac-run/dirac/compare/${previous_tag:-v0.0.0}...${new_tag}"
    } > "$output_file"

    echo ""
    echo -e "${CYAN}--- ${title} Changelog ---${NC}"
    cat "$output_file"
    echo -e "${CYAN}--- End ${title} Changelog ---${NC}"
    echo ""
}

# 2. Determine versions and target tags
OLD_VERSION=$(node -p "require('./package.json').version")
OLD_CLI_VERSION=$(cd cli && node -p "require('./package.json').version")
NEW_VERSION=$(compute_new_version "$OLD_VERSION" "$BUMP_TYPE")
RELEASE_TAG="v${NEW_VERSION}"
CLI_TAG="v${NEW_VERSION}-cli"

log_info "Current extension version: $OLD_VERSION"
log_info "Current CLI version: $OLD_CLI_VERSION"
log_info "Target version: $NEW_VERSION"

if [ "$OLD_VERSION" != "$OLD_CLI_VERSION" ]; then
    log_warn "Extension ($OLD_VERSION) and CLI ($OLD_CLI_VERSION) versions are out of sync."
    log_warn "Both will be set to $NEW_VERSION."
fi

for tag in "$RELEASE_TAG" "$CLI_TAG"; do
    if tag_exists "$tag"; then
        log_error "Tag $tag already exists locally or on origin. This version was already released."
        exit 1
    fi
done

LAST_TAG=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-cli' | head -1 || true)
LAST_CLI_TAG=$(git tag -l 'v*-cli' --sort=-version:refname | head -1 || true)

if [ -z "$LAST_TAG" ]; then
    log_warn "No previous extension release tag found. Extension changelog will include recent commits."
fi
if [ -z "$LAST_CLI_TAG" ]; then
    log_warn "No previous CLI release tag found. CLI changelog will include recent commits."
fi

# 3. Bump versions in lockstep
log_step "Bumping version ($BUMP_TYPE): $OLD_VERSION -> $NEW_VERSION"
write_versions "$NEW_VERSION"
VSIX_FILE="dirac-${NEW_VERSION}.vsix"

# 4. Generate changelogs for annotated tags
generate_changelog "$CHANGELOG_FILE" "Extension" "$LAST_TAG" "$RELEASE_TAG"
generate_changelog "$CLI_CHANGELOG_FILE" "CLI" "$LAST_CLI_TAG" "$CLI_TAG"

# 5. Build extension
log_step "Building extension package..."
npm run compile
npx @vscode/vsce package --allow-missing-repository

if [ ! -f "$VSIX_FILE" ]; then
    log_error "Expected extension package not found: $VSIX_FILE"
    exit 1
fi

# 6. Build CLI npm package and Homebrew formula from the exact npm tarball
log_step "Building CLI npm package..."
npm run compile-standalone-npm

log_step "Packing CLI npm artifact and updating Homebrew formula..."
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
npx tsx cli/scripts/update-brew-formula.mts --package-dir dist-standalone --pack-destination "$ARTIFACT_DIR" --keep-tarball
NPM_TARBALL="${ARTIFACT_DIR}/dirac-cli-${NEW_VERSION}.tgz"

if [ ! -f "$NPM_TARBALL" ]; then
    log_error "Expected CLI npm tarball not found: $NPM_TARBALL"
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    log_info "Dry run complete. No changes were committed, tagged, pushed, or published."
    log_info "Version bump tested: $OLD_VERSION -> $NEW_VERSION"
    log_info "Extension package tested: $VSIX_FILE"
    log_info "CLI npm package tested: $NPM_TARBALL"
    log_info "Homebrew formula update tested: cli/dirac.rb"
    exit 0
fi

# 7. Commit version bump and formula update before publishing from local artifacts.
log_step "Committing version bump and Homebrew formula update..."
git add package.json package-lock.json cli/package.json cli/dirac.rb
git commit -m "chore: bump version to ${RELEASE_TAG}"

# 8. Publish extension locally from the already-built .vsix
log_step "Publishing extension to VS Marketplace..."
npx @vscode/vsce publish --packagePath "$VSIX_FILE" -p "$VSCE_PAT"
log_info "Published extension to VS Marketplace."

log_step "Publishing extension to Open VSX..."
npx ovsx publish "$VSIX_FILE" -p "$OVSX_PAT"
log_info "Published extension to Open VSX."

# 9. Publish CLI locally from the exact tarball used for Homebrew SHA
log_step "Publishing CLI to npm..."
npm publish "$NPM_TARBALL"
log_info "Published CLI to npm (dirac-cli@${NEW_VERSION})."

# 10. Tag and push after all local publishing succeeds
log_step "Creating annotated tags and pushing to GitHub..."
git tag -a "$RELEASE_TAG" -F "$CHANGELOG_FILE"
git tag -a "$CLI_TAG" -F "$CLI_CHANGELOG_FILE"
git push origin master
git push origin "$RELEASE_TAG" "$CLI_TAG"

trap - EXIT
cleanup_generated_files

echo ""
echo "--------------------------------------------------"
log_info "✅ Dirac ${RELEASE_TAG} released successfully!"
echo ""
echo "  Extension:"
echo "    • Published to VS Marketplace from $VSIX_FILE"
echo "    • Published to Open VSX from $VSIX_FILE"
echo "    • Annotated tag pushed: $RELEASE_TAG"
echo ""
echo "  CLI:"
echo "    • Published to npm from $NPM_TARBALL"
echo "    • Homebrew formula updated from the same tarball SHA"
echo "    • Annotated tag pushed: $CLI_TAG"
echo ""
echo "  GitHub release workflows were not dispatched by this script."
echo "--------------------------------------------------"
