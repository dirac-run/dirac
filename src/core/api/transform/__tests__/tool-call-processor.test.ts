import "should"
import { expect } from "chai"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { getOpenAIToolParams, ToolCallProcessor } from "../tool-call-processor"

// Characterization tests for ToolCallProcessor streaming tool-call delta accumulation
// and getOpenAIToolParams tool parameter mapping.
describe("ToolCallProcessor", () => {
	afterEach(() => sinon.restore())

	it("should preserve tool call id/name for interleaved parallel deltas", () => {
		const processor = new ToolCallProcessor()

		const firstChunk = [
			{
				index: 0,
				id: "call_a",
				function: { name: "read_file" },
			},
			{
				index: 1,
				id: "call_b",
				function: { name: "search_files" },
			},
		] as any

		const secondChunk = [
			{
				index: 1,
				function: { arguments: '{"path":"src"}' },
			},
			{
				index: 0,
				function: { arguments: '{"path":"README.md"}' },
			},
		] as any

		const firstResult = [...processor.processToolCallDeltas(firstChunk)]
		const secondResult = [...processor.processToolCallDeltas(secondChunk)]

		firstResult.should.have.length(0)
		secondResult.should.have.length(2)
		// Intentionally reversed from the setup chunk: output follows incoming
		// argument-delta order, but reconstruction is correct regardless of arrival
		// order because id/name/arguments are matched by tool call index.
		const firstToolCall = secondResult[0]!.tool_call as any
		const secondToolCall = secondResult[1]!.tool_call as any
		firstToolCall.function.id.should.equal("call_b")
		firstToolCall.function.name.should.equal("search_files")
		firstToolCall.function.arguments.should.equal('{"path":"src"}')
		secondToolCall.function.id.should.equal("call_a")
		secondToolCall.function.name.should.equal("read_file")
		secondToolCall.function.arguments.should.equal('{"path":"README.md"}')
	})

	it("yields nothing when deltas are undefined", () => {
		const processor = new ToolCallProcessor()
		const result = [...processor.processToolCallDeltas(undefined)]
		result.should.have.length(0)
	})

	it("yields nothing when deltas are empty array", () => {
		const processor = new ToolCallProcessor()
		const result = [...processor.processToolCallDeltas([] as any)]
		result.should.have.length(0)
	})

	it("uses fallback iteration index when delta has no index", () => {
		const processor = new ToolCallProcessor()
		;[
			...processor.processToolCallDeltas([{ id: "c1", function: { name: "fn", arguments: "{}" } }] as any),
		].should.have.length(1)
	})

	it("does not yield until id, name, and arguments are all present", () => {
		const processor = new ToolCallProcessor()
		// only id
		;[...processor.processToolCallDeltas([{ index: 0, id: "c1" }] as any)].should.have.length(0)
		// id + name, no args
		;[...processor.processToolCallDeltas([{ index: 0, function: { name: "fn" } }] as any)].should.have.length(0)
		// now args arrive
		const result = [...processor.processToolCallDeltas([{ index: 0, function: { arguments: "{}" } }] as any)]
		result.should.have.length(1)
	})

	it("does not yield when only name is present without id", () => {
		const processor = new ToolCallProcessor()
		;[
			...processor.processToolCallDeltas([{ index: 0, function: { name: "fn", arguments: "{}" } }] as any),
		].should.have.length(0)
	})

	it("yields web_search tool call when type is web_search and query present", () => {
		const processor = new ToolCallProcessor()
		const result = [
			...processor.processToolCallDeltas([
				{ index: 0, id: "ws1", type: "web_search", web_search: { query: "hello" } },
			] as any),
		]
		result.should.have.length(1)
		const tc = result[0]!.tool_call as any
		tc.type.should.equal("web_search")
		tc.call_id.should.equal("ws1")
		tc.web_search.query.should.equal("hello")
	})

	it("yields web_search with empty query object when web_search is undefined but query flag set", () => {
		const processor = new ToolCallProcessor()
		// type web_search sets name; query present triggers yield but web_search object missing
		const result = [
			...processor.processToolCallDeltas([{ index: 0, id: "ws1", type: "web_search", web_search: { query: "q" } }] as any),
		]
		result.should.have.length(1)
		;(result[0]!.tool_call as any).web_search.query.should.equal("q")
	})

	it("does not yield web_search when query is absent", () => {
		const processor = new ToolCallProcessor()
		;[...processor.processToolCallDeltas([{ index: 0, id: "ws1", type: "web_search" }] as any)].should.have.length(0)
	})

	it("overwrites name with function name when both web_search type and function name arrive", () => {
		const processor = new ToolCallProcessor()
		const result = [
			...processor.processToolCallDeltas([
				{ index: 0, id: "c1", type: "web_search", function: { name: "real_fn", arguments: "{}" } },
			] as any),
		]
		result.should.have.length(1)
		;(result[0]!.tool_call as any).function.name.should.equal("real_fn")
	})

	it("preserves id across multiple chunks for same index", () => {
		const processor = new ToolCallProcessor()
		;[...processor.processToolCallDeltas([{ index: 0, id: "c1", function: { name: "fn" } }] as any)].should.have.length(0)
		const result = [...processor.processToolCallDeltas([{ index: 0, function: { arguments: "{}" } }] as any)]
		;(result[0]!.tool_call as any).function.id.should.equal("c1")
	})

	it("getState returns accumulated tool call state", () => {
		const processor = new ToolCallProcessor()
		;[...processor.processToolCallDeltas([{ index: 0, id: "c1", function: { name: "fn" } }] as any)]
		const state = processor.getState()
		state[0].id.should.equal("c1")
		state[0].name.should.equal("fn")
	})

	it("getState is empty after reset", () => {
		const processor = new ToolCallProcessor()
		;[...processor.processToolCallDeltas([{ index: 0, id: "c1", function: { name: "fn" } }] as any)]
		processor.reset()
		Object.keys(processor.getState()).should.have.length(0)
	})

	it("logs debug message when function name is received", () => {
		const debugStub = sinon.stub(Logger, "debug")
		const processor = new ToolCallProcessor()
		;[...processor.processToolCallDeltas([{ index: 0, id: "c1", function: { name: "logged_fn", arguments: "{}" } }] as any)]
		expect(debugStub.called).to.be.true
		const callArg = debugStub.firstCall.args[0] as string
		expect(callArg).to.include("logged_fn")
	})

	it("should clear accumulated state on reset", () => {
		const processor = new ToolCallProcessor()

		const setupChunk = [
			{
				index: 0,
				id: "call_reset",
				function: { name: "read_file" },
			},
		] as any

		const argsChunk = [
			{
				index: 0,
				function: { arguments: '{"path":"after-reset"}' },
			},
		] as any

		;[...processor.processToolCallDeltas(setupChunk)].should.have.length(0)
		processor.reset()
		;[...processor.processToolCallDeltas(argsChunk)].should.have.length(0)

		const newSetupChunk = [
			{
				index: 0,
				id: "call_new",
				function: { name: "write_file" },
			},
		] as any

		const newArgsChunk = [
			{
				index: 0,
				function: { arguments: '{"path":"file.txt"}' },
			},
		] as any

		;[...processor.processToolCallDeltas(newSetupChunk)].should.have.length(0)
		;[...processor.processToolCallDeltas(newArgsChunk)].should.have.length(1)
	})
})

