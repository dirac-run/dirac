#!/usr/bin/env bash
# Review helper for PR #125 (alsa/major-refactor)
# Reviews the 377-file diff category by category against base commit 1d316d3.
#
# Usage:
#   ./scripts/review-by-category.sh          # interactive menu
#   ./scripts/review-by-category.sh 3        # run category 3 directly
#   ./scripts/review-by-category.sh all      # run all in sequence
#   ./scripts/review-by-category.sh list     # list categories and exit

set -euo pipefail

BASE="1d316d3"
HEAD="HEAD"

cd "$(git rev-parse --show-toplevel)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
  echo ""
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}${BOLD}  Category $1: $2${NC}"
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}What: $3${NC}"
  echo -e "${YELLOW}Review for: $4${NC}"
  echo ""
}

run_diff() {
  git diff "$BASE..$HEAD" -- "$@"
}

run_diffstat() {
  git diff --stat "$BASE..$HEAD" -- "$@"
}

cat1() {
  print_header 1 "Shared Utilities & DRY Extractions" \
    "jsonHeaders, isAuthError, isRateLimited, env checks, fetchAndCacheModels, tool-fingerprint, api reorg" \
    "API correctness, naming clarity, no over-abstraction, no behavioral change vs inline code replaced"
  run_diffstat src/shared/net.ts src/shared/config/environment.ts src/shared/utils/tool-fingerprint.ts src/shared/api/ src/core/controller/models/fetchAndCacheModels.ts
  echo ""
  run_diff src/shared/net.ts src/shared/config/environment.ts src/shared/utils/tool-fingerprint.ts src/shared/api/ src/core/controller/models/fetchAndCacheModels.ts
}

cat2() {
  print_header 2 "God Class: TelemetryService (2252→266)" \
    "16 per-domain modules + 3 providers. Largest single decomposition." \
    "Every method still exists. No telemetry event lost. CategoryGate gating preserved. Provider switching intact."
  run_diffstat src/services/telemetry/
  echo ""
  run_diff src/services/telemetry/
}

cat3() {
  print_header 3 "God Class: Controller.ts (843→240)" \
    "7 sub-controllers: Auth, State, TaskHistory, File, Models, GrpcService, Ui" \
    "Every public method delegates correctly. No state mutation lost. OAuth flows, settings persistence, history CRUD intact."
  run_diffstat src/core/controller/index.ts src/core/controller/auth/ src/core/controller/state/ src/core/controller/TaskHistoryController.ts src/core/controller/file/ src/core/controller/models/ src/core/controller/grpc-service.ts src/core/controller/grpc-recorder/
  echo ""
  run_diff src/core/controller/index.ts src/core/controller/auth/ src/core/controller/state/ src/core/controller/TaskHistoryController.ts src/core/controller/file/ src/core/controller/models/ src/core/controller/grpc-service.ts src/core/controller/grpc-recorder/
}

cat4() {
  print_header 4 "God Class: UiController + Assemblers (226→62)" \
    "6 state assembler modules + 2 helpers" \
    "getStateToPostToWebview output shape identical. Each assembler produces same keys. Skill discovery + task history unchanged."
  run_diffstat src/core/controller/ui/
  echo ""
  run_diff src/core/controller/ui/
}

cat5() {
  print_header 5 "God Classes: hook-factory, checkpoints, ignore, slash-commands" \
    "hook-factory 1014→333, checkpoints 929→343, DiracIgnoreController 366→108, slash-commands 278→46" \
    "Hook lifecycle ordering preserved. Diff/restore/storage unchanged. Pattern matching semantics identical. All command types dispatched."
  echo -e "${BOLD}--- hook-factory ---${NC}"
  run_diffstat src/core/hooks/
  echo -e "${BOLD}--- checkpoints ---${NC}"
  run_diffstat src/integrations/checkpoints/
  echo -e "${BOLD}--- ignore ---${NC}"
  run_diffstat src/core/ignore/
  echo -e "${BOLD}--- slash-commands ---${NC}"
  run_diffstat src/core/slash-commands/
  echo ""
  echo -e "${BOLD}=== Full diffs ===${NC}"
  echo -e "\n${BOLD}--- hook-factory ---${NC}"
  run_diff src/core/hooks/
  echo -e "\n${BOLD}--- checkpoints ---${NC}"
  run_diff src/integrations/checkpoints/
  echo -e "\n${BOLD}--- ignore ---${NC}"
  run_diff src/core/ignore/
  echo -e "\n${BOLD}--- slash-commands ---${NC}"
  run_diff src/core/slash-commands/
}

