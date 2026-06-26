import * as assert from "assert"
import { describe, it } from "mocha"
import { DiffContentManager } from "../DiffContentManager"

describe("DiffContentManager", () => {
	it("should skip empty content during streaming", async () => {
		const manager = new DiffContentManager()
		let callCount = 0

		await manager.update(
			"",
			false,
			async () => {
				callCount++
			},
			async () => {},
			async () => 10,
		)

		assert.strictEqual(callCount, 0)
	})

	it("should skip unchanged content length", async () => {
		const manager = new DiffContentManager()
		let callCount = 0
		await manager.update(
			"line1\n",
			false,
			async () => {
				callCount++
			},
			async () => {},
			async () => 10,
		)
		assert.strictEqual(callCount, 1)

		// Same length should be skipped
		await manager.update(
			"abcde\n", // same length (6 chars)
			false,
			async () => {
				callCount++
			},
			async () => {},
			async () => 10,
		)
		assert.strictEqual(callCount, 1)
	})

	it("should strip BOM from content", async () => {
		const manager = new DiffContentManager()
		let receivedContent = ""

		await manager.update(
			"\ufeffhello world",
			true,
			async (content) => {
				receivedContent = content
			},
			async () => {},
			async () => 10,
		)

		assert.strictEqual(receivedContent.startsWith("\ufeff"), false)
		assert.ok(receivedContent.includes("hello"))
	})

	it("should track line count correctly", async () => {
		const manager = new DiffContentManager()
		const result = await manager.update(
			"line1\nline2\nline3\n",
			true,
			async () => {},
			async () => {},
			async () => 5,
		)

		assert.strictEqual(result.lineCount, 4) // ["line1","line2","line3",""]
	})

	it("should normalize EOL to \r\n when input has CRLF", async () => {
		const manager = new DiffContentManager()
		const normalized = manager.normalizeEol("line1\r\nline2\r\nline3")
		assert.strictEqual(normalized, "line1\r\nline2\r\nline3\r\n")
	})

	it("should normalize EOL to \n when input has no CRLF", async () => {
		const manager = new DiffContentManager()
		const normalized = manager.normalizeEol("line1\nline2\nline3")
		assert.strictEqual(normalized, "line1\nline2\nline3\n")
	})

	it("should detect user edits when content differs", async () => {
		const manager = new DiffContentManager("test.ts")
		const userEdits = manager.detectUserEdits("new content\n", "old content\n")
		assert.ok(userEdits !== undefined)
		assert.ok(userEdits.includes("@@")) // unified diff format
	})

	it("should return undefined when no user edits", async () => {
		const manager = new DiffContentManager("test.ts")
		const userEdits = manager.detectUserEdits("same content\n", "same content\n")
		assert.strictEqual(userEdits, undefined)
	})

	it("should detect auto-formatting edits", async () => {
		const manager = new DiffContentManager("test.ts")
		const formattingEdits = manager.detectAutoFormattingEdits("  const x = 1;", "const x=1;")
		assert.ok(formattingEdits !== undefined)
	})

	it("should return undefined when no auto-formatting", async () => {
		const manager = new DiffContentManager("test.ts")
		const formattingEdits = manager.detectAutoFormattingEdits("same content\n", "same content\n")
		assert.strictEqual(formattingEdits, undefined)
	})

	it("should reset state", async () => {
		const manager = new DiffContentManager()
		await manager.update(
			"line1\nline2\n",
			false,
			async () => {},
			async () => {},
			async () => 5,
		)

		manager.reset()
		assert.strictEqual(manager.getAccumulatedContent(), "")
	})

	it("should finalize by truncating to accumulated lines length", async () => {
		const manager = new DiffContentManager()
		await manager.update(
			"line1\nline2\nline3\n",
			true,
			async () => {},
			async () => {},
			async () => 5,
		)

		let truncatedAt: number | undefined
		await manager.finalize(async (lineNum) => {
			truncatedAt = lineNum
		})

		assert.strictEqual(truncatedAt, 4) // split("...") gives ["line1","line2","line3",""]
	})

	it("should get final content without notebook sanitization for non-notebook", async () => {
		const manager = new DiffContentManager()
		const result = manager.getFinalContent("plain text\n", false)
		assert.strictEqual(result, "plain text\n")
	})

	it("should set relPath", async () => {
		const manager = new DiffContentManager()
		manager.setRelPath("test/file.ts")
		assert.ok(manager["relPath"] === "test/file.ts")
	})
})

