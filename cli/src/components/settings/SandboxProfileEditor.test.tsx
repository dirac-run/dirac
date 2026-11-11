// biome-ignore lint/correctness/noUnusedImports: CLI uses the classic JSX runtime.
import React from "react"
import type { Key } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveSandboxProfile, DEFAULT_SANDBOX_SETTINGS } from "@shared/SandboxSettings"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "@shared/settings-presentation"
import { SandboxProfileEditor } from "./SandboxProfileEditor"

const mocks = vi.hoisted(() => ({ input: undefined as ((text: string, key: Key) => void) | undefined, columns: 100, rows: 60 }))
vi.mock("ink", async (original) => ({
	...(await original<typeof import("ink")>()),
	useInput: (callback: typeof mocks.input) => {
		mocks.input = callback
	},
}))
vi.mock("../../hooks/useTerminalSize", () => ({ useTerminalSize: () => ({ columns: mocks.columns, rows: mocks.rows }) }))
const views: ReturnType<typeof render>[] = []
beforeEach(() => {
	mocks.columns = 100
	mocks.rows = 60
})
afterEach(() => {
	for (const view of views.splice(0)) view.unmount()
})
async function press(text = "", key: Partial<Key> = {}) {
	mocks.input!(text, key as Key)
	await new Promise((resolve) => setTimeout(resolve, 25))
}
async function focus(view: ReturnType<typeof render>, label: string) {
	for (let i = 0; i < 40; i++) {
		if (view.lastFrame()?.includes(`❯ ${label}`)) return
		await press("", { downArrow: true })
	}
	throw new Error(`Could not focus ${label}: ${view.lastFrame()}`)
}
function mount(props: Partial<Parameters<typeof SandboxProfileEditor>[0]> = {}) {
	const save = vi.fn().mockResolvedValue(undefined),
		cancel = vi.fn()
	const view = render(<SandboxProfileEditor onSave={save} onCancel={cancel} {...props} />)
	views.push(view)
	return { view, save, cancel }
}