cat6() {
  print_header 6 "God Class: disk.ts barrel + storage (658→58)" \
    "export const pattern (fixes sinon stub regression). StateManager + StatePersistenceManager." \
    "Every function still importable from same path. export const (not re-export) is intentional. dispose() added."
  run_diffstat src/core/storage/ src/shared/storage/
  echo ""
  run_diff src/core/storage/ src/shared/storage/
}

cat7() {
  print_header 7 "API Providers + Transform Layer" \
    "13 provider handlers typed. 6 transform formats. All as-any casts eliminated." \
    "No behavioral change to streaming. Type guards narrow correctly. Bedrock config consolidation. dify abort, copilot debug logging."
  run_diffstat src/core/api/
  echo ""
  run_diff src/core/api/
}

cat8() {
  print_header 8 "Task System + Tools" \
    "Task decomposition, SurfaceAdapter, EditFileTool split, ToolExecutorCoordinator" \
    "Task loop unchanged. IToolEnvironment contract respected. Tools don't import each other. SurfaceAdapter 14 traits delegate. EditFileValidator error messages preserved."
  run_diffstat src/core/task/ src/core/task/tools/adapters/ src/core/task/tools/modules/
  echo ""
  run_diff src/core/task/ src/core/task/tools/adapters/ src/core/task/tools/modules/
}

cat9() {
  print_header 9 "Services (banner, browser, terminal, error, search)" \
    "BannerService 448→133, BrowserSession 602→260, StandaloneTerminalManager 618→297, new services" \
    "BannerService clearTimeout in finally. BrowserSession connection lifecycle. Terminal process delegation. OAuthFlowHandler server ref + timeout."
  run_diffstat src/services/banner/ src/services/browser/ src/services/error/ src/services/search/ src/services/glob/ src/services/ripgrep/ src/services/tree-sitter/ src/services/uri/ src/integrations/terminal/
  echo ""
  run_diff src/services/banner/ src/services/browser/ src/services/error/ src/services/search/ src/services/glob/ src/services/ripgrep/ src/services/tree-sitter/ src/services/uri/ src/integrations/terminal/
}

cat10() {
  print_header 10 "Hosts (VS Code terminal, editor, hostbridge)" \
    "VscodeTerminalManager decomposed, VscodeCommandExecutor new, editor managers, hostbridge gRPC" \
    "shellIntegration augmentation in src/types/vscode.d.ts. CommandExecutor wait/run logic. Editor diff lifecycle. gRPC error logging."
  run_diffstat src/hosts/ src/standalone/
  echo ""
  run_diff src/hosts/ src/standalone/
}

cat11() {
  print_header 11 "Renames + Control Flow Flattening" \
    "8 vague names renamed, 8 functions flattened (depth 5-9 → 2-3)" \
    "Renames: old name gone, new name intent-encoding. Flattening: guard clauses preserve all branches, no early return skips side effect."
  echo -e "${BOLD}--- Renames (commit-level) ---${NC}"
  git log -p "$BASE..$HEAD" -- src/core/ignore/DiracIgnoreController.ts src/core/task/tools/modules/WriteToFileTool.ts src/core/task/tools/modules/ReplaceSymbolTool.ts src/core/task/tools/modules/BrowserActionTool.ts src/core/task/tools/ToolExecutorCoordinator.ts src/hosts/vscode/hostbridge/ 2>/dev/null | head -500
  echo -e "\n${BOLD}--- Flattening ---${NC}"
  run_diffstat src/core/mentions/ src/core/slash-commands/ src/core/controller/file/searchFiles.ts src/core/controller/worktree/ src/core/api/providers/minimax.ts
  echo ""
  run_diff src/core/mentions/ src/core/slash-commands/ src/core/controller/file/searchFiles.ts src/core/controller/worktree/ src/core/api/providers/minimax.ts
}

cat12() {
  print_header 12 "Tests (75 new files, 1373 it() calls)" \
    "New test files, placeholder→it.skip conversions, test correctness fixes" \
    "Tests assert actual behavior (not expect(true)). Mocks stub the right thing. Test names match assertions. Bug-characterization tests labeled."
  echo -e "${BOLD}--- New test files ---${NC}"
  git diff --diff-filter=A --name-only "$BASE..$HEAD" | grep -E "\.test\.ts$|__tests__" || true
  echo ""
  echo -e "${BOLD}--- Test correctness fixes ---${NC}"
  run_diffstat src/core/controller/__tests__/Controller.auth.test.ts src/core/task/tools/adapters/__tests__/SurfaceAdapter.test.ts src/core/api/transform/__tests__/openrouter-stream.test.ts src/core/task/tools/modules/edit_file/__tests__/EditFileTool.json-parse.test.ts
  echo ""
  run_diff src/core/controller/__tests__/Controller.auth.test.ts src/core/task/tools/adapters/__tests__/SurfaceAdapter.test.ts src/core/api/transform/__tests__/openrouter-stream.test.ts src/core/task/tools/modules/edit_file/__tests__/EditFileTool.json-parse.test.ts
}

