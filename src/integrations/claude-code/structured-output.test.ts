import { describe, it } from "mocha"
import "should"
import { buildStructuredToolSchema, extractStructuredToolCalls, STRUCTURED_OUTPUT_TOOL_NAME } from "./structured-output"

describe("claude-code structured-output", () => {
	describe("buildStructuredToolSchema", () => {
		it("wraps OpenAI function tools as a tool_calls array of discriminated items", () => {
			const tools: any[] = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
							required: ["path"],
						},
					},
				},
				{
					type: "function",
					function: {
						name: "execute_command",
						description: "Run a command",
						parameters: {
							type: "object",
							properties: { command: { type: "string" } },
							required: ["command"],
						},
					},
				},
			]

			const schema = buildStructuredToolSchema(tools)

			schema.should.have.property("type", "object")
			schema.required.should.deepEqual(["tool_calls"])
			schema.properties.tool_calls.should.have.property("type", "array")
			schema.properties.tool_calls.should.have.property("minItems", 1)

			const items = schema.properties.tool_calls.items.oneOf
			items.should.have.length(2)

			const readItem = items[0]
			readItem.properties.tool.should.deepEqual({ const: "read_file" })
			readItem.properties.params.should.deepEqual({
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			})
			readItem.required.should.deepEqual(["tool", "params"])
			readItem.should.have.property("description", "Read a file")

			items[1].properties.tool.should.deepEqual({ const: "execute_command" })
		})

		it("supports Anthropic input_schema tool shape", () => {
			const tools: any[] = [
				{
					name: "write_to_file",
					description: "Write a file",
					input_schema: {
						type: "object",
						properties: { path: { type: "string" }, content: { type: "string" } },
						required: ["path", "content"],
					},
				},
			]

			const schema = buildStructuredToolSchema(tools)
			const item = schema.properties.tool_calls.items.oneOf[0]
			item.properties.tool.should.deepEqual({ const: "write_to_file" })
			item.properties.params.should.have.property("type", "object")
			item.properties.params.required.should.deepEqual(["path", "content"])
		})

		it("falls back to a generic object item when no tools are provided", () => {
			const schema = buildStructuredToolSchema([])
			schema.properties.tool_calls.items.should.deepEqual({ type: "object" })
		})

		it("skips unrecognised tool definitions", () => {
			const tools: any[] = [
				{ totally: "unknown" },
				{ type: "function", function: { name: "say", parameters: { type: "object" } } },
			]
			const schema = buildStructuredToolSchema(tools)
			schema.properties.tool_calls.items.oneOf.should.have.length(1)
			schema.properties.tool_calls.items.oneOf[0].properties.tool.should.deepEqual({ const: "say" })
		})
	})

	describe("extractStructuredToolCalls", () => {
		it("unwraps the array form", () => {
			const calls = extractStructuredToolCalls({
				tool_calls: [
					{ tool: "read_file", params: { path: "a.ts" } },
					{ tool: "execute_command", params: { command: "ls" } },
				],
			})
			calls.should.deepEqual([
				{ tool: "read_file", params: { path: "a.ts" } },
				{ tool: "execute_command", params: { command: "ls" } },
			])
		})

		it("unwraps the single object form", () => {
			const calls = extractStructuredToolCalls({ tool: "read_file", params: { path: "a.ts" } })
			calls.should.deepEqual([{ tool: "read_file", params: { path: "a.ts" } }])
		})

		it("defaults params to an empty object when missing", () => {
			const calls = extractStructuredToolCalls({ tool_calls: [{ tool: "list_files" }] })
			calls.should.deepEqual([{ tool: "list_files", params: {} }])
		})

		it("ignores malformed entries and non-object input", () => {
			extractStructuredToolCalls(null).should.deepEqual([])
			extractStructuredToolCalls("nope").should.deepEqual([])
			extractStructuredToolCalls({ tool_calls: [{ noTool: true }, { tool: "ok", params: {} }] }).should.deepEqual([
				{ tool: "ok", params: {} },
			])
		})
	})

	it("exposes the injected CLI tool name", () => {
		STRUCTURED_OUTPUT_TOOL_NAME.should.equal("StructuredOutput")
	})
})
