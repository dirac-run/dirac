import { CardStatus, type Card } from "@shared/ExtensionMessage"
import { render } from "ink-testing-library"
import React from "react"
import stripAnsi from "strip-ansi"
import { describe, expect, it } from "vitest"
import { PermissionModal } from "./PermissionModal"
import { calculatePermissionModalLayout } from "../utils/chat-layout"

const path = "src/features/permissions/a-long-directory-name/a-very-long-file-name-that-should-wrap-without-truncation.txt"

function renderModal(overrides: Partial<Card>, width = 90): string {
	const card: Card = {
		id: "permission",
		header: "Permission Request",
		status: CardStatus.WAITING_FOR_INPUT,
		requireApproval: true,
		renderType: "diff",
		...overrides,
	}
	const view = render(
		React.createElement(PermissionModal, {
			card,
			width,
			height: 12,
			bodyColumns: width - 6,
			bodyLines: 5,
			scrollOffset: 0,
			maxScrollOffset: 0,
		}),
	)
	const frame = stripAnsi(view.lastFrame() ?? "")
	view.unmount()
	return frame
}

describe("PermissionModal body rendering", () => {
	it.each(["create", "edit"])("left-aligns and wraps the %s description when diffs are separate", (operation) => {
		const description = `Dirac wants to ${operation}`
		const frame = renderModal({
			body: `${description} ${path}`,
			diffs: [{ path, oldText: operation === "edit" ? "old" : "", newText: "new" }],
		})
		const row = frame.split("\n").find((line) => line.includes(description))!
		expect(row.indexOf(description)).toBe(row.indexOf("│") + 2)
		expect(frame.replace(/[\s│]/g, "")).toContain(path)
		expect(frame).not.toContain("…")
		expect(frame).not.toContain("+ Dirac")
		expect(frame).toContain("approve")
		expect(frame).toContain("deny")
	})

	it.each([{ diffs: undefined }, { diffs: [] }])("preserves genuine diff bodies without separate diffs ($diffs)", ({ diffs }) => {
		const frame = renderModal({ body: "@@ -1 +1 @@\n-before\n+after", diffs }, 70)
		expect(frame).toMatch(/1\s+- before/)
		expect(frame).toMatch(/1\s+\+ after/)
	})

	it("preserves Markdown descriptions", () => {
		const frame = renderModal({ renderType: "markdown", body: "**Choose an action**", requireFeedback: true })
		expect(frame).toContain("Choose an action")
		expect(frame).not.toContain("**")
	})

	it("formats fenced bash in actionable command approval without showing delimiters", () => {
		const frame = renderModal({ renderType: "markdown", body: "```bash\nnpm run deploy\n```", requireApproval: true })
		expect(frame).toContain("npm run deploy")
		expect(frame).not.toContain("```")
		expect(frame).toContain("approve")
		expect(frame).toContain("deny")
	})

	it("renders host-provided command choices vertically with consecutive shortcuts", () => {
		const choices = [
			{ id: "approve", label: "Approve this command" },
			{ id: "allow-network", label: "Approve + allow network access for this task" },
			{ id: "allow-files", label: "Approve + allow file writes for this task" },
			{ id: "reject", label: "Reject" },
		]
		const frame = renderModal({ renderType: "text", body: "curl example.com > output", commandApprovalChoices: choices })
		for (const [index, choice] of choices.entries()) {
			expect(frame).toContain(`${index + 1} ${choice.label}`)
		}
		const rows = frame.split("\n").filter((line) => choices.some((choice) => line.includes(choice.label)))
		expect(rows).toHaveLength(4)
		expect(frame).not.toContain("deny")
	})

	it("renders unknown command approval without adding capability choices", () => {
		const frame = renderModal({
			renderType: "text",
			commandApprovalChoices: [
				{ id: "approve", label: "Approve this command" },
				{ id: "reject", label: "Reject" },
			],
		})
		expect(frame).toContain("1 Approve this command")
		expect(frame).toContain("2 Reject")
		expect(frame).not.toContain("Approve +")
	})

	it.each([[60, 24], [40, 20]])("keeps wrapped choices and Reject visible in a %i×%i terminal", (columns, rows) => {
		const commandApprovalChoices = [
			{ id: "approve", label: "Approve this command" },
			{ id: "remote", label: "Approve + allow remote_resources/mutate for this task" },
			{ id: "files", label: "Approve + allow local_files/mutate for this task" },
			{ id: "reject", label: "Reject" },
		]
		const layout = calculatePermissionModalLayout(columns, rows, commandApprovalChoices.map((choice) => choice.label))
		const view = render(<PermissionModal
			card={{
				id: "command", header: "Run command", status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true, renderType: "text", body: "command output\n".repeat(30), commandApprovalChoices
			}}
			{...layout} scrollOffset={0} maxScrollOffset={30}
		/>)
		const frame = stripAnsi(view.lastFrame() ?? "")
		expect(frame).toContain("4 Reject")
		expect(frame.split("\n")).toHaveLength(layout.height)
		expect(frame.split("\n").at(-1)).toContain("╰")
		view.unmount()
	})

	it("preserves plain text descriptions", () => {
		const frame = renderModal({ renderType: "text", body: "Allow this command?" })
		expect(frame).toContain("│ Allow this command?")
	})
})
