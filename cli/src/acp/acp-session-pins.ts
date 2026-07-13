import fs from "node:fs"
import path from "node:path"
import { DIRAC_CLI_DIR } from "../utils/path.js"

const SESSION_PINS_FILE = path.join(DIRAC_CLI_DIR.data, "acp-session-pins.json")

export type PinnedSessionMessage = {
	messageId: string
	content: string
	pinnedAt: string
}

type SessionPinsMap = Record<string, PinnedSessionMessage[]>

function readSessionPinsMap(): SessionPinsMap {
	if (!fs.existsSync(SESSION_PINS_FILE)) {
		return {}
	}

	return JSON.parse(fs.readFileSync(SESSION_PINS_FILE, "utf-8")) as SessionPinsMap
}

function writeSessionPinsMap(map: SessionPinsMap): void {
	fs.mkdirSync(path.dirname(SESSION_PINS_FILE), { recursive: true })
	fs.writeFileSync(SESSION_PINS_FILE, JSON.stringify(map, null, 2))
}

/** Persist a snapshot of a message that must remain in the model context. */
export function pinSessionMessage(sessionId: string, message: PinnedSessionMessage): void {
	const map = readSessionPinsMap()
	const pins = map[sessionId] ?? []
	map[sessionId] = [...pins.filter((pin) => pin.messageId !== message.messageId), message]
	writeSessionPinsMap(map)
}

/** Remove one pinned message snapshot. */
export function unpinSessionMessage(sessionId: string, messageId: string): boolean {
	const map = readSessionPinsMap()
	const pins = map[sessionId] ?? []
	const updatedPins = pins.filter((pin) => pin.messageId !== messageId)
	if (updatedPins.length === pins.length) {
		return false
	}

	map[sessionId] = updatedPins
	writeSessionPinsMap(map)
	return true
}

/** Return the durable pinned-message snapshots for a session. */
export function getPinnedSessionMessages(sessionId: string): PinnedSessionMessage[] {
	return readSessionPinsMap()[sessionId] ?? []
}

/** Remove all persisted pins when a session is deleted. */
export function deletePinnedSessionMessages(sessionId: string): void {
	const map = readSessionPinsMap()
	delete map[sessionId]
	writeSessionPinsMap(map)
}
