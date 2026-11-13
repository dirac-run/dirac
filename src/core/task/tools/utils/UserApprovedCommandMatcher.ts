import type { UserApprovedCommand } from "@shared/UserApprovedCommand"
import { quote } from "shell-quote"
import { parseUserApprovedCommandSegments } from "./UserApprovedCommandSyntax"

function matchesEntry(words: readonly string[], entry: UserApprovedCommand): boolean {
	const approvedSegments = parseUserApprovedCommandSegments(entry.command)
	if (approvedSegments?.length !== 1) return false
	const approvedWords = approvedSegments[0]
	if (entry.match === "exact" && words.length !== approvedWords.length) return false
	return approvedWords.every((word, index) => words[index] === word)
}

export function isUserApprovedCommandSegment(segment: string, entries: UserApprovedCommand[]): boolean {
	const segments = parseUserApprovedCommandSegments(segment)
	if (segments?.length !== 1) return false
	return entries.some((entry) => matchesEntry(segments[0], entry))
}

export function areCommandSegmentsApproved(command: string, isSegmentApproved: (segment: string) => boolean): boolean {
	const segments = parseUserApprovedCommandSegments(command)
	// Serialize each argv without losing quoted spaces, empty arguments, or literal
	// operators before passing it to the single-segment permission matcher.
	return segments !== undefined && segments.every((words) => isSegmentApproved(quote(words)))
}
