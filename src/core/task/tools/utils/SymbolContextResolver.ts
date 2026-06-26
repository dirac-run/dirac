import { formatLineWithHash } from "@utils/line-hashing"
import { Parser, Node as SyntaxNode, QueryCapture } from "web-tree-sitter"
import { Logger } from "@/shared/services/Logger"

export interface SymbolContextResolverOptions {
	node: SyntaxNode
	fileContent: string
	parser: Parser
	ext: string
	anchors: string[]
	maxContextLines?: number
	rootNode?: SyntaxNode
}

export class SymbolContextResolver {
	private static readonly MAX_CONTEXT_LINES = 30

	/**
	 * Resolves relevant context (imports and class properties) for a given symbol node.
	 */
	static async resolve(options: SymbolContextResolverOptions): Promise<string> {
		const {
			node,
			fileContent,
			parser,
			ext,
			anchors,
			maxContextLines = SymbolContextResolver.MAX_CONTEXT_LINES,
			rootNode: providedRootNode,
		} = options

		const language = parser.language
		if (!language) return ""
		const queryStrings = SymbolContextResolver.getQueryStrings(ext)
		if (!queryStrings) {
			return ""
		}

		try {
			const tree = parser.parse(fileContent)
			const rootNode = providedRootNode || tree?.rootNode
			if (!rootNode) return ""
			const query = language.query(queryStrings.contextQuery)
			const captures = query.captures(rootNode)
			// 1. Identify all identifiers used within the target node
			const usedIdentifiers = SymbolContextResolver.getUsedIdentifiers(node)

			// 2. Identify relevant imports
			const relevantImports = SymbolContextResolver.getRelevantImports(
				captures,
				usedIdentifiers,
				queryStrings.importCaptureName,
			)

			// 3. Identify parent class and relevant properties
			const classContext = SymbolContextResolver.getClassContext(node, captures, usedIdentifiers, queryStrings)

			// 4. Assemble and cap
			return SymbolContextResolver.assembleContext(relevantImports, classContext, fileContent, anchors, maxContextLines)
		} catch (error) {
			Logger.error(`Error resolving symbol context for .${ext}:`, error)
			return ""
		}
	}

	private static getQueryStrings(ext: string) {
		switch (ext) {
			case "ts":
			case "tsx":
			case "js":
			case "jsx":
				return {
					contextQuery: `
						(import_statement) @import
						(class_declaration) @class
						(class_heritage) @class.heritage
						(public_field_definition) @property
						(field_definition) @property
						(method_definition) @method
						(identifier) @ref
						(property_identifier) @ref
					`,
					importCaptureName: "import",
					classCaptureName: "class",
					classNodeTypes: ["class_declaration"],
					propertyCaptureNames: ["property"],
					referenceCaptureNames: ["ref"],
				}
			case "py":
				return {
					contextQuery: `
						(import_from_statement) @import
						(import_statement) @import
						(class_definition) @class
						(function_definition) @method
						(assignment left: (attribute object: (identifier) @self attribute: (identifier) @property)) @property
						(identifier) @ref
					`,
					importCaptureName: "import",
					classCaptureName: "class",
					classNodeTypes: ["class_definition"],
					propertyCaptureNames: ["property"],
					referenceCaptureNames: ["ref"],
				}
			case "java":
				return {
					contextQuery: `
						(import_declaration) @import
						(class_declaration) @class
						(field_declaration) @property
						(method_declaration) @method
						(identifier) @ref
					`,
					importCaptureName: "import",
					classCaptureName: "class",
					classNodeTypes: ["class_declaration"],
					propertyCaptureNames: ["property"],
					referenceCaptureNames: ["ref"],
				}
			default:
				return null
		}
	}

	private static getUsedIdentifiers(node: SyntaxNode): Set<string> {
		const identifiers = new Set<string>()
		const walk = (n: SyntaxNode) => {
			if (n.type.includes("identifier")) {
				identifiers.add(n.text)
			}
			for (let i = 0; i < n.childCount; i++) {
				walk(n.child(i)!)
			}
		}
		walk(node)
		return identifiers
	}

