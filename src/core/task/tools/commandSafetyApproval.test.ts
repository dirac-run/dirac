import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon, { type SinonStub } from "sinon"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController"
import { AutoApprove, resolveCommandApproval } from "./autoApprove"

// Classify strings only: none of these candidate commands are executed.
const requiresApproval = [
	"! find . -type f",
	"find . -type f | ! cat",
	"find . ! -delete",
	"find . ! -exec touch marker ';'",
	"find . ! -name *.ts",
	'find . ! -name "$PATTERN"',
	"find . ! -name '*.ts' > files.txt",
	"git blame --textconv HEAD -- file.ts",
	"git blame --output=marker file.ts",
	"git -c core.pager=program blame file.ts",
	"git ls-files --output=marker",
	"git ls-files --config=program",
	"git ls-files *.ts",
	"git ls-tree --output=marker HEAD",
	"git ls-tree --name-on HEAD",
	"git rev-parse --config=program HEAD",
	"git rev-parse --show-top",
	'git rev-parse "$(touch marker)"',
	"rg -n --pre=program pattern src/",
	"rg --config=local-config pattern src/",
	"rg --output=marker pattern src/",
	"rg -nz pattern src/",
	"rg -g*.ts pattern src/",
	"rg -nA2 pattern src/ > matches.txt",
	"python3 -c 'print(1)'",
	"node -e 'console.log(1)'",
	"npm test",
	"bash -c 'ls'",
	"powershell -Command Get-ChildItem",
	"cmd /c dir",
	"awk 'BEGIN { system(\"touch /tmp/file\") }'",
	"sed 'w /tmp/file' input.txt",
	"sed '1e touch /tmp/file' input.txt",
	"git diff --output=/tmp/file",
	"git diff --ext-diff",
	"git show --textconv HEAD:file",
	"find . -fprint /tmp/file",
	"find . '-exec' touch /tmp/file ';'",
	"rg --pre=program pattern",
	"rg --hostname-bin=program pattern",
	"sort --compress-program=program input.txt",
	"uniq input.txt /tmp/file",
	"uniq input.txt -c",
	"uniq - -c",
	"file -C magic",
	"date -s 2020-01-01",
	"hostname new-host",
	"ls & touch /tmp/file",
	"ls & pwd",
	"sort $OPTIONS",
	'git diff "$OPTIONS"',
	"ls $UNSET_VARIABLE",
	"ls ${UNSET_VARIABLE}",
	"ls # comment",
	"ls *",
	"(ls)",
	"ls ||",
	"ls ;; pwd",
	"ls\\\npwd",
	"'ls arbitrary'",
	"'' ls",
	"ls 2>/dev/null.backup",
	"ls 2>&10",
	'git diff --out"put"=/tmp/file',
]

const safeReads = [
	"find . -type f ! -path './node_modules/*' -print | head -20",
	"find . ! -name '*.test.ts' -a ! -name '*.spec.ts'",
	"git blame -L 1,20 -- src/index.ts",
	"git blame --no-textconv --line-porcelain HEAD -- src/index.ts | head -40",
	"git ls-files --cached --others --exclude-standard",
	"git ls-files -z --stage -- '*.ts'",
	"git ls-tree -r --name-only HEAD -- src/",
	"git rev-parse --show-toplevel",
	"git rev-parse --abbrev-ref HEAD",
	"git rev-parse --verify --short=12 HEAD",
	"rg -nC3 -g'*.ts' -g'!*.test.ts' pattern src/ | head -40",
	"rg -C 3 -m 10 -tpy -e'foo|bar' src/",
	"rg --context=3 --max-columns 160 --threads=2 pattern src/",
	"nl -ba src/index.ts | sed -n '1,20p'",
	"@backend:git ls-files --cached",
]

