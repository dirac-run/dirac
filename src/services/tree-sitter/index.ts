import { Node as SyntaxNode } from "web-tree-sitter"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { LanguageParser } from "./languageParser"

export interface ParsedDefinition {
    lineIndex: number
    text: string
    indentation: string
    lineCount?: number
    calls?: string[]
}

export async function parseFile(
    filePath: string,
    languageParsers: LanguageParser,
    diracIgnoreController?: DiracIgnoreController,
    options?: { showCallGraph?: boolean },
): Promise<ParsedDefinition[] | null> {
    if (diracIgnoreController && !diracIgnoreController.validateAccess(filePath)) {
        return null
    }
    const fileContent = await fs.readFile(filePath, "utf8")
    const ext = path.extname(filePath).toLowerCase().slice(1)

    const { parser, query } = languageParsers[ext] || {}
    if (!parser || !query) {
        return null
    }

    const definitions: ParsedDefinition[] = []

    try {
        // Parse the file content into an Abstract Syntax Tree (AST)
        const tree = parser.parse(fileContent)
        if (!tree || !tree.rootNode) {
            return null
        }

        // Apply the query to the AST and get the captures
        const captures = query.captures(tree.rootNode)

        // Collect all defined names for the call graph
        const definedNames = new Set<string>()
        const allReferences: { node: SyntaxNode; text: string; line: number }[] = []

        // Pre-identify definition blocks for better line count accuracy
        // Use node ID to handle potential multiple captures of the same node
        const definitionNodes = new Map<number, string>()
        captures.forEach((capture) => {
            // Captures that include "definition" but not "name.definition" represent the full encompassing block
            // We use includes() and check for "name.definition" to be robust against leading "@" symbols
            if (capture.name.includes("definition") && !capture.name.includes("name.definition")) {
                definitionNodes.set(capture.node.id, capture.name)
            }

            if (options?.showCallGraph) {
                if (capture.name.includes("name.definition.function") || capture.name.includes("name.definition.method")) {
                    definedNames.add(capture.node.text)
                } else if (capture.name.includes("name.reference")) {
                    allReferences.push({
                        node: capture.node,
                        text: capture.node.text,
                        line: capture.node.startPosition.row,
                    })
                }
            }
        })

        // Sort captures by their start position
        captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

        // Split the file content into individual lines
        const lines = fileContent.split("\n")

        // Keep track of the last line we've added to the output
        let lastLineAdded = -1

        captures.forEach((capture) => {
            const { node, name } = capture
            const startLine = node.startPosition.row

            // Only process captures that represent a definition identifier (name.definition)
            if (!name.includes("name.definition") || !lines[startLine]) {
                return
            }

            // Only add the line if it hasn't been added yet (deduplication)
            if (startLine > lastLineAdded) {
                const def: ParsedDefinition = {
                    lineIndex: startLine,
                    text: lines[startLine],
                    indentation: lines[startLine].match(/^\s*/)?.[0] || "",
                }
                lastLineAdded = startLine

                // Add line count and optionally call graph
                if (options?.showCallGraph) {
                    // Find the actual definition node (the one that encompasses the whole block)
                    // We look for the closest ancestor that was identified as a definition block
                    let definitionNode: SyntaxNode | null = null
                    let current: SyntaxNode | null = node
                    while (current) {
                        if (definitionNodes.has(current.id)) {
                            definitionNode = current
                            break
                        }
                        current = current.parent
                    }

                    if (definitionNode) {
                        const startRow = definitionNode.startPosition.row
                        const endRow = definitionNode.endPosition.row
                        const lineCount = endRow - startRow + 1

                        if (
                            name.includes("name.definition.function") ||
                            name.includes("name.definition.method") ||
                            name.includes("name.definition.class") ||
                            name.includes("name.definition.interface")
                        ) {
                            def.lineCount = lineCount
                        }

                        if (name.includes("name.definition.function") || name.includes("name.definition.method")) {
                            const localCalls = new Set<string>()

                            allReferences.forEach((ref) => {
                                // Check if reference is within the definition's body
                                if (
                                    ref.line >= startRow &&
                                    ref.line <= endRow &&
                                    definedNames.has(ref.text) &&
                                    ref.text !== node.text
                                ) {
                                    if (isCallNode(ref.node)) {
                                        localCalls.add(ref.text)
                                    }
                                }
                            })

                            if (localCalls.size > 0) {
                                def.calls = Array.from(localCalls)
                            }
                        }
                    }
                }
                definitions.push(def)
            }
        })
    } catch (error) {
        Logger.log(`Error parsing file: ${error}\n`)
    }

    if (definitions.length > 0) {
        return definitions
    }
    return null
}

function isCallNode(node: SyntaxNode): boolean {
    const parent = node.parent
    if (!parent) return false

    const callTypes = [
        "call",
        "call_expression",
        "method_invocation",
        "function_call_expression",
        "member_call_expression",
        "invocation_expression",
    ]
    if (callTypes.includes(parent.type)) {
        return true
    }

    const memberTypes = ["member_expression", "member_access_expression", "property_access", "member_call_expression"]
    if (memberTypes.includes(parent.type)) {
        const grandParent = parent.parent
        if (grandParent && callTypes.includes(grandParent.type)) {
            return true
        }
    }
    return false
}