cat13() {
  print_header 13 "Config + Build + Dead Code Removal" \
    "tsconfig changes, sharp removed, transpileOnly reverted, deleted duplicates, vscode.d.ts" \
    "transpileOnly removal intentional. files:true loads ambient .d.ts. sharp unused. Deleted files had 0 refs. vscode.d.ts augments @types/vscode@1.84.0."
  run_diffstat tsconfig.json tsconfig.unit-test.json package.json scripts/ src/core/prompts/responses.ts src/core/prompts/tool-examples.ts src/types/vscode.d.ts
  echo ""
  run_diff tsconfig.json tsconfig.unit-test.json package.json scripts/ src/core/prompts/responses.ts src/core/prompts/tool-examples.ts src/types/vscode.d.ts
}

verify() {
  print_header "V" "Verification" \
    "Run tsc, lint, and tests to confirm the refactor is clean" \
    "All should pass at the stated baseline"
  echo -e "${BOLD}--- tsc ---${NC}"
  npx tsc --noEmit 2>&1 | tail -5
  echo -e "\n${BOLD}--- lint ---${NC}"
  npm run lint 2>&1 | tail -5
  echo -e "\n${BOLD}--- tests (may take a few minutes) ---${NC}"
  npm run test:unit 2>&1 | grep -E "passing|failing|pending" | tail -5
}

docs() {
  print_header "D" "REFACTORING-DOCS.md" \
    "Full breakdown with phase table, god class table, and Mermaid diagrams" \
    "Use this as the reference after reviewing all categories"
  cat REFACTORING-DOCS.md | less
}

CATEGORIES=(
  "1|Shared Utilities & DRY Extractions|cat1"
  "2|TelemetryService decomposition (2252→266)|cat2"
  "3|Controller.ts decomposition (843→240)|cat3"
  "4|UiController + assemblers (226→62)|cat4"
  "5|hook-factory + checkpoints + ignore + slash-commands|cat5"
  "6|disk.ts barrel + storage (658→58)|cat6"
  "7|API providers + transform layer|cat7"
  "8|Task system + tools|cat8"
  "9|Services (banner, browser, terminal, error, search)|cat9"
  "10|Hosts (VS Code terminal, editor, hostbridge)|cat10"
  "11|Renames + control flow flattening|cat11"
  "12|Tests (75 new files, correctness fixes)|cat12"
  "13|Config + build + dead code removal|cat13"
  "V|Verification (tsc + lint + tests)|verify"
  "D|REFACTORING-DOCS.md (full reference)|docs"
)

list_categories() {
  echo -e "${BOLD}Review categories for PR #125 (alsa/major-refactor)${NC}"
  echo -e "Base: ${YELLOW}$BASE${NC}  Head: ${YELLOW}$HEAD${NC}"
  echo ""
  for cat in "${CATEGORIES[@]}"; do
    IFS='|' read -r num desc func <<< "$cat"
    printf "  ${GREEN}%-3s${NC} %s\n" "$num" "$desc"
  done
  echo ""
  echo -e "  ${BOLD}Usage:${NC} $0 [number|all|list]"
}

run_category() {
  local target="$1"
  for cat in "${CATEGORIES[@]}"; do
    IFS='|' read -r num desc func <<< "$cat"
    if [[ "$num" == "$target" ]]; then
      $func
      return 0
    fi
  done
  echo -e "${RED}Unknown category: $target${NC}"
  list_categories
  return 1
}

# Main
if [[ $# -eq 0 ]]; then
  list_categories
  echo ""
  read -rp "Enter category number (or 'all' or 'q' to quit): " choice
  if [[ "$choice" == "q" || "$choice" == "quit" ]]; then
    exit 0
  elif [[ "$choice" == "all" ]]; then
    for cat in "${CATEGORIES[@]}"; do
      IFS='|' read -r num desc func <<< "$cat"
      $func
      echo ""
      read -rp "Press Enter to continue to next category (or Ctrl-C to stop)..."
    done
  else
    run_category "$choice"
  fi
elif [[ "$1" == "list" ]]; then
  list_categories
elif [[ "$1" == "all" ]]; then
  for cat in "${CATEGORIES[@]}"; do
    IFS='|' read -r num desc func <<< "$cat"
    $func
    echo ""
  done
else
  run_category "$1"
fi
