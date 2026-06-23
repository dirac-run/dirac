import fs from "fs/promises"
import { after, afterEach, beforeEach, describe, it } from "mocha"
import os from "os"
import path from "path"
import { DiracIgnoreController } from "../DiracIgnoreController"
import "should"

describe("DiracIgnoreController", () => {
	let tempDir: string
	let controller: DiracIgnoreController

	beforeEach(async () => {
		// Create a temp directory for testing
		tempDir = path.join(os.tmpdir(), `llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir)

		// Create default .diracignore file
		await fs.writeFile(
			path.join(tempDir, ".diracignore"),
			[".env", "*.secret", "private/", "# This is a comment", "", "temp.*", "file-with-space-at-end.* ", "**/.git/**"].join(
				"\n",
			),
		)

		controller = new DiracIgnoreController(tempDir)
		await controller.initialize()
	})

	afterEach(async () => {
		await controller.dispose().catch(() => {})
	})

	after(async () => {
		// Clean up temp directory
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	describe("Default Patterns", () => {
		it("should allow access to regular files", async () => {
			const results = [
				controller.validateAccess("src/index.ts"),
				controller.validateAccess("README.md"),
				controller.validateAccess("package.json"),
			]
			results.forEach((result) => result.should.be.true())
		})

		it("should block access to .diracignore file", async () => {
			const result = controller.validateAccess(".diracignore")
			result.should.be.false()
		})
	})

	describe("Custom Patterns", () => {
		it("should block access to custom ignored patterns", async () => {
			const results = [
				controller.validateAccess("config.secret"),
				controller.validateAccess("private/data.txt"),
				controller.validateAccess("temp.json"),
				controller.validateAccess("nested/deep/file.secret"),
				controller.validateAccess("private/nested/deep/file.txt"),
			]
			results.forEach((result) => result.should.be.false())
		})

		it("should allow access to non-ignored files", async () => {
			const results = [
				controller.validateAccess("public/data.txt"),
				controller.validateAccess("config.json"),
				controller.validateAccess("src/temp/file.ts"),
				controller.validateAccess("nested/deep/file.txt"),
				controller.validateAccess("not-private/data.txt"),
			]
			results.forEach((result) => result.should.be.true())
		})

		it("should handle pattern edge cases", async () => {
			await fs.writeFile(
				path.join(tempDir, ".diracignore"),
				["*.secret", "private/", "*.tmp", "data-*.json", "temp/*"].join("\n"),
			)

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			const results = [
				controller.validateAccess("data-123.json"), // Should be false (wildcard)
				controller.validateAccess("data.json"), // Should be true (doesn't match pattern)
				controller.validateAccess("script.tmp"), // Should be false (extension match)
			]

			results[0].should.be.false() // data-123.json
			results[1].should.be.true() // data.json
			results[2].should.be.false() // script.tmp
		})

		it("should handle comments in .diracignore", async () => {
			// Create a new .diracignore with comments
			await fs.writeFile(
				path.join(tempDir, ".diracignore"),
				["# Comment line", "*.secret", "private/", "temp.*"].join("\n"),
			)

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			const result = controller.validateAccess("test.secret")
			result.should.be.false()
		})
	})

	describe("Negation Patterns", () => {
		it("should re-allow files matched by a negation pattern", async () => {
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["temp/*", "!temp/allowed.txt"].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("temp/blocked.txt").should.be.false()
			controller.validateAccess("temp/allowed.txt").should.be.true()
		})

		it("should not re-include files under an ignored parent directory (gitignore semantics)", async () => {
			// gitignore/ignore lib: once a parent directory is excluded, nested files cannot be re-included
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["assets/", "!assets/public/"].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("assets/logo.png").should.be.false()
			controller.validateAccess("assets/public/logo.png").should.be.false()
		})

		it("should re-include a file when the parent directory is not ignored", async () => {
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["*.log", "!keep.log"].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("debug.log").should.be.false()
			controller.validateAccess("keep.log").should.be.true()
		})

		it("should handle multiple negations on markdown files", async () => {
			await fs.writeFile(
				path.join(tempDir, ".diracignore"),
				["docs/**/*.md", "!docs/README.md", "!docs/CONTRIBUTING.md"].join("\n"),
			)

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("docs/guide.md").should.be.false()
			controller.validateAccess("docs/README.md").should.be.true()
			controller.validateAccess("docs/CONTRIBUTING.md").should.be.true()
			controller.validateAccess("docs/api/guide.md").should.be.false()
		})
	})

	describe("Path Handling", () => {
		it("should handle absolute paths and match ignore patterns", async () => {
			// Test absolute path that should be allowed
			const allowedPath = path.join(tempDir, "src/file.ts")
			const allowedResult = controller.validateAccess(allowedPath)
			allowedResult.should.be.true()

			// Test absolute path that matches an ignore pattern (*.secret)
			const ignoredPath = path.join(tempDir, "config.secret")
			const ignoredResult = controller.validateAccess(ignoredPath)
			ignoredResult.should.be.false()

			// Test absolute path in ignored directory (private/)
			const ignoredDirPath = path.join(tempDir, "private/data.txt")
			const ignoredDirResult = controller.validateAccess(ignoredDirPath)
			ignoredDirResult.should.be.false()
		})

		it("should handle relative paths and match ignore patterns", async () => {
			// Test relative path that should be allowed
			const allowedResult = controller.validateAccess("./src/file.ts")
			allowedResult.should.be.true()

			// Test relative path that matches an ignore pattern (*.secret)
			const ignoredResult = controller.validateAccess("./config.secret")
			ignoredResult.should.be.false()

			// Test relative path in ignored directory (private/)
			const ignoredDirResult = controller.validateAccess("./private/data.txt")
			ignoredDirResult.should.be.false()
		})

		it("should normalize paths with backslashes", async () => {
			const result = controller.validateAccess("src\\file.ts")
			result.should.be.true()
		})
	})

	describe("Batch Filtering", () => {
		it("should filter an array of paths", async () => {
			const paths = ["src/index.ts", ".env", "lib/utils.ts", ".git/config", "dist/bundle.js"]

			const filtered = controller.filterPaths(paths)
			filtered.should.deepEqual(["src/index.ts", "lib/utils.ts"])
		})
	})

	describe("Command Validation", () => {
		it("should detect blocked file in cat command", async () => {
			controller.validateCommand("cat config.secret")!.should.equal("config.secret")
		})

		it("should allow cat on a non-ignored file", async () => {
			;(controller.validateCommand("cat src/index.ts") === undefined).should.be.true()
		})

		it("should skip flags when validating command arguments", async () => {
			// -n is a flag, the real file is src/index.ts which is allowed
			;(controller.validateCommand("head -n 5 src/index.ts") === undefined).should.be.true()
		})

		it("should skip PowerShell-style slash flags", async () => {
			;(controller.validateCommand("type /verbose src/index.ts") === undefined).should.be.true()
		})

		it("should skip PowerShell parameter names containing colon", async () => {
			;(controller.validateCommand("Get-Content -Path:src/index.ts") === undefined).should.be.true()
		})

		it("should return undefined for non-file-reading commands", async () => {
			;(controller.validateCommand("rm config.secret") === undefined).should.be.true()
		})

		it("should detect blocked file among multiple arguments", async () => {
			controller.validateCommand("cat src/index.ts config.secret")!.should.equal("config.secret")
		})
	})

	describe("Error Handling", () => {
		it("should handle invalid paths", async () => {
			// Test with an invalid path containing null byte
			const result = controller.validateAccess("\0invalid")
			result.should.be.true()
		})

		it("should handle missing .diracignore gracefully", async () => {
			// Create a new controller in a directory without .diracignore
			const emptyDir = path.join(os.tmpdir(), `llm-test-empty-${Date.now()}`)
			await fs.mkdir(emptyDir)

			try {
				const controller = new DiracIgnoreController(emptyDir)
				await controller.initialize()
				const result = controller.validateAccess("file.txt")
				result.should.be.true()
			} finally {
				await fs.rm(emptyDir, { recursive: true, force: true })
			}
		})

		it("should handle empty .diracignore", async () => {
			await fs.writeFile(path.join(tempDir, ".diracignore"), "")

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			const result = controller.validateAccess("regular-file.txt")
			result.should.be.true()
		})

		it("should expose diracIgnoreContent as undefined when no .diracignore exists", async () => {
			const emptyDir = path.join(os.tmpdir(), `llm-test-noignore-${Date.now()}`)
			await fs.mkdir(emptyDir)
			try {
				const ctrl = new DiracIgnoreController(emptyDir)
				await ctrl.initialize()
				;(ctrl.diracIgnoreContent === undefined).should.be.true()
			} finally {
				await fs.rm(emptyDir, { recursive: true, force: true })
			}
		})

		it("should expose diracIgnoreContent with file contents when .diracignore exists", async () => {
			;(controller.diracIgnoreContent === undefined).should.be.false()
		})
	})

	describe("Include Directive", () => {
		it("should load patterns from an included file", async () => {
			// Create a .gitignore file with patterns "*.log" and "debug/"
			await fs.writeFile(path.join(tempDir, ".gitignore"), ["*.log", "debug/"].join("\n"))

			// Create a .diracignore file that includes .gitignore and adds an extra pattern "secret.txt"
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["!include .gitignore", "secret.txt"].join("\n"))

			// Initialize the controller to load the updated .diracignore
			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			// "server.log" should be ignored due to the "*.log" pattern from .gitignore
			controller.validateAccess("server.log").should.be.false()
			// "debug/app.js" should be ignored due to the "debug/" pattern from .gitignore
			controller.validateAccess("debug/app.js").should.be.false()
			// "secret.txt" should be ignored as specified directly in .diracignore
			controller.validateAccess("secret.txt").should.be.false()
			// Other files should be allowed
			controller.validateAccess("app.js").should.be.true()
		})

		it("should handle non-existent included file gracefully", async () => {
			// Create a .diracignore file that includes a non-existent file
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["!include missing-file.txt"].join("\n"))

			// Initialize the controller
			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			// Validate access to a regular file; it should be allowed because the missing include should not break everything
			controller.validateAccess("regular-file.txt").should.be.true()
		})

		it("should handle non-existent included file gracefully alongside a valid pattern", async () => {
			// Test with an include directive for a non-existent file alongside a valid pattern ("*.tmp")
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["!include non-existent.txt", "*.tmp"].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			// "file.tmp" should be ignored because of the "*.tmp" pattern
			controller.validateAccess("file.tmp").should.be.false()
			// Files that do not match "*.tmp" should be allowed
			controller.validateAccess("file.log").should.be.true()
		})

		it("should resolve multiple !include directives in order", async () => {
			await fs.writeFile(path.join(tempDir, "a.ignore"), "*.log")
			await fs.writeFile(path.join(tempDir, "b.ignore"), "debug/")

			await fs.writeFile(
				path.join(tempDir, ".diracignore"),
				["!include a.ignore", "!include b.ignore", "secret.txt"].join("\n"),
			)

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("server.log").should.be.false()
			controller.validateAccess("debug/app.js").should.be.false()
			controller.validateAccess("secret.txt").should.be.false()
			controller.validateAccess("app.js").should.be.true()
		})

		it("should preserve non-include lines around include directives", async () => {
			await fs.writeFile(path.join(tempDir, "extra.ignore"), "*.log")

			await fs.writeFile(
				path.join(tempDir, ".diracignore"),
				["top-pattern.txt", "!include extra.ignore", "bottom-pattern.txt"].join("\n"),
			)

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("top-pattern.txt").should.be.false()
			controller.validateAccess("server.log").should.be.false()
			controller.validateAccess("bottom-pattern.txt").should.be.false()
			controller.validateAccess("app.js").should.be.true()
		})

		it("should ignore !include directive without trailing space", async () => {
			// The parser only treats "!include " (with space) as a directive; a bare "!include" is a pattern
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["!include", "*.tmp"].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("file.tmp").should.be.false()
		})

		it("should handle !include directive with extra whitespace around filename", async () => {
			await fs.writeFile(path.join(tempDir, "extra.ignore"), "*.log")
			await fs.writeFile(path.join(tempDir, ".diracignore"), ["!include   extra.ignore   "].join("\n"))

			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			controller.validateAccess("server.log").should.be.false()
		})
	})

	describe("YOLO Mode", () => {
		it("should waive all restrictions when yoloMode is enabled", async () => {
			// Setup controller with some ignored patterns
			await fs.writeFile(path.join(tempDir, ".diracignore"), "*.secret\nprivate/")
			controller = new DiracIgnoreController(tempDir)
			await controller.initialize()

			// Verify it normally blocks
			controller.validateAccess("test.secret").should.be.false()
			controller.validateAccess("private/file.txt").should.be.false()

			const blockedCommand = "cat test.secret"
			controller.validateCommand(blockedCommand)!.should.equal("test.secret")

			// Enable YOLO mode
			controller.yoloMode = true

			// Verify it now allows everything
			controller.validateAccess("test.secret").should.be.true()
			controller.validateAccess("private/file.txt").should.be.true()
			controller.validateAccess(".git/config").should.be.true()

			const result = controller.validateCommand(blockedCommand)
			;(result === undefined).should.be.true()

			// Verify filterPaths also works
			const paths = ["src/index.ts", "test.secret", "private/file.txt", ".env"]
			controller.filterPaths(paths).should.deepEqual(paths)
		})
	})
})