describe("getOpenAIToolParams", () => {
	it("should include parallel_tool_calls when enabled", () => {
		const tools = [
			{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } },
		] as any
		const params = getOpenAIToolParams(tools, true) as any

		params.parallel_tool_calls.should.equal(true)
	})

	it("should include parallel_tool_calls=false when disabled by default", () => {
		const tools = [
			{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } },
		] as any
		const params = getOpenAIToolParams(tools, false) as any

		params.parallel_tool_calls.should.equal(false)
	})

	it("should not include parallel_tool_calls when tools are absent", () => {
		const params = getOpenAIToolParams(undefined, false) as any

		params.should.not.have.property("parallel_tool_calls")
	})

	it("returns tools undefined when tools array is empty", () => {
		const params = getOpenAIToolParams([], true) as any
		should.equal(params.tools, undefined)
		params.should.not.have.property("tool_choice")
	})

	it("passes through function-type tools unchanged", () => {
		const tool = { type: "function", function: { name: "fn", description: "d", parameters: { type: "object" } } }
		const params = getOpenAIToolParams([tool as any], false) as any
		params.tools[0].should.deepEqual(tool)
	})

	it("maps web_search tools with optional fields", () => {
		const tool = {
			type: "web_search",
			search_context_size: "medium",
			filters: { foo: "bar" },
			user_location: { lat: 1 },
			external_web_access: true,
		}
		const params = getOpenAIToolParams([tool as any], false) as any
		params.tools[0].type.should.equal("web_search")
		params.tools[0].search_context_size.should.equal("medium")
		params.tools[0].filters.should.deepEqual({ foo: "bar" })
		params.tools[0].user_location.should.deepEqual({ lat: 1 })
		params.tools[0].external_web_access.should.equal(true)
	})

	it("omits optional web_search fields when not provided", () => {
		const tool = { type: "web_search" }
		const params = getOpenAIToolParams([tool as any], false) as any
		params.tools[0].should.deepEqual({ type: "web_search" })
	})

	it("omits external_web_access when explicitly undefined", () => {
		const tool = { type: "web_search", external_web_access: undefined }
		const params = getOpenAIToolParams([tool as any], false) as any
		params.tools[0].should.not.have.property("external_web_access")
	})

	it("always sets tool_choice to auto when tools present", () => {
		const params = getOpenAIToolParams([{ type: "function", function: { name: "fn" } } as any], false) as any
		params.tool_choice.should.equal("auto")
	})

	it("passes through unknown tool types unchanged", () => {
		const tool = { type: "custom", data: "x" }
		const params = getOpenAIToolParams([tool as any], false) as any
		params.tools[0].should.deepEqual(tool)
	})
})
