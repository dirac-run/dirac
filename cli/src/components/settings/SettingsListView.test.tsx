// biome-ignore lint/correctness/noUnusedImports: CLI uses the classic JSX runtime.
import React from "react"
import { Box } from "ink"
import { render } from "ink-testing-library"
import { describe, expect, it } from "vitest"
import { estimateItemRows, SettingsListView } from "./SettingsListView"
import { createSandboxSettingsItems } from "./sandboxSettingsItems"
import { SettingsItemType } from "./types"
import { SandboxProfileEditor } from "./SandboxProfileEditor"
import { SandboxTechnicalDetails } from "./SandboxTechnicalDetails"
import { DEFAULT_SANDBOX_SETTINGS } from "@shared/SandboxSettings"

describe("settings list row budget", () => {
	it("counts wrapped readonly text and selected contextual help at the actual width", () => {
		const item = {
			key: "note",
			label: "",
			value: "word ".repeat(30).trim(),
			type: SettingsItemType.READONLY,
			description: "help ".repeat(30).trim(),
		}
		expect(estimateItemRows(item, false, 76)).toBe(2)
		expect(estimateItemRows(item, true, 76)).toBe(5)
	})
	it("keeps the narrow sandbox viewport within its row budget", () => {
		const view = render(
			<Box width={76}>
				<SettingsListView
					items={createSandboxSettingsItems({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true })}
					selectedIndex={0}
					maxRows={8}
				/>
			</Box>,
		)
		const frame = view.lastFrame()!
		expect(frame.split("\n").length).toBeLessThanOrEqual(12)
		expect(frame).toContain("Subagents: Default (unrestricted)")
		expect(frame).not.toContain("does not provide meaningful isolation")
		expect(frame).toContain("more below")
		view.unmount()
	})
	it("keeps real profile and technical topic lists readable at 80x24", () => {
		const editor = render(
			<Box width={76}>
				<SandboxProfileEditor onSave={async () => {}} onCancel={() => {}} />
			</Box>,
		)
		expect(editor.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12)
		expect(editor.lastFrame()).toContain("Workspace  ○ Read-only  ◉ Read & write")
		editor.unmount()
		const details = createSandboxSettingsItems(
			{ ...DEFAULT_SANDBOX_SETTINGS, enabled: true },
			undefined,
			undefined,
			true,
		).find((item) => item.key === "sandboxDetails")!.expandedHelp!
		const topics = render(
			<Box width={76}>
				<SandboxTechnicalDetails details={details} onClose={() => {}} />
			</Box>,
		)
		expect(topics.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12)
		topics.unmount()
	})
})