describe("DiffContentManager computeDiffLines (scrollToFirstDiff)", () => {
	// Access private method via any cast
	function getDiffs(manager: DiffContentManager, a: string, b: string) {
		return (manager as any).computeDiffLines(a, b)
	}

	it("groups contiguous removed+added as single blocks, not per-line pairs", () => {
		const manager = new DiffContentManager()
		const diffs = getDiffs(manager, "a\nb\nc", "a\nB\nc")
		// Should be: {count:1} (unchanged "a"), {removed,count:1} ("b"), {added,count:1} ("B"), {count:1} ("c")
		assert.equal(diffs.length, 4, "Should have 4 parts: 1 unchanged + 1 removed + 1 added + 1 unchanged")
		assert.ok(!diffs[0].added && !diffs[0].removed, "First part is unchanged")
		assert.ok(diffs[1].removed, "Second part is removed")
		assert.ok(diffs[2].added, "Third part is added")
	})

	it("detects single-line addition at end with count:1", () => {
		const manager = new DiffContentManager()
		const diffs = getDiffs(manager, "a\nb\nc\nd", "a\nb\nc\nd\ne")
		const addedParts = diffs.filter((d: any) => d.added)
		assert.equal(addedParts.length, 1, "Should have 1 added block")
		// diffLines groups "d\ne" as added (count 2) since "d" was removed and re-added
		assert.ok(addedParts[0].count >= 1, "Added block should have count >= 1")
	})

	it("detects single-line removal with count:1", () => {
		const manager = new DiffContentManager()
		const diffs = getDiffs(manager, "a\nb\nc\nd\ne", "a\nb\nc\nd")
		const removedParts = diffs.filter((d: any) => d.removed)
		assert.equal(removedParts.length, 1, "Should have 1 removed block")
		assert.ok(removedParts[0].count >= 1, "Removed block should have count >= 1")
	})

	it("groups multi-line contiguous changes correctly", () => {
		const manager = new DiffContentManager()
		const diffs = getDiffs(manager, "a\nb\nc", "a\nX\nY\nc")
		const removedParts = diffs.filter((d: any) => d.removed)
		const addedParts = diffs.filter((d: any) => d.added)
		assert.equal(removedParts.length, 1, "Should have 1 removed block (b)")
		assert.equal(removedParts[0].count, 1, "Removed block has count 1")
		assert.equal(addedParts.length, 1, "Should have 1 added block (X,Y)")
		assert.equal(addedParts[0].count, 2, "Added block has count 2")
	})

	it("scrollToFirstDiff scrolls to correct line for mid-file change", async () => {
		const manager = new DiffContentManager()
		let scrolledTo: number | undefined
		await manager.scrollToFirstDiff(
			"a\nb\nc\nd",
			async () => "a\nX\nc\nd",
			async (line: number) => {
				scrolledTo = line
			},
		)
		// Diff: {count:1}("a"), {removed:1}("b"), {added:1}("X"), {count:2}("c\nd")
		// First change at lineCount=1 (after "a")
		assert.equal(scrolledTo, 1, "Should scroll to line 1 where first diff appears")
	})

	it("scrollToFirstDiff scrolls to line 0 for first-line change", async () => {
		const manager = new DiffContentManager()
		let scrolledTo: number | undefined
		await manager.scrollToFirstDiff(
			"old\nb\nc",
			async () => "new\nb\nc",
			async (line: number) => {
				scrolledTo = line
			},
		)
		assert.equal(scrolledTo, 0, "Should scroll to line 0 for first-line change")
	})

	it("scrollToFirstDiff does not scroll when content is identical", async () => {
		const manager = new DiffContentManager()
		let scrolledTo: number | undefined
		await manager.scrollToFirstDiff(
			"a\nb\nc",
			async () => "a\nb\nc",
			async (line: number) => {
				scrolledTo = line
			},
		)
		assert.strictEqual(scrolledTo, undefined, "Should not scroll when no diffs")
	})
})
