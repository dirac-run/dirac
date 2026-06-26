import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import * as extractTextModule from "@integrations/misc/extract-text"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import * as gitModule from "@utils/git"
import { expect } from "chai"
import * as fs from "fs"
import * as isBinaryFileModule from "isbinaryfile"
import * as path from "path"
import * as sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as terminalModule from "@/hosts/vscode/terminal/get-latest-output"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { parseMentions } from ".."

// Characterization tests for parseMentions: pin current behavior of each mention type
// (file, url, keyword/tag, git) and edge cases so the flatten refactor stays behavior-preserving.
describe("parseMentions characterization", () => {
	let sandbox: sinon.SinonSandbox
	let urlContentFetcherStub: sinon.SinonStubbedInstance<UrlContentFetcher>
	let fileContextTrackerStub: sinon.SinonStubbedInstance<FileContextTracker>
	let fsStatStub: sinon.SinonStub
	let fsReaddirStub: sinon.SinonStub
	let extractTextStub: sinon.SinonStub
	let isBinaryFileStub: sinon.SinonStub
	let getLatestTerminalOutputStub: sinon.SinonStub
	let getWorkingStateStub: sinon.SinonStub
	let getCommitInfoStub: sinon.SinonStub
	let showMessageStub: sinon.SinonStub

	const cwd = "/test/project"

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		setVscodeHostProviderMock()
		urlContentFetcherStub = {
			launchBrowser: sandbox.stub().resolves(),
			closeBrowser: sandbox.stub().resolves(),
			urlToMarkdown: sandbox.stub().resolves("# Example Website\n\nContent here"),
		} as any
		fileContextTrackerStub = { trackFileContext: sandbox.stub().resolves() } as any
		fsStatStub = sandbox.stub(fs.promises, "stat")
		fsReaddirStub = sandbox.stub(fs.promises, "readdir")
		extractTextStub = sandbox.stub(extractTextModule, "extractTextFromFile")
		isBinaryFileStub = sandbox.stub(isBinaryFileModule, "isBinaryFile")
		getLatestTerminalOutputStub = sandbox.stub(terminalModule, "getLatestTerminalOutput")
		getWorkingStateStub = sandbox.stub(gitModule, "getWorkingState")
		getCommitInfoStub = sandbox.stub(gitModule, "getCommitInfo")
		showMessageStub = sandbox.stub(HostProvider.window, "showMessage")
	})

	afterEach(() => sandbox.restore())

	describe("File mentions (@/path)", () => {
		it("expands a simple file mention into inline placeholder + appended content block", async () => {
			fsStatStub.resolves({ isFile: () => true, isDirectory: () => false })
			isBinaryFileStub.resolves(false)
			extractTextStub.resolves("console.log('hi');")
			const result = await parseMentions("Check @/src/index.ts", cwd, urlContentFetcherStub, fileContextTrackerStub)
			expect(result).to.equal(
				`Check 'src/index.ts' (see below for file content)\n\n<file_content path="src/index.ts">\nconsole.log('hi');\n</file_content>`,
			)
			expect(fileContextTrackerStub.trackFileContext.calledWith("src/index.ts", "file_mentioned")).to.be.true
		})

		it("expands a folder mention into a tree + nested file contents", async () => {
			fsStatStub.resolves({ isFile: () => false, isDirectory: () => true })
			fsReaddirStub.resolves([
				{ name: "a.ts", isFile: () => true, isDirectory: () => false },
				{ name: "sub", isFile: () => false, isDirectory: () => true },
			])
			isBinaryFileStub.resolves(false)
			extractTextStub.withArgs(path.resolve(cwd, "src/a.ts")).resolves("export const a = 1")
			const result = await parseMentions("Look in @/src/", cwd, urlContentFetcherStub)
			expect(result).to.contain('<folder_content path="src/">')
			expect(result).to.contain("├── a.ts")
			expect(result).to.contain("└── sub/")
			expect(result).to.contain('<file_content path="src/a.ts">')
		})

		it("renders binary files as a placeholder instead of content", async () => {
			fsStatStub.resolves({ isFile: () => true, isDirectory: () => false })
			isBinaryFileStub.resolves(true)
			const result = await parseMentions("@/img.png", cwd, urlContentFetcherStub)
			expect(result).to.contain("(Binary file, unable to display content)")
		})

		it("surfaces file read errors inline without throwing", async () => {
			fsStatStub.rejects(new Error("ENOENT: no such file"))
			const result = await parseMentions("@/nope.txt", cwd, urlContentFetcherStub)
			expect(result).to.contain('Error fetching content: Failed to access path "nope.txt": ENOENT: no such file')
		})
	})

	describe("URL mentions (@http(s)://...)", () => {
		it("launches browser, fetches markdown, appends url_content block, closes browser", async () => {
			const result = await parseMentions("Visit @https://example.com now", cwd, urlContentFetcherStub)
			expect(result).to.equal(
				`Visit 'https://example.com' (see below for site content) now\n\n<url_content url="https://example.com">\n# Example Website\n\nContent here\n</url_content>`,
			)
			expect(urlContentFetcherStub.launchBrowser.called).to.be.true
			expect(urlContentFetcherStub.urlToMarkdown.calledWith("https://example.com")).to.be.true
			expect(urlContentFetcherStub.closeBrowser.called).to.be.true
		})

		it("reports a browser launch failure inline and still emits the block", async () => {
			urlContentFetcherStub.launchBrowser.rejects(new Error("Browser launch failed"))
			const result = await parseMentions("@https://example.com", cwd, urlContentFetcherStub)
			expect(result).to.contain("Error fetching content: Browser launch failed")
			expect(showMessageStub.called).to.be.true
		})

		it("reports a fetch failure inline and still emits the block", async () => {
			urlContentFetcherStub.urlToMarkdown.rejects(new Error("Network error"))
			const result = await parseMentions("@https://example.com", cwd, urlContentFetcherStub)
			expect(result).to.contain("Error fetching content: Network error")
		})
	})

	describe("Keyword/tag mentions (@problems, @terminal, @git-changes)", () => {
		it("expands @terminal into a terminal_output block", async () => {
			getLatestTerminalOutputStub.resolves("$ npm test\nok")
			const result = await parseMentions("See @terminal output", cwd, urlContentFetcherStub)
			expect(result).to.equal(
				`See Terminal Output (see below for output) output\n\n<terminal_output>\n$ npm test\nok\n</terminal_output>`,
			)
		})

		it("expands @git-changes into a git_working_state block", async () => {
			getWorkingStateStub.resolves("M  src/index.ts")
			const result = await parseMentions("Review @git-changes", cwd, urlContentFetcherStub)
			expect(result).to.equal(
				`Review Working directory changes (see below for details)\n\n<git_working_state>\nM  src/index.ts\n</git_working_state>`,
			)
		})

		it("expands a git commit hash into a git_commit block", async () => {
			getCommitInfoStub.resolves("commit abc\nAuthor: T")
			const result = await parseMentions("See @abcdef1234567890", cwd, urlContentFetcherStub)
			expect(result).to.contain('<git_commit hash="abcdef1234567890">')
			expect(result).to.contain("commit abc\nAuthor: T")
		})
	})

	describe("Edge cases", () => {
		it("returns empty string unchanged", async () => {
			expect(await parseMentions("", cwd, urlContentFetcherStub)).to.equal("")
		})

		it("returns whitespace-only text unchanged", async () => {
			expect(await parseMentions("   \n\t  ", cwd, urlContentFetcherStub)).to.equal("   \n\t  ")
		})

		it("returns text with no mentions unchanged", async () => {
			const text = "plain text without any mentions"
			expect(await parseMentions(text, cwd, urlContentFetcherStub)).to.equal(text)
		})

		it("deduplicates identical mentions to a single content block", async () => {
			fsStatStub.resolves({ isFile: () => true, isDirectory: () => false })
			isBinaryFileStub.resolves(false)
			extractTextStub.resolves("C")
			const result = await parseMentions("@/f.txt and again @/f.txt", cwd, urlContentFetcherStub)
			expect(result.match(/<file_content path="f\.txt">/g)?.length).to.equal(1)
		})

		it("handles mixed mention types preserving inline order and appending blocks", async () => {
			fsStatStub.resolves({ isFile: () => true, isDirectory: () => false })
			isBinaryFileStub.resolves(false)
			extractTextStub.resolves("FC")
			const result = await parseMentions("@/f.txt and @https://example.com", cwd, urlContentFetcherStub)
			expect(result).to.contain(
				"'f.txt' (see below for file content) and 'https://example.com' (see below for site content)",
			)
			expect(result).to.contain("<file_content")
			expect(result).to.contain("<url_content")
		})

		it("skips a bare '/' mention without scanning the workspace root", async () => {
			const result = await parseMentions("@/ end", cwd, urlContentFetcherStub)
			// bare "/" is a safety guard: no content block appended
			expect(result).to.not.contain("<folder_content")
			expect(result).to.not.contain("<file_content")
		})
	})
})
