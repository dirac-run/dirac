/**
 * Tests for SkillsPanelContent component
 *
 * Tests keyboard interactions and callbacks.
 * Rendering tests are limited due to ink-testing-library constraints with nested components.
 *
 * NOTE: stdin.write() from ink-testing-library v4 does not reach useInput handlers in ink v7
 * because ink v7 routes input through an internal_eventEmitter that the testing library does
 * not populate. Instead, we capture the useInput handler via a vi.mock of ink and invoke it
 * directly in tests.
 */

import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: React must be in scope for JSX in this test file.
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Capture the useInput handler so tests can invoke it directly.
// Must be hoisted before any import that uses ink.
type InputHandler = (input: string, key: import("ink").Key) => void
const capturedInput = vi.hoisted(() => ({
	handler: null as InputHandler | null,
	options: null as { isActive?: boolean } | null,
}))

// Mock refreshSkills
const mockRefreshSkills = vi.fn()
vi.mock("@/core/controller/file/refreshSkills", () => ({
	refreshSkills: () => mockRefreshSkills(),
}))

// Mock toggleSkill
const mockToggleSkill = vi.fn()
vi.mock("@/core/controller/file/toggleSkill", () => ({
	toggleSkill: (...args: unknown[]) => mockToggleSkill(...args),
}))

// Mock child_process exec
const mockExec = vi.fn()
vi.mock("node:child_process", () => ({
	exec: (...args: unknown[]) => mockExec(...args),
}))

// Mock StdinContext
vi.mock("../context/StdinContext", () => ({
	useStdinContext: () => ({ isRawModeSupported: true }),
}))

// Mock ink's useInput to capture the handler instead of relying on stdin plumbing.
// ink v7 routes input through internal_eventEmitter which ink-testing-library v4 does not feed.
vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useInput: (handler: InputHandler, options?: { isActive?: boolean }) => {
			capturedInput.handler = handler
			capturedInput.options = options ?? null
		},
	}
})

import { SkillsPanelContent } from "./SkillsPanelContent"

// Helper to wait for async state updates
const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

// Simulate a keypress by invoking the captured useInput handler directly.
// key names mirror the Key interface in ink.
function pressKey(input: string, keyOverrides: Partial<import("ink").Key> = {}) {
	if (!capturedInput.handler) throw new Error("useInput handler not yet registered")
	const key: import("ink").Key = {
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		...keyOverrides,
	}
	capturedInput.handler(input, key)
}

describe("SkillsPanelContent", () => {
	const mockController = {} as any
	const mockOnClose = vi.fn()
	const mockOnUseSkill = vi.fn()

	const defaultProps = {
		controller: mockController,
		onClose: mockOnClose,
		onUseSkill: mockOnUseSkill,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		capturedInput.handler = null
		capturedInput.options = null
		mockRefreshSkills.mockResolvedValue({
			globalSkills: [],
			localSkills: [],
		})
	})

	describe("keyboard interactions", () => {
		it("should call onClose when Escape is pressed", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			pressKey("", { escape: true })
			await delay()

			expect(mockOnClose).toHaveBeenCalled()
		})

		it("should call onUseSkill with skill path when Enter is pressed on a skill", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [{ name: "test-skill", description: "Test", path: "/test/path/SKILL.md", enabled: true }],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			pressKey("", { return: true })
			await delay()

			expect(mockOnUseSkill).toHaveBeenCalledWith("/test/path/SKILL.md")
		})

		it("should call toggleSkill when Space is pressed on a skill", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [{ name: "test-skill", description: "Test", path: "/test/path/SKILL.md", enabled: true }],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			pressKey(" ")
			await delay()

			expect(mockToggleSkill).toHaveBeenCalledWith(
				mockController,
				expect.objectContaining({
					skillPath: "/test/path/SKILL.md",
					isGlobal: true,
					enabled: false, // toggled from true to false
				}),
			)
		})

		it("should open marketplace URL when Enter is pressed on marketplace item", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [{ name: "skill", description: "desc", path: "/path", enabled: true }],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			// Navigate down to marketplace (past the one skill)
			pressKey("", { downArrow: true })
			await delay()

			pressKey("", { return: true })
			await delay()

			// Should have called exec with open command
			expect(mockExec).toHaveBeenCalled()
			const execCall = mockExec.mock.calls[0][0]
			expect(execCall).toContain("https://skills.sh/")
		})

		it("should navigate through skills with arrow keys", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [
					{ name: "skill-1", description: "First", path: "/path1", enabled: true },
					{ name: "skill-2", description: "Second", path: "/path2", enabled: true },
				],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			// Navigate down
			pressKey("", { downArrow: true })
			await delay()

			// Press Enter - should use second skill
			pressKey("", { return: true })
			await delay()

			expect(mockOnUseSkill).toHaveBeenCalledWith("/path2")
		})

		it("should navigate with vim keys (j/k)", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [
					{ name: "skill-1", description: "First", path: "/path1", enabled: true },
					{ name: "skill-2", description: "Second", path: "/path2", enabled: true },
				],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			// Navigate down with j
			pressKey("j")
			await delay()

			// Press Enter - should use second skill
			pressKey("", { return: true })
			await delay()

			expect(mockOnUseSkill).toHaveBeenCalledWith("/path2")
		})

		it("should revert optimistic toggle on failure", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [{ name: "test-skill", description: "Test", path: "/test/path/SKILL.md", enabled: true }],
				localSkills: [],
			})
			mockToggleSkill.mockRejectedValueOnce(new Error("toggle failed"))

			const { lastFrame } = render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			pressKey(" ") // Space to toggle
			await delay(100)

			// toggleSkill was called with enabled: false (toggled from true)
			expect(mockToggleSkill).toHaveBeenCalledWith(mockController, expect.objectContaining({ enabled: false }))
			const frame = lastFrame() || ""
			expect(frame).toContain("● test-skill")
			expect(frame).not.toContain("○ test-skill")
		})

		it("should wrap navigation at list boundaries", async () => {
			mockRefreshSkills.mockResolvedValue({
				globalSkills: [{ name: "only-skill", description: "Only", path: "/only", enabled: true }],
				localSkills: [],
			})

			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			// Navigate up from first item (should wrap to last - marketplace)
			pressKey("", { upArrow: true })
			await delay()

			pressKey("", { return: true })
			await delay()

			// Should have opened marketplace (wrapped to last item)
			expect(mockExec).toHaveBeenCalled()
		})
	})

	describe("skill loading", () => {
		it("should call refreshSkills on mount", async () => {
			render(<SkillsPanelContent {...defaultProps} />)
			await delay()

			expect(mockRefreshSkills).toHaveBeenCalled()
		})
	})
})
