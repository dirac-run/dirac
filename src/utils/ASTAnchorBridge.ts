import fs from "fs/promises"
import * as path from "path"
import { DiracIgnoreController } from "../core/ignore/DiracIgnoreController"
import { SymbolContextResolver } from "../core/task/tools/utils/SymbolContextResolver"
import { parseFile } from "../services/tree-sitter"
import { loadRequiredLanguageParsers } from "../services/tree-sitter/languageParser"
import { AnchorStateManager } from "./AnchorStateManager"
import { contentHash, formatLineForModel } from "./line-hashing"

export interface SymbolRange {
	startIndex: number
	endIndex: number
	startLine: number
	nameText: string
}

export interface GetFunctionsResult {
	formattedContent: string
	foundNames: string[]
}

export class ASTAnchorBridge {
	/**
	 * Gets the file skeleton, reconciling canonical anchors and revealing them only when requested.
	 */
	public static async getFileSkeleton(
		absolutePath: string,
		diracIgnoreController?: DiracIgnoreController,
		taskId?: string,
		options?: { showCallGraph?: boolean; includeAnchors?: boolean },
	): Promise<string | null> {
		const languageParsers = await loadRequiredLanguageParsers([absolutePath])
		const definitions = await parseFile(absolutePath, languageParsers, diracIgnoreController, options)
		if (!definitions) {
			return null
		}

		const fileContent = await fs.readFile(absolutePath, "utf8")
		const lines = fileContent.split("\n")
		const anchors = AnchorStateManager.reconcile(absolutePath, lines, taskId)
		const revealAnchors = options?.includeAnchors === true

		let formattedOutput = ""
		let lastLineAdded = -1

		for (const def of definitions) {
			const startLine = def.lineIndex

			if (lastLineAdded !== -1 && startLine > lastLineAdded + 1) {
				formattedOutput += "|----\n"
			}

			if (startLine > lastLineAdded) {
				formattedOutput += `│${formatLineForModel(def.text, anchors[startLine], revealAnchors)}\n`
				lastLineAdded = startLine

				if (options?.showCallGraph) {
					if (def.lineCount !== undefined) {
						formattedOutput += `│${def.indentation}    # Lines: ${def.lineCount}\n`
					}
					if (def.calls && def.calls.length > 0) {
						formattedOutput += `│${def.indentation}    # Calls: [${def.calls.sort().join(", ")}]\n`
					}
				}
			}
		}

		if (formattedOutput.length > 0) {
			return `|----\n${formattedOutput}|----\n`
		}
		return null
	}

