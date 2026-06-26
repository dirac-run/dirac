import { expect } from "chai"
import { parseSlashCommands } from "../index"

describe("slash-commands", () => {
	it("should return original text if no slash command is found", async () => {
		const text = "Hello world"
		const result = await parseSlashCommands(text, {}, {}, "test-ulid")
		expect(result.processedText).to.equal(text)
		expect(result.needsDiracrulesFileCheck).to.equal(false)
	})

	it("should process builtin slash command", async () => {
		const text = "<task>" + "/newtask" + "</task>"
		const result = await parseSlashCommands(text, {}, {}, "test-ulid", {
			providerId: "anthropic",
			model: { id: "claude-3-5-sonnet-20240620", info: {} as any },
			mode: "act",
		})
		expect(result.processedText).to.include("help them create a new task with preloaded context")
	})
	it("should process /askDirac slash command", async () => {
		const text = "<task>" + "/askDirac" + "</task>"
		const result = await parseSlashCommands(
			text,
			{},
			{},
			"test-ulid",
			undefined,
			[],
			undefined,
			"/mock/path",
			"mock-dist/source",
		)
		expect(result.processedText).to.include("The source code is located at: /mock/path/mock-dist/source")
	})
})
