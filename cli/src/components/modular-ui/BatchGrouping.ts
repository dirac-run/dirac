import { Card, CardStatus, DiracMessage, DiracMessageType, isFinalStatus } from "@shared/ExtensionMessage"

export interface ItemSummary {
    text: string
    status: "success" | "error" | "skipped" | "cancelled"
}

export interface MessageSingle {
    type: "single"
    message: DiracMessage
}

export interface MessageBatch {
    type: "batch"
    batchId: string
    messages: DiracMessage[]
    icon?: string
    actionVerb: string
    noun: string
    successCount: number
    errorCount: number
    totalCount: number
    totalAdditions?: number
    totalDeletions?: number
    itemSummaries: ItemSummary[]
}

export type MessageGroup = MessageSingle | MessageBatch

// Maps header verb patterns to normalized past-tense verb + batch noun
const VERB_PATTERNS: [RegExp, string, string][] = [
    [/^Edit(?:ed|ing)\s+/i, "Edited", "files"],
    [/^Search(?:ed|ing)\s+/i, "Searched", "paths"],
    [/^Read(?:ing)?\s+/i, "Read", "files"],
    [/^Writ(?:e|ing)\s+/i, "Wrote", "files"],
    [/^Extract(?:ed|ing)\s+(?:skeleton\s+)?(?:from\s+)?/i, "Extracted", "files"],
    [/^Renam(?:ed|ing)\s+/i, "Renamed", "files"],
    [/^Replac(?:ed|ing)\s+/i, "Replaced", "files"],
    [/^Execut(?:ed|ing)\s*:?\s*/i, "Executed", "commands"],
    [/^Scan(?:ned|ning)\s+/i, "Scanned", "files"],
    [/^Browser:\s*/i, "Browser", "actions"],
    [/^Finding\s+/i, "Searched", "files"],
]

function extractVerbAndNoun(header: string): { verb: string; noun: string } {
    for (const [pattern, verb, noun] of VERB_PATTERNS) {
        if (pattern.test(header)) {
            return { verb, noun }
        }
    }
    return { verb: "Processed", noun: "items" }
}

/** Strip the action verb prefix from a card header, leaving the target/detail. */
export function stripVerbPrefix(header: string): string {
    for (const [pattern] of VERB_PATTERNS) {
        if (pattern.test(header)) {
            return header.replace(pattern, "")
        }
    }
    return header
}

function statusToCategory(status: CardStatus): ItemSummary["status"] {
    switch (status) {
        case CardStatus.SUCCESS:
            return "success"
        case CardStatus.ERROR:
        case CardStatus.ABANDONED:
            return "error"
        case CardStatus.SKIPPED:
            return "skipped"
        case CardStatus.CANCELLED:
            return "cancelled"
        default:
            return "success"
    }
}

function extractItemSummary(card: Card): ItemSummary {
    return {
        text: stripVerbPrefix(card.header),
        status: statusToCategory(card.status),
    }
}

function makeBatchId(messages: DiracMessage[]): string {
    const firstId =
        messages[0].content.type === DiracMessageType.CARD ? messages[0].content.card.id : messages[0].id
    return `batch-${firstId}-${messages.length}`
}

/**
 * Scan a flat list of messages and group consecutive terminal-status cards
 * that share the same tool icon into batches. Single cards pass through as-is.
 *
 * Minimum batch size is 2. Only committed (terminal) cards are batched;
 * running/pending cards always appear as singles.
 */
export function detectBatches(messages: DiracMessage[]): MessageGroup[] {
    const result: MessageGroup[] = []
    let i = 0

    while (i < messages.length) {
        const msg = messages[i]

        // Only batch card messages in terminal status
        if (msg.content.type !== DiracMessageType.CARD || !isFinalStatus(msg.content.card.status)) {
            result.push({ type: "single", message: msg })
            i++
            continue
        }

        const currentIcon = msg.content.card.icon
        const run: DiracMessage[] = [msg]
        let j = i + 1

        while (j < messages.length) {
            const next = messages[j]
            if (next.content.type !== DiracMessageType.CARD || !isFinalStatus(next.content.card.status)) {
                break
            }
            if (next.content.card.icon !== currentIcon) {
                break
            }
            run.push(next)
            j++
        }

        if (run.length >= 2) {
            const firstCard =
                run[0].content.type === DiracMessageType.CARD ? run[0].content.card : null
            const { verb, noun } = firstCard
                ? extractVerbAndNoun(firstCard.header)
                : { verb: "Processed", noun: "items" }

            let successCount = 0
            let errorCount = 0
            const itemSummaries: ItemSummary[] = []

            for (const m of run) {
                if (m.content.type === DiracMessageType.CARD) {
                    const card = m.content.card
                    itemSummaries.push(extractItemSummary(card))
                    if (card.status === CardStatus.SUCCESS) {
                        successCount++
                    } else {
                        errorCount++
                    }
                }
            }

            let totalAdditions = 0
            let totalDeletions = 0
            for (const m of run) {
                if (m.content.type === DiracMessageType.CARD) {
                    const b = m.content.card.body || ""
                    const bLines = b.split("\n")
                    totalAdditions += bLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
                    totalDeletions += bLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length
                }
            }

            result.push({
                type: "batch",
                batchId: makeBatchId(run),
                messages: run,
                icon: currentIcon,
                actionVerb: verb,
                noun,
                successCount,
                errorCount,
                totalCount: run.length,
                totalAdditions,
                totalDeletions,
                itemSummaries,
            })
        } else {
            result.push({ type: "single", message: msg })
        }

        i = j
    }

    return result
}