	/**
	 * Gets specific functions with their context, reconciling canonical anchors and revealing them only when requested.
	 */
	public static async getFunctions(
		absolutePath: string,
		relPath: string,
		functionNames: string[],
		diracIgnoreController?: DiracIgnoreController,
		taskId?: string,
		includeAnchors?: boolean,
	): Promise<GetFunctionsResult | null> {
		if (diracIgnoreController && !diracIgnoreController.validateAccess(absolutePath)) {
			return null
		}

		const languageParsers = await loadRequiredLanguageParsers([absolutePath])
		const ext = path.extname(absolutePath).toLowerCase().slice(1)
		const { parser, query } = languageParsers[ext] || {}

		if (!parser || !query) {
			return {
				formattedContent: `Unsupported file type: ${relPath}`,
				foundNames: [],
			}
		}

		const fileContent = await fs.readFile(absolutePath, "utf8")
		const tree = parser.parse(fileContent)
		if (!tree || !tree.rootNode) {
			return {
				formattedContent: `Could not parse file: ${relPath}`,
				foundNames: [],
			}
		}

		const allLines = fileContent.split(/\r?\n/)
		const allAnchors = AnchorStateManager.reconcile(absolutePath, allLines, taskId)
		const revealAnchors = includeAnchors === true

		const matches = query.matches(tree.rootNode)
		const nodeToMatch = new Map<number, any>()
		for (const match of matches) {
			for (const capture of match.captures) {
				if (capture.name.startsWith("name.")) {
					nodeToMatch.set(capture.node.id, match)
				}
				if (capture.name.startsWith("definition.")) {
					nodeToMatch.set(capture.node.id, match)
				}
			}
		}

		const fileResults: string[] = []
		const foundNamesInFile = new Set<string>()
		const seenRanges = new Set<string>()

		for (const match of matches) {
			const nameCapture = match.captures.find((c: any) => c.name.includes("name.definition"))
			const defCapture =
				match.captures.find((c: any) => c.name.startsWith("definition.")) ||
				match.captures.find((c: any) => !c.name.includes("name"))

			if (nameCapture && defCapture) {
				const nameText = fileContent.slice(nameCapture.node.startIndex, nameCapture.node.endIndex)

				// Calculate full name by walking up the tree
				let fullName = nameText
				let currentNode = defCapture.node
				const seenMatches = new Set<any>([match])
				while (currentNode.parent) {
					currentNode = currentNode.parent
					const parentMatch = nodeToMatch.get(currentNode.id)
					if (parentMatch && !seenMatches.has(parentMatch)) {
						const parentNameCap = parentMatch.captures.find((c: any) => c.name.startsWith("name."))
						if (parentNameCap) {
							const parentNameText = fileContent.slice(parentNameCap.node.startIndex, parentNameCap.node.endIndex)
							fullName = `${parentNameText}.${fullName}`
							seenMatches.add(parentMatch)
						}
					}
				}

				const normalizedFullName = fullName.replace(/::/g, ".")
				const matchedReqNames = functionNames.filter((reqName) => {
					const normalizedReqName = reqName.replace(/::/g, ".")
					if (normalizedFullName === normalizedReqName) return true
					if (normalizedFullName.endsWith("." + normalizedReqName)) return true
					return false
				})

				if (matchedReqNames.length > 0) {
					matchedReqNames.forEach((reqName) => foundNamesInFile.add(reqName))

					const { startIndex, endIndex, startLine } = ASTAnchorBridge.getExtendedRange(defCapture.node, fileContent)

					const rangeKey = `${startIndex}-${endIndex}`
					if (seenRanges.has(rangeKey)) continue
					seenRanges.add(rangeKey)

					const defText = fileContent.slice(startIndex, endIndex)

					const defLines = defText.split(/\r?\n/)
					const defAnchors = allAnchors.slice(startLine, startLine + defLines.length)

					const context = await SymbolContextResolver.resolve({
						node: defCapture.node,
						fileContent,
						parser,
						ext,
						anchors: allAnchors,
						rootNode: tree.rootNode,
					})

					const formatted = defLines.map((line, i) => formatLineForModel(line, defAnchors[i], revealAnchors)).join("\n")
					const funcHash = contentHash(defText)
					const anchorHeader = revealAnchors
						? "All Hash Anchors provided below are stable and can be used with edit_file directly.\n"
						: ""
					fileResults.push(
						`${relPath}::${fullName}\n[Function Hash: ${funcHash}]\n${anchorHeader}${context}${formatted}`,
					)
				}
			}
		}

		if (fileResults.length > 0) {
			return {
				formattedContent: fileResults.join("\n\n---\n\n"),
				foundNames: Array.from(foundNamesInFile),
			}
		}

		return {
			formattedContent: `None of the requested functions (${functionNames.join(", ")}) were found in ${relPath}`,
			foundNames: [],
		}
	}

