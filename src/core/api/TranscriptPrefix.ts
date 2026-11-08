import { createHash, randomUUID } from "node:crypto"

/** A submitted generation is append-only. Explicit request transitions create linked generations. */
export interface TranscriptPrefix {
	id: string
	parentId?: string
	headerHash: string
	messageHashes: string[]
}

export class TranscriptIntegrityError extends Error {
	constructor(component: string) {
		super(`Transcript integrity violation: ${component} changed. Submitted history is append-only; use an explicit checkpoint branch to restore history.`)
		this.name = "TranscriptIntegrityError"
	}
}

export function transcriptHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Validate before sending, including failed/uncertain sends. Never reset on a mismatch. */
export function extendTranscriptPrefix(
	previous: TranscriptPrefix | undefined,
	header: unknown,
	messages: readonly unknown[],
	parentTranscriptId?: string,
): TranscriptPrefix {
	const headerHash = transcriptHash(header)
	const messageHashes = messages.map(transcriptHash)
	if (previous) {
		if (previous.headerHash !== headerHash) throw new TranscriptIntegrityError("instructions, tools, or provider configuration")
		if (messageHashes.length < previous.messageHashes.length) throw new TranscriptIntegrityError("history length")
		for (const [index, hash] of previous.messageHashes.entries()) {
			if (hash !== messageHashes[index]) throw new TranscriptIntegrityError(`message ${index}`)
		}
	}
	return {
		id: previous?.id ?? randomUUID(),
		parentId: previous?.parentId ?? parentTranscriptId,
		headerHash,
		messageHashes,
	}
}