	private static getRelevantImports(
		captures: QueryCapture[],
		usedIdentifiers: Set<string>,
		importCaptureName: string,
	): SyntaxNode[] {
		const relevant = []
		for (const capture of captures) {
			if (capture.name === importCaptureName) {
				const importText = capture.node.text
				// Check if any used identifier appears in the import statement
				for (const id of usedIdentifiers) {
					// Use word boundaries to avoid partial matches
					const regex = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
					if (regex.test(importText)) {
						relevant.push(capture.node)
						break
					}
				}
			}
		}
		return relevant
	}

	private static getClassContext(node: SyntaxNode, captures: QueryCapture[], usedIdentifiers: Set<string>, queryStrings: any) {
		let parent = node.parent
		while (parent && !queryStrings.classNodeTypes.includes(parent.type)) {
			parent = parent.parent
		}

		if (!parent) {
			return null
		}

		const classNode = parent
		const propertyNodes: SyntaxNode[] = []

		for (const capture of captures) {
			if (queryStrings.propertyCaptureNames.includes(capture.name)) {
				// Search upwards from property capture to see if it belongs to this class
				let propertyParent = capture.node.parent
				let belongsToClass = false
				while (propertyParent) {
					if (propertyParent === classNode) {
						belongsToClass = true
						break
					}
					propertyParent = propertyParent.parent
				}

				if (belongsToClass) {
					// We need to find the name of the property to see if it's used
					let nameNode: SyntaxNode | null = null

					// 1. Try "name" field (standard for many grammars)
					nameNode = capture.node.childForFieldName("name")

					// 2. If not found, look for identifiers within the node
					if (!nameNode) {
						const findName = (n: SyntaxNode): SyntaxNode | null => {
							if (
								n.type === "property_identifier" ||
								(n.type === "identifier" && n.text !== "self" && n.text !== "this")
							) {
								return n
							}
							for (let i = 0; i < n.childCount; i++) {
								const found = findName(n.child(i)!)
								if (found) return found
							}
							return null
						}
						nameNode = findName(capture.node)
					}

					if (nameNode && usedIdentifiers.has(nameNode.text)) {
						propertyNodes.push(capture.node)
					}
				}
			}
		}

		return { classNode, propertyNodes }
	}

	private static assembleContext(
		imports: SyntaxNode[],
		classContext: { classNode: SyntaxNode; propertyNodes: SyntaxNode[] } | null,
		fileContent: string,
		anchors: string[],
		maxLines: number,
	): string {
		const lines: { text: string; anchorIdx: number }[] = []
		const fileLines = fileContent.split(/\r?\n/)

		// 1. Add imports
		for (const imp of imports) {
			const start = imp.startPosition.row
			const end = imp.endPosition.row
			for (let i = start; i <= end; i++) {
				lines.push({ text: fileLines[i], anchorIdx: i })
			}
		}

		// 2. Add class head and properties
		if (classContext) {
			const { classNode, propertyNodes } = classContext

			// Add class head (up to the first '{' or start of body)
			const classStart = classNode.startPosition.row
			lines.push({ text: fileLines[classStart], anchorIdx: classStart })

			for (const prop of propertyNodes) {
				const start = prop.startPosition.row
				const end = prop.endPosition.row
				for (let i = start; i <= end; i++) {
					lines.push({ text: fileLines[i], anchorIdx: i })
				}
			}
		}

		// 3. Deduplicate and sort by line number
		const sortedLines = lines
			.sort((a, b) => a.anchorIdx - b.anchorIdx)
			.filter((line, index, self) => index === 0 || line.anchorIdx !== self[index - 1].anchorIdx)

		if (sortedLines.length === 0) return ""

		// 4. Cap and format with '...'
		let result = ""
		let lastLineIdx = -1
		let linesCount = 0

		for (const line of sortedLines) {
			if (linesCount >= maxLines) break

			if (lastLineIdx !== -1 && line.anchorIdx > lastLineIdx + 1) {
				result += "...\n"
			}

			result += formatLineWithHash(line.text, anchors[line.anchorIdx]) + "\n"
			lastLineIdx = line.anchorIdx
			linesCount++
		}

		if (result && lastLineIdx !== -1) {
			result += "...\n"
		}

		return result
	}
}
