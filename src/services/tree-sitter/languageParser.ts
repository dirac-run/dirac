import * as fs from "fs"
import * as path from "path"
import Parser from "web-tree-sitter"
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
    zigQuery
} from "./queries"

export interface LanguageParser {
    [key: string]: {
        parser: Parser
        query: Parser.Query
    }
}

async function loadLanguage(langName: string) {
    const wasmName = `tree-sitter-${langName}.wasm`
    const searchPaths = [
        path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName),

        path.join(__dirname, wasmName),
        path.join(__dirname, "..", "..", "..", "dist", wasmName),
        path.join(__dirname, "..", "..", "..", "node_modules", "tree-sitter-wasms", "out", wasmName),
    ]

    for (const wasmPath of searchPaths) {
        try {
            return await Parser.Language.load(wasmPath)
        } catch { }
    }
    throw new Error(`Could not find WASM for language: ${langName}`)
}

let isParserInitialized = false
let initializationPromise: Promise<void> | null = null
const languageCache = new Map<string, Parser.Language>()
const queryCache = new Map<string, Parser.Query>() // keyed by langName:queryText

async function initializeParser() {
    if (isParserInitialized) return
    if (!initializationPromise) {
        initializationPromise = Parser.init({
            locateFile(scriptName: string) {
                const primaryPath = path.join(__dirname, scriptName)
                if (fs.existsSync(primaryPath)) {
                    return primaryPath
                }
                // Fallback for dev/test environment where tree-sitter.wasm is in node_modules
                return path.join(process.cwd(), "node_modules", "web-tree-sitter", scriptName)
            },
        }).then(() => {
            isParserInitialized = true
        })
    }
    return initializationPromise
}

/*
Using node bindings for tree-sitter is problematic in vscode extensions 
because of incompatibility with electron. Going the .wasm route has the 
advantage of not having to build for multiple architectures.

We use web-tree-sitter and tree-sitter-wasms which provides auto-updating prebuilt WASM binaries for tree-sitter's language parsers.

This function loads WASM modules for relevant language parsers based on input files:
1. Extracts unique file extensions
2. Maps extensions to language names
3. Loads corresponding WASM files (containing grammar rules)
4. Uses WASM modules to initialize tree-sitter parsers

This approach optimizes performance by loading only necessary parsers once for all relevant files.

Sources:
- https://github.com/tree-sitter/node-tree-sitter/issues/169
- https://github.com/tree-sitter/node-tree-sitter/issues/168
- https://github.com/Gregoor/tree-sitter-wasms/blob/main/README.md
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/query-test.js
*/
export async function loadRequiredLanguageParsers(filesToParse: string[]): Promise<LanguageParser> {
    await initializeParser()
    const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
    const parsers: LanguageParser = {}
    for (const ext of extensionsToLoad) {
        let langName: string
        let queryText: string
        switch (ext) {
            case "js":
            case "jsx":
                langName = "javascript"
                queryText = javascriptQuery
                break
            case "ts":
                langName = "typescript"
                queryText = typescriptQuery
                break
            case "tsx":
                langName = "tsx"
                queryText = typescriptQuery
                break
            case "py":
                langName = "python"
                queryText = pythonQuery
                break
            case "rs":
                langName = "rust"
                queryText = rustQuery
                break
            case "go":
                langName = "go"
                queryText = goQuery
                break
            case "cpp":
            case "hpp":
                langName = "cpp"
                queryText = cppQuery
                break
            case "c":
            case "h":
                langName = "c"
                queryText = cQuery
                break
            case "cs":
                langName = "c_sharp"
                queryText = csharpQuery
                break
            case "rb":
                langName = "ruby"
                queryText = rubyQuery
                break
            case "java":
                langName = "java"
                queryText = javaQuery
                break
            case "php":
                langName = "php"
                queryText = phpQuery
                break
            case "swift":
                langName = "swift"
                queryText = swiftQuery
                break
            case "kt":
                langName = "kotlin"
                queryText = kotlinQuery
                break
            case "zig":
                langName = "zig"
                queryText = zigQuery
                break

            default:
                throw new Error(`Unsupported language: ${ext}`)
        }

        let language = languageCache.get(langName)
        if (!language) {
            language = await loadLanguage(langName)
            languageCache.set(langName, language)
        }

        // Key the query cache on langName + queryText to prevent cross-contamination
        // between languages that share the same query text (e.g., ts and tsx both use typescriptQuery
        // but compile against different language grammars - a Query compiled for one grammar
        // must not be used with a different grammar)
        const queryCacheKey = `${langName}:${queryText}`
        let query = queryCache.get(queryCacheKey)
        if (!query) {
            query = language.query(queryText)
            queryCache.set(queryCacheKey, query)
        }

        const parser = new Parser()
        parser.setLanguage(language)
        parsers[ext] = { parser, query }
    }
    return parsers
}
