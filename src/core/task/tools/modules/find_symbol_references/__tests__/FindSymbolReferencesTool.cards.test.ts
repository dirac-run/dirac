import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { FindSymbolReferencesTool } from "../FindSymbolReferencesTool"

interface RecordedCard {
	initialHeader: string
	updates: sinon.SinonSpy
	finalize: sinon.SinonSpy
}

describe("FindSymbolReferencesTool cards", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-find-symbol-references-test-"))
		await fs.mkdir(path.join(tmpDir, "src"))
		await fs.mkdir(path.join(tmpDir, "cli"))
		await fs.writeFile(path.join(tmpDir, "src", "foo.ts"), "foo reference\n")
		await fs.writeFile(path.join(tmpDir, "src", "bar.ts"), "bar reference\n")
		await fs.writeFile(path.join(tmpDir, "cli", "foo.ts"), "first line\nfoo reference\n")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("creates one full-match card for every symbol and search-path pair", async () => {
		const cards: RecordedCard[] = []
		const createCard = sinon.stub().callsFake(async ({ header }: { header: string }) => {
			const card: RecordedCard = {
				initialHeader: header,
				updates: sinon.spy(),
				finalize: sinon.spy(),
			}
			cards.push(card)
			return {
				id: `card-${cards.length}`,
				collapsed: true,
				header,
				renderType: "text",
				status: CardStatus.RUNNING,
				update: card.updates,
				appendBody: sinon.stub().resolves(),
				finalize: card.finalize,
				waitForInteraction: sinon.stub().resolves(),
			}
		})
		const env = {
			config: {
				cwd: tmpDir,
				ulid: "test-ulid",
				isSubagentExecution: false,
			},
			ui: { createCard },
			workspace: {
				resolvePath: async (relativePath: string) => ({
					absolutePath: path.join(tmpDir, relativePath),
					displayPath: relativePath,
				}),
				getFileInfo: async () => ({ exists: true, isFile: false, size: 0 }),
				readFile: async (absolutePath: string) => await fs.readFile(absolutePath, "utf8"),
			},
			symbol: {
				initializeIndex: sinon.stub().resolves(),
				getReferences: sinon.stub().callsFake(async (symbol: string) => {
					if (symbol === "foo") {
						return [
							{ path: "src/foo.ts", startLine: 0 },
							{ path: "cli/foo.ts", startLine: 1 },
						]
					}
					return [{ path: "src/bar.ts", startLine: 0 }]
				}),
				getDefinitions: sinon.stub().resolves([]),
				getSymbols: sinon.stub().resolves([]),
				updateIndex: sinon.stub().resolves(),
			},
			orchestration: {
				getTaskState: sinon.stub().returns(0),
				setTaskState: sinon.stub(),
			},
		} as any

		const result = await new FindSymbolReferencesTool().processCall(
			{
				symbols: ["foo", "bar"],
				paths: ["src", "cli"],
				find_type: "reference",
				include_anchors: false,
			},
			env,
		)

		assert.equal(cards.length, 4)
		assert.deepEqual(
			cards.map((card) => card.initialHeader),
			[
				"Finding references for foo in src",
				"Finding references for foo in cli",
				"Finding references for bar in src",
				"Finding references for bar in cli",
			],
		)

		const updates = cards.map((card) => card.updates.firstCall.args[0])
		assert.match(updates[0].body, /src\/foo\.ts:\n {2}foo reference/)
		assert.doesNotMatch(updates[0].body, /cli\/foo\.ts/)
		assert.match(updates[1].body, /cli\/foo\.ts:\n {2}foo reference/)
		assert.match(updates[2].body, /src\/bar\.ts:\n {2}bar reference/)
		assert.equal(updates[3].body, "No references found.")
		for (const card of cards) {
			sinon.assert.calledWithExactly(card.finalize, CardStatus.SUCCESS)
		}

		assert.match(result, /src\/foo\.ts:\n {2}\(foo\) foo reference/)
		assert.match(result, /src\/bar\.ts:\n {2}\(bar\) bar reference/)
		assert.match(result, /cli\/foo\.ts:\n {2}\(foo\) foo reference/)
	})
})
