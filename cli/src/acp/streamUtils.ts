/**
 * Stream conversion utilities for ACP mode.
 *
 * The ACP SDK's ndJsonStream function expects Web Streams (ReadableStream/WritableStream),
 * but Node.js provides its own stream types. These utilities convert between them.
 *
 * @module acp/streamUtils
 */

import type { AnyMessage } from "@agentclientprotocol/sdk"
import type { Stream } from "@agentclientprotocol/sdk"
import type { Readable, Writable } from "node:stream"

/**
 * Convert a Node.js Writable stream to a Web WritableStream.
 *
 * Used to convert process.stdout for ACP output.
 *
 * @param nodeStream - Node.js Writable stream (e.g., process.stdout)
 * @returns Web WritableStream compatible with ndJsonStream
 */
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				nodeStream.write(Buffer.from(chunk), (err) => {
					if (err) {
						reject(err)
					} else {
						resolve()
					}
				})
			})
		},
	})
}

/**
 * Convert a Node.js Readable stream to a Web ReadableStream.
 *
 * Used to convert process.stdin for ACP input.
 *
 * @param nodeStream - Node.js Readable stream (e.g., process.stdin)
 * @returns Web ReadableStream compatible with ndJsonStream
 */
export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			nodeStream.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk))
			})
			nodeStream.on("end", () => controller.close())
			nodeStream.on("error", (err) => controller.error(err))
		},
	})
}

/**
 * Create an ACP newline-delimited JSON stream that ignores malformed inbound frames.
 *
 * The ACP SDK validates request schemas after decoding, so a valid JSON frame with
 * invalid parameters is answered with JSON-RPC -32602 without closing the stream.
 * This adapter additionally makes malformed JSON recoverable: it drops that single
 * line and continues decoding later frames from the same stdin connection.
 */
export function createResilientNdJsonStream(
	output: WritableStream<Uint8Array>,
	input: ReadableStream<Uint8Array>,
): Stream {
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()

	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			let remainder = ""
			const reader = input.getReader()

			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) {
						break
					}
					if (!value) {
						continue
					}

					remainder += decoder.decode(value, { stream: true })
					const lines = remainder.split("\n")
					remainder = lines.pop() ?? ""

					for (const line of lines) {
						const frame = parseJsonRpcFrame(line)
						if (frame) {
							controller.enqueue(frame)
						}
					}
				}
			} finally {
				reader.releaseLock()
				controller.close()
			}
		},
	})

	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			const writer = output.getWriter()
			try {
				await writer.write(encoder.encode(`${JSON.stringify(message)}\n`))
			} finally {
				writer.releaseLock()
			}
		},
	})

	return { readable, writable }
}

function parseJsonRpcFrame(line: string): AnyMessage | undefined {
	const trimmed = line.trim()
	if (!trimmed) {
		return undefined
	}

	try {
		return JSON.parse(trimmed) as AnyMessage
	} catch {
		return undefined
	}
}
