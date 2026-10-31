import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BooleanResponse, Empty } from "@shared/proto/dirac/common"
import { FileServiceClient } from "@/shared/api/grpc-client"
import MarkdownBlock from "./MarkdownBlock"

describe("MarkdownBlock inline code", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
	})

	it("does not reserve a file action for inline code that is not a file", async () => {
		const fileExists = vi
			.spyOn(FileServiceClient, "ifFileExistsRelativePath")
			.mockResolvedValue(BooleanResponse.create({ value: false }))
		const { container } = render(<MarkdownBlock markdown={"Validation: `diagnostics_scan` and `git diff --check` pass."} />)

		await waitFor(() => expect(fileExists).toHaveBeenCalledWith(expect.objectContaining({ value: "diagnostics_scan" })))

		expect(container.querySelector("code")).toHaveTextContent("diagnostics_scan")
		expect(container.querySelector("button")).not.toBeInTheDocument()
	})

	it("renders the file action only after the path is confirmed", async () => {
		const filePath = "src/shared/ui/MarkdownBlock.tsx"
		vi.spyOn(FileServiceClient, "ifFileExistsRelativePath").mockResolvedValue(BooleanResponse.create({ value: true }))

		render(<MarkdownBlock markdown={`Open \`${filePath}\`.`} />)

		expect(await screen.findByRole("button", { name: `Open ${filePath} in editor` })).toBeInTheDocument()
	})
})

describe("MarkdownBlock file links", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
	})

	it.each([
		["src/core/goal/GoalLoop.ts", "src/core/goal/GoalLoop.ts"],
		["./src/core/goal/GoalLoop.ts", "./src/core/goal/GoalLoop.ts"],
		["../README.md", "../README.md"],
		["README.md", "README.md"],
		["/workspace/src/GoalLoop.ts", "/workspace/src/GoalLoop.ts"],
		["docs/my%20file.md", "docs/my file.md"],
		["docs/file%23name.md", "docs/file#name.md"],
		["src/core/goal/GoalLoop.ts#L50", "src/core/goal/GoalLoop.ts"],
		["README.md?view=source#intro", "README.md"],
	])("opens %s in the editor without navigating the webview", async (href, filePath) => {
		const openFile = vi.spyOn(FileServiceClient, "openFileRelativePath").mockResolvedValue(Empty.create())
		render(<MarkdownBlock markdown={`[GoalLoop.ts](${href})`} />)

		const link = screen.getByRole("link", { name: "GoalLoop.ts" })
		expect(link).toHaveAttribute("href", href)
		expect(fireEvent.click(link)).toBe(false)
		await waitFor(() => expect(openFile).toHaveBeenCalledWith({ value: filePath }))
	})

	it.each(["https://example.com/docs", "mailto:help@example.com", "//example.com/docs", "#intro", "?view=source"])(
		"leaves non-file link %s unchanged",
		(href) => {
			const openFile = vi.spyOn(FileServiceClient, "openFileRelativePath").mockResolvedValue(Empty.create())
			render(<MarkdownBlock markdown={`[Link](${href})`} />)
			const link = screen.getByRole("link", { name: "Link" })
			expect(link).toHaveAttribute("href", href)
			// Cancel browser navigation after checking that the renderer did not intercept the click.
			let preventedByRenderer = true
			const preventNavigation = (event: MouseEvent) => {
				preventedByRenderer = event.defaultPrevented
				event.preventDefault()
			}
			document.addEventListener("click", preventNavigation, { once: true })
			fireEvent.click(link)
			expect(preventedByRenderer).toBe(false)
			expect(openFile).not.toHaveBeenCalled()
		},
	)

	it("keeps unsafe URL schemes filtered", () => {
		const openFile = vi.spyOn(FileServiceClient, "openFileRelativePath").mockResolvedValue(Empty.create())
		render(<MarkdownBlock markdown="[Unsafe](javascript:alert)" />)
		expect(screen.getByText("Unsafe")).toHaveAttribute("href", "")
		expect(openFile).not.toHaveBeenCalled()
	})

	it("does not nest a file button inside a linked code label", () => {
		const fileExists = vi.spyOn(FileServiceClient, "ifFileExistsRelativePath")
		const openFile = vi.spyOn(FileServiceClient, "openFileRelativePath").mockResolvedValue(Empty.create())
		render(<MarkdownBlock markdown="[**`GoalLoop.ts`**](src/core/goal/GoalLoop.ts)" />)

		fireEvent.click(screen.getByRole("link", { name: "GoalLoop.ts" }))
		expect(openFile).toHaveBeenCalledWith({ value: "src/core/goal/GoalLoop.ts" })
		expect(fileExists).not.toHaveBeenCalled()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})
})