describe("CLI flat sandbox profile drafts", () => {
	it("shows capability-local radio choices, not grouped pages or a universal column header", () => {
		const { view } = mount()
		const frame = view.lastFrame()!
		expect(frame).toContain("Workspace  ○ Read-only  ◉ Read & write")
		expect(frame).toContain("Other host files  ◉ Blocked  ○ Read-only")
		expect(frame).toContain("Network  ○ Blocked  ◉ Allowed")
		expect(frame).not.toContain("Package caches")
		expect(frame).not.toContain("Filesystem base")
		expect(frame).not.toContain("AF_UNIX")
		expect(frame).not.toContain("Identity")
	})
	it("uses arrows to focus and change capabilities, with no persistence until Save", async () => {
		const { view, save } = mount()
		await press("", { return: true })
		await press("Offline")
		await press("", { return: true })
		await press("", { downArrow: true })
		await press("", { leftArrow: true })
		await focus(view, "Network")
		await press("", { leftArrow: true })
		expect(save).not.toHaveBeenCalled()
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save).toHaveBeenCalledOnce()
		expect(save.mock.calls[0][0]).toMatchObject({
			name: "Offline",
			filesystem: { base: "selected", workspace: "read-only" },
			network: "deny",
		})
	})
	it("offers help only on demand and Esc cancels without saving", async () => {
		const { view, save, cancel } = mount()
		await focus(view, "Network")
		await press("?")
		expect(view.lastFrame()).toContain("AF_UNIX")
		await press("", { escape: true })
		expect(view.lastFrame()).not.toContain("AF_UNIX")
		expect(cancel).not.toHaveBeenCalled()
		await press("", { escape: true })
		expect(cancel).toHaveBeenCalledOnce()
		expect(save).not.toHaveBeenCalled()
	})
	it("discards an active text edit without discarding the draft", async () => {
		const { view, save, cancel } = mount()
		await press("", { return: true })
		await press("discard me")
		await press("", { escape: true })
		await press("", { return: true })
		expect(view.lastFrame()).not.toContain("discard me")
		await press("Kept")
		await press("", { return: true })
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save.mock.calls[0][0].name).toBe("Kept")
		expect(cancel).not.toHaveBeenCalled()
	})
	it("adds folder rows, changes their permissions and removes grants", async () => {
		const { view, save } = mount()
		await focus(view, "Add folder")
		await press("", { return: true })
		await press("~/docs")
		await press("", { return: true })
		// The inserted row occupies the previously focused Add folder position.
		expect(view.lastFrame()).toContain("❯ ~/docs")
		await press("", { rightArrow: true })
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save.mock.calls[0][0].filesystem).toMatchObject({ readable: [], writable: ["~/docs"], blocked: [] })
		const second = mount({ profile: save.mock.calls[0][0] })
		await focus(second.view, "Remove ~/docs")
		await press("", { return: true })
		await focus(second.view, "Save profile")
		await press("", { return: true })
		expect(second.save.mock.calls[0][0].filesystem.writable).toEqual([])
	})
	it("keeps configured exact cache directories across off/on without granting home", async () => {
		const profile = sandboxProfileFromDraft(
			{ ...sandboxProfileDraft(), name: "Build", caches: "~/.npm\n~/.cache/pip" },
			"build",
			2,
		)
		const { view, save } = mount({ profile })
		await focus(view, "Package caches")
		await press("", { leftArrow: true })
		await press("", { rightArrow: true })
		await press("", { return: true })
		expect(view.lastFrame()).toContain("~/.npm")
		expect(view.lastFrame()).toContain("~/.cache/pip")
		await press("", { escape: true })
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save.mock.calls[0][0].filesystem.caches).toEqual(["~/.npm", "~/.cache/pip"])
	})
	it("keeps the focused folder selected when access changes reorder the persisted grants", async () => {
		const profile = sandboxProfileFromDraft(
			{ ...sandboxProfileDraft(), name: "Folders", readable: "~/first\n~/second" },
			"folders",
			1,
		)
		const { view, save } = mount({ profile })
		await focus(view, "~/first")
		await press("", { rightArrow: true })
		expect(view.lastFrame()).toContain("❯ ~/first")
		await press("", { upArrow: true })
		await press("", { downArrow: true })
		expect(view.lastFrame()).toContain("❯ ~/first")
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save.mock.calls[0][0].filesystem).toMatchObject({ readable: ["~/second"], writable: ["~/first"] })
	})
	it("duplicates policies losslessly and customizes immutable builtins into distinct copies", async () => {
		const profile = sandboxProfileFromDraft(
			{ ...sandboxProfileDraft(), name: "Build", overrides: "MODE= spaced value ", readable: "/path with trailing space " },
			"build",
			5,
		)
		const first = mount({ profile, duplicate: true })
		await focus(first.view, "Save profile")
		await press("", { return: true })
		const copy = first.save.mock.calls[0][0]
		expect(copy.id).not.toBe(profile.id)
		expect(copy).toEqual({ ...profile, id: copy.id, revision: 1, name: "Build copy" })
		const builtin = resolveSandboxProfile(DEFAULT_SANDBOX_SETTINGS, "builtin-workspace")
		if (!("kind" in builtin)) throw new Error("Expected builtin policy")
		const second = mount({ profile: builtin, duplicate: true })
		await focus(second.view, "Save profile")
		await press("", { return: true })
		expect(second.save.mock.calls[0][0]).toMatchObject({
			name: "Workspace copy",
			revision: 1,
			filesystem: builtin.filesystem,
		})
		expect(second.save.mock.calls[0][0].id).not.toBe(builtin.id)
		expect(Object.isFrozen(builtin)).toBe(true)
	})
	it("preserves optional advanced fields and supports multiline editing", async () => {
		const profile = sandboxProfileFromDraft(
			{ ...sandboxProfileDraft(), name: "Build", temporaryDirectory: "/private-tmp", overrides: "MODE=old" },
			"build",
			3,
		)
		const { view, save } = mount({ profile })
		await focus(view, "▸ Advanced")
		await press("", { return: true })
		await focus(view, "Environment overrides")
		await press("", { return: true })
		await press("", { tab: true })
		await press("OTHER=new")
		await press("", { return: true })
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(save.mock.calls[0][0]).toMatchObject({
			temporaryDirectory: "/private-tmp",
			environment: { overrides: { MODE: "old", OTHER: "new" } },
		})
	})
	it("wraps radio options beneath labels on narrow terminals and keeps focus visible", async () => {
		mocks.columns = 38
		mocks.rows = 20
		const { view } = mount()
		expect(view.lastFrame()).toMatch(/Workspace\n\s+○ Read-only/)
		await focus(view, "Save profile")
		expect(view.lastFrame()).toContain("❯ Save profile")
		expect(view.lastFrame()).toContain("more above")
	})
	it("shows save errors and remains cancellable", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("Invalid profile"))
		const { view, cancel } = mount({ onSave })
		await focus(view, "Save profile")
		await press("", { return: true })
		expect(view.lastFrame()).toContain("Invalid profile")
		await press("", { escape: true })
		expect(cancel).toHaveBeenCalledOnce()
	})
})
