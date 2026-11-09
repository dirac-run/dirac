import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { describe, it } from "mocha"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController"
import { AutoApprove, resolveCommandApproval } from "./autoApprove"

// Classify strings only: none of these candidate commands are executed.
const requiresApproval = [
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

describe("command safety approval integration", () => {
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
