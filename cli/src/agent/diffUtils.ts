/**
 * Diff utility for parsing unified diff format directly into DiffBlock[].
 *
 * This avoids the fallback path in DiffComputer that incorrectly treats
 * every line as an addition.
 *
 * @module agent/diffUtils
 */

import type { DiffLine, DiffBlock, ComputedDiff } from "../utils/DiffComputer.js"

/**
 * Parse unified diff format (from diff.createPatch / git-style @@ hunks)
 * directly into DiffBlock[].
 */
export function parseUnifiedDiff(content: string): ComputedDiff {
    const lines = content.split("\n")
    const blocks: DiffBlock[] = []
    let currentLines: DiffLine[] = []
    let additions = 0
    let deletions = 0
    let totalAdditions = 0
    let totalDeletions = 0
    let oldLineNum = 0
    let newLineNum = 0
    let inHunk = false

    for (const line of lines) {
        // Detect hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
        if (hunkMatch) {
            // Flush previous block
            if (currentLines.length > 0) {
                blocks.push({ lines: currentLines, additions, deletions })
                totalAdditions += additions
                totalDeletions += deletions
            }
            currentLines = []
            additions = 0
            deletions = 0
            oldLineNum = parseInt(hunkMatch[1], 10)
            newLineNum = parseInt(hunkMatch[2], 10)
            inHunk = true
            continue
        }

        if (!inHunk) continue

        if (line.startsWith("-")) {
            currentLines.push({
                type: "remove",
                content: line.slice(1),
                oldLineNumber: oldLineNum,
            })
            oldLineNum++
            deletions++
        } else if (line.startsWith("+")) {
            currentLines.push({
                type: "add",
                content: line.slice(1),
                newLineNumber: newLineNum,
            })
            newLineNum++
            additions++
        } else {
            // Context line (starts with space) or other non-hunk line
            currentLines.push({
                type: "context",
                content: line.startsWith(" ") ? line.slice(1) : line,
                oldLineNumber: oldLineNum,
                newLineNumber: newLineNum,
            })
            oldLineNum++
            newLineNum++
        }
    }

    // Flush last block
    if (currentLines.length > 0) {
        blocks.push({ lines: currentLines, additions, deletions })
        totalAdditions += additions
        totalDeletions += deletions
    }

    return { blocks, totalAdditions, totalDeletions }
}
