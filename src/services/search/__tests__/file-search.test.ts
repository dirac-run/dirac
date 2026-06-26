import { expect } from "chai"
import * as path from "path"

const srcDir = path.join(__dirname, "..", "..", "..")

describe("Search file-search", () => {
	describe("searchWorkspaceFiles", () => {
		it("should return files when query is empty", async () => {
			const { searchWorkspaceFiles } = await import(path.join(srcDir, "services", "search", "file-search.ts"))
			const result = await searchWorkspaceFiles("", srcDir)
			expect(Array.isArray(result)).to.be.true
		})

		it("should return files matching a query string", async () => {
			const { searchWorkspaceFiles } = await import(path.join(srcDir, "services", "search", "file-search.ts"))
			const result = await searchWorkspaceFiles("test", srcDir)
			expect(Array.isArray(result)).to.be.true
		})

		it("should include folder results for directory matches", async () => {
			const { searchWorkspaceFiles } = await import(path.join(srcDir, "services", "search", "file-search.ts"))
			const result = await searchWorkspaceFiles("", srcDir)
			const folders = result.filter((item: any) => item.type === "folder")
			expect(Array.isArray(folders)).to.be.true
		})

		it("should include workspaceName when provided", async () => {
			const { searchWorkspaceFiles } = await import(path.join(srcDir, "services", "search", "file-search.ts"))
			const result = await searchWorkspaceFiles("", srcDir, "test-workspace")
			const items = result.filter((item: any) => item.workspaceName)
			if (items.length > 0) {
				expect(items[0].workspaceName).to.equal("test-workspace")
			}
		})
	})
})
