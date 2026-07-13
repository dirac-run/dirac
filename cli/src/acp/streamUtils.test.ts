import { AgentSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { createResilientNdJsonStream } from "./streamUtils.js"

describe("createResilientNdJsonStream", () => {
	it("continues serving valid requests after malformed and schema-invalid stdin frames", async () => {
		const inbound = new TransformStream<Uint8Array, Uint8Array>()
		const outbound = new TransformStream<Uint8Array, Uint8Array>()
		const initialized = awaitableCounter()

		new AgentSideConnection(
			() => ({
				async initialize() {
					initialized.increment()
					return {
						protocolVersion: PROTOCOL_VERSION,
						agentCapabilities: {},
						agentInfo: { name: "test-agent", version: "1.0.0" },
					}
				},
				async newSession() {
					return { sessionId: "unused" }
				},
				async prompt() {
					return { stopReason: "end_turn" as const }
				},
				async cancel() {},
				async authenticate() {},
			}),
			createResilientNdJsonStream(outbound.writable, inbound.readable),
		)

		const input = inbound.writable.getWriter()
		await input.write(new TextEncoder().encode("this is not JSON\n"))
		await input.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'))
		await input.write(
			new TextEncoder().encode(
				`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":${PROTOCOL_VERSION},"clientCapabilities":{}}}\n`,
			),
		)
		await input.close()

		const responses = await readJsonFrames(outbound.readable, 2)

		expect(responses).toEqual([
			expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32603 }) }),
			expect.objectContaining({ id: 2, result: expect.objectContaining({ protocolVersion: PROTOCOL_VERSION }) }),
		])
		expect(initialized.count()).toBe(1)
	})
})

function awaitableCounter(): { increment(): void; count(): number } {
	let value = 0
	return {
		increment: () => value++,
		count: () => value,
	}
}

async function readJsonFrames(stream: ReadableStream<Uint8Array>, count: number): Promise<unknown[]> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	const frames: unknown[] = []
	let remainder = ""

	try {
		while (frames.length < count) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}
			remainder += decoder.decode(value, { stream: true })
			const lines = remainder.split("\n")
			remainder = lines.pop() ?? ""
			for (const line of lines) {
				if (line.trim()) {
					frames.push(JSON.parse(line))
				}
			}
		}
	} finally {
		reader.releaseLock()
	}

	return frames
}