	/**
	 * Gets the range of a specific symbol for replacement.
	 */
	public static async getSymbolRange(
		absolutePath: string,
		symbol: string,
		type?: string,
		diracIgnoreController?: DiracIgnoreController,
		taskId?: string,
	): Promise<SymbolRange | null> {
		if (diracIgnoreController && !diracIgnoreController.validateAccess(absolutePath)) {
			return null
		}

		const languageParsers = await loadRequiredLanguageParsers([absolutePath])
		const ext = path.extname(absolutePath).toLowerCase().slice(1)
		const { parser, query } = languageParsers[ext] || {}

		if (!parser || !query) {
			return null
		}

		const fileContent = await fs.readFile(absolutePath, "utf8")
		const tree = parser.parse(fileContent)
		if (!tree || !tree.rootNode) {
			return null
		}

		const matches = query.matches(tree.rootNode)
		const nodeToMatch = new Map<number, any>()
		for (const match of matches) {
			for (const capture of match.captures) {
				if (capture.name.startsWith("name.")) {
					nodeToMatch.set(capture.node.id, match)
				}
				if (capture.name.startsWith("definition.")) {
					nodeToMatch.set(capture.node.id, match)
				}
			}
		}

		const normalizedRequestedSymbol = symbol.replace(/::/g, ".")

		for (const match of matches) {
			const nameCapture = match.captures.find((c: any) => c.name.startsWith("name.definition"))
			const defCapture =
				match.captures.find((c: any) => c.name.startsWith("definition.")) ||
				match.captures.find((c: any) => !c.name.startsWith("name."))

			if (nameCapture && defCapture) {
				const nameText = fileContent.slice(nameCapture.node.startIndex, nameCapture.node.endIndex)
				const defType = defCapture.name.split(".").pop() || ""

				let fullName = nameText
				let currentNode = defCapture.node
				const seenMatches = new Set<any>([match])
				while (currentNode.parent) {
					currentNode = currentNode.parent
					const parentMatch = nodeToMatch.get(currentNode.id)
					if (parentMatch && !seenMatches.has(parentMatch)) {
						const parentNameCap = parentMatch.captures.find((c: any) => c.name.startsWith("name."))
						if (parentNameCap) {
							const parentNameText = fileContent.slice(parentNameCap.node.startIndex, parentNameCap.node.endIndex)
							fullName = `${parentNameText}.${fullName}`
							seenMatches.add(parentMatch)
						}
					}
				}

				const normalizedFullName = fullName.replace(/::/g, ".")
				if (
					(normalizedFullName === normalizedRequestedSymbol ||
						normalizedFullName.endsWith("." + normalizedRequestedSymbol)) &&
					ASTAnchorBridge.areTypesCompatible(defType, type)
				) {
					const range = ASTAnchorBridge.getExtendedRange(defCapture.node, fileContent)
					return {
						...range,
						nameText,
					}
				}
			}
		}

		return null
	}

	private static areTypesCompatible(defType: string, reqType?: string): boolean {
		if (!reqType) {
			return true
		}
		if (defType === reqType) {
			return true
		}
		const synonyms = ["function", "method"]
		if (synonyms.includes(defType) && synonyms.includes(reqType)) {
			return true
		}
		return false
	}

	private static getExtendedRange(
		targetNode: any,
		fileContent: string,
	): { startIndex: number; endIndex: number; startLine: number } {
		let startIndex = targetNode.startIndex
		let endIndex = targetNode.endIndex
		let startLine = targetNode.startPosition.row

		let currentNode = targetNode
		const wrapperTypes = [
			"export_statement",
			"export_declaration",
			"ambient_declaration",
			"decorated_definition",
			"internal_module",
		]

		while (currentNode.parent && wrapperTypes.includes(currentNode.parent.type)) {
			currentNode = currentNode.parent
			startIndex = currentNode.startIndex
			endIndex = currentNode.endIndex
			startLine = currentNode.startPosition.row
		}

		while (currentNode.previousNamedSibling) {
			const prev = currentNode.previousNamedSibling
			if (
				prev.type === "comment" ||
				prev.type === "decorator" ||
				prev.type === "attribute" ||
				prev.type.includes("comment")
			) {
				startIndex = prev.startIndex
				startLine = prev.startPosition.row
				currentNode = prev
			} else {
				break
			}
		}

		return { startIndex, endIndex, startLine }
	}
}