describe("command safety approval integration", () => {
	let platformStub: SinonStub
	beforeEach(() => {
		platformStub = sinon.stub(process, "platform").value("linux")
	})
	afterEach(() => sinon.restore())

	for (const child of [false, true]) {
		function approvalContext(executeCommands = true) {
			const settings = structuredClone(SETTINGS_DEFAULTS) as Settings
			settings.yoloModeToggled = false
			settings.autoApproveAllToggled = false
			settings.userApprovedCommands = []
			settings.autoApprovalSettings.actions.executeCommands = executeCommands
			const permissions = new CommandPermissionController(undefined)
			return { settings, permissions, approval: new AutoApprove(permissions, settings, false, child) }
		}

		for (const platform of ["win32", "unknown"]) {
			it(`${child ? "child" : "main"} requires approval on ${platform} despite safe-read and explicit-command settings`, () => {
				const { settings, permissions, approval } = approvalContext()
				settings.userApprovedCommands = [{ command: "echo", match: "prefix" }]
				platformStub.value(platform)
				for (const command of ["ls", "git status", "echo %VAR%", "echo !VAR!", "echo ^&", "echo $env:VAR"]) {
					assert.equal(approval.isCommandAutoApproved(command), false)
					for (const utilityEnabled of [false, true]) {
						assert.deepEqual(resolveCommandApproval([command], utilityEnabled, approval, permissions), {
							required: true,
							utilityEligible: true,
						})
					}
				}
			})
		}

		for (const unrestrictedSetting of ["yoloModeToggled", "autoApproveAllToggled"] as const) {
			it(`${child ? "child" : "main"} preserves intentional ${unrestrictedSetting} semantics on Windows`, () => {
				const { settings, permissions, approval } = approvalContext()
				settings[unrestrictedSetting] = true
				platformStub.value("win32")
				for (const utilityEnabled of [false, true]) {
					assert.deepEqual(resolveCommandApproval(["echo %VAR%"], utilityEnabled, approval, permissions), {
						required: child,
						utilityEligible: child,
					})
				}
			})
		}

		for (const command of requiresApproval) {
			it(`${child ? "child" : "main"} requires approval for ${JSON.stringify(command)}`, () => {
				const { permissions, approval } = approvalContext()
				assert.equal(approval.isCommandAutoApproved(command), false)
				for (const utilityEnabled of [false, true]) {
					assert.deepEqual(resolveCommandApproval([command], utilityEnabled, approval, permissions), {
						required: true,
						utilityEligible: true,
					})
				}
			})
		}
		for (const command of safeReads) {
			for (const executeCommands of [false, true]) {
				it(`${child ? "child" : "main"} classifies ${JSON.stringify(command)} with safe reads ${executeCommands ? "enabled" : "disabled"}`, () => {
					const { permissions, approval } = approvalContext(executeCommands)
					for (const utilityEnabled of [false, true]) {
						assert.deepEqual(resolveCommandApproval([command], utilityEnabled, approval, permissions), {
							required: !child && !executeCommands,
							utilityEligible: !child && !executeCommands,
						})
					}
				})
			}
		}

		it(`${child ? "child" : "main"} preserves ordinary reads and workspace normalization`, () => {
			const { permissions, approval } = approvalContext()
			assert.deepEqual(
				resolveCommandApproval(
					[
						"ls -la",
						"@backend:git status",
						"git log -5 --oneline",
						"find . -name '*.ts'",
						"nl -ba src/index.ts | sed -n '1,20p'",
					],
					false,
					approval,
					permissions,
				),
				{ required: false, utilityEligible: false },
			)
		})

		it(`${child ? "child" : "main"} preserves explicit user approval mixed with safe reads`, () => {
			const { settings, permissions, approval } = approvalContext()
			settings.userApprovedCommands = [{ command: "npm test", match: "prefix" }]
			assert.deepEqual(resolveCommandApproval(["pwd && npm test -- --runInBand 2>&1"], false, approval, permissions), {
				required: false,
				utilityEligible: false,
			})
		})

		it(`${child ? "child" : "main"} respects its safe-read setting`, () => {
			const { permissions, approval } = approvalContext(false)
			assert.deepEqual(resolveCommandApproval(["ls"], false, approval, permissions), {
				required: !child,
				utilityEligible: !child,
			})
		})
	}
})
