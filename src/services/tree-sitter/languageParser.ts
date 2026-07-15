import * as fs from "fs"
import * as path from "path"
import { Parser, Language, Query } from "web-tree-sitter"
import { SymbolIndexTelemetry } from "@/services/symbol-index/SymbolIndexTelemetry"
import {
	cppQuery,
	cQuery,
	csharpQuery,
	goQuery,
	javaQuery,
	javascriptQuery,
	kotlinQuery,
	phpQuery,
	pythonQuery,
	rubyQuery,
	rustQuery,
	swiftQuery,
	typescriptQuery,
	zigQuery,
} from "./queries"

export interface LanguageParser {
	[key: string]: {
		parser: Parser
		query: Query
	}
}

interface LanguageDefinition {
	langName: string
	queryText: string
}

async function loadLanguage(langName: string): Promise<Language> {
	const wasmName = `tree-sitter-${langName}.wasm`
	const searchPaths = [
		path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName),
		path.join(__dirname, wasmName),
		path.join(__dirname, "..", "..", "..", "dist", wasmName),
		path.join(__dirname, "..", "..", "..", "node_modules", "tree-sitter-wasms", "out", wasmName),
	]
	const errors: string[] = []

	for (const wasmPath of searchPaths) {
		try {
			const language = await Language.load(wasmPath)
			SymbolIndexTelemetry.recordGrammarLoad()
			return language
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			errors.push(`${wasmPath}: ${message}`)
		}
	}

	throw new Error(`Could not load WASM for language ${langName}. Attempts: ${errors.join(" | ")}`)
}

let isParserInitialized = false
let initializationPromise: Promise<void> | null = null
const languagePromises = new Map<string, Promise<Language>>()
const parserCache = new Map<string, Parser>()
const queryCache = new Map<string, Query>() // keyed by langName:queryText

// At most one Language.load (and therefore WASM compilation) may be in flight process-wide.
let loadChain: Promise<unknown> = Promise.resolve()

function getLanguage(langName: string): Promise<Language> {
	let promise = languagePromises.get(langName)
	if (!promise) {
		promise = loadChain.then(() => loadLanguage(langName))
		// Keep subsequent loads viable after one failed compilation.
		loadChain = promise.catch(() => {})
		// Do not cache rejections forever: a later request should be able to retry.
		void promise.catch(() => languagePromises.delete(langName))
		languagePromises.set(langName, promise)
	}
	return promise
}

function getParser(langName: string, language: Language): Parser {
	let parser = parserCache.get(langName)
	if (!parser) {
		parser = new Parser()
		parser.setLanguage(language)
		parserCache.set(langName, parser)
	}
	return parser
}

async function initializeParser(): Promise<void> {
	if (isParserInitialized) return
	if (!initializationPromise) {
		initializationPromise = Parser.init({
			locateFile(scriptName: string) {
				const primaryPath = path.join(__dirname, scriptName)
				if (fs.existsSync(primaryPath)) {
					return primaryPath
				}
				return path.join(process.cwd(), "node_modules", "web-tree-sitter", scriptName)
			},
		} as any).then(() => {
			isParserInitialized = true
		})
	}
	return initializationPromise
}

function getLanguageDefinition(extension: string): LanguageDefinition {
	switch (extension) {
		case "js":
		case "jsx":
			return { langName: "javascript", queryText: javascriptQuery }
		case "ts":
			return { langName: "typescript", queryText: typescriptQuery }
		case "tsx":
			return { langName: "tsx", queryText: typescriptQuery }
		case "py":
			return { langName: "python", queryText: pythonQuery }
		case "rs":
			return { langName: "rust", queryText: rustQuery }
		case "go":
			return { langName: "go", queryText: goQuery }
		case "cpp":
		case "hpp":
			return { langName: "cpp", queryText: cppQuery }
		case "c":
		case "h":
			return { langName: "c", queryText: cQuery }
		case "cs":
			return { langName: "c_sharp", queryText: csharpQuery }
		case "rb":
			return { langName: "ruby", queryText: rubyQuery }
		case "java":
			return { langName: "java", queryText: javaQuery }
		case "php":
			return { langName: "php", queryText: phpQuery }
		case "swift":
			return { langName: "swift", queryText: swiftQuery }
		case "kt":
			return { langName: "kotlin", queryText: kotlinQuery }
		case "zig":
			return { langName: "zig", queryText: zigQuery }
		default:
			throw new Error(`Unsupported language: ${extension}`)
	}
}

/**
 * Loads grammar/query/parser triples for file extensions. Parsers are cached per grammar;
 * parser.parse is synchronous, and all asynchronous callers must finish working with a Tree
 * before yielding control so the shared parser is never re-entered while parsing.
 */
export async function loadRequiredLanguageParsers(filesToParse: string[]): Promise<LanguageParser> {
	await initializeParser()
	const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
	const parsers: LanguageParser = {}

	for (const extension of extensionsToLoad) {
		const { langName, queryText } = getLanguageDefinition(extension)
		const language = await getLanguage(langName)
		const queryCacheKey = `${langName}:${queryText}`
		let query = queryCache.get(queryCacheKey)
		if (!query) {
			query = new Query(language, queryText)
			queryCache.set(queryCacheKey, query)
		}

		parsers[extension] = {
			parser: getParser(langName, language),
			query,
		}
	}

	return parsers
}

/** Test-only reset for deterministic cache and retry coverage. */
export function resetLanguageParserCachesForTests(): void {
	for (const parser of parserCache.values()) {
		parser.delete()
	}
	languagePromises.clear()
	parserCache.clear()
	queryCache.clear()
	loadChain = Promise.resolve()
}
