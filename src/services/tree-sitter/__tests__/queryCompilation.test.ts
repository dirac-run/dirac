/**
 * Smoke test: verifies that all tree-sitter query strings compile successfully
 * against their corresponding language WASM grammars.
 *
 * This catches "Bad pattern structure" errors like the one caused by
 * web-tree-sitter 0.22.x not supporting `field: [alternation]` syntax.
 */
import { strict as assert } from "node:assert"
import * as path from "node:path"
import * as fs from "node:fs"
import { Parser, Language } from "web-tree-sitter"
import { describe, it, before } from "mocha"

import {
    javascriptQuery,
    typescriptQuery,
    pythonQuery,
    goQuery,
    rustQuery,
    cQuery,
    cppQuery,
    csharpQuery,
    javaQuery,
    kotlinQuery,
    rubyQuery,
    phpQuery,
    swiftQuery,
    zigQuery,
} from "../queries"

interface QueryTestCase {
    langName: string
    wasmName: string
    queryText: string
}

const testCases: QueryTestCase[] = [
    { langName: "javascript", wasmName: "tree-sitter-javascript.wasm", queryText: javascriptQuery },
    { langName: "typescript", wasmName: "tree-sitter-typescript.wasm", queryText: typescriptQuery },
    { langName: "tsx", wasmName: "tree-sitter-tsx.wasm", queryText: typescriptQuery },
    { langName: "python", wasmName: "tree-sitter-python.wasm", queryText: pythonQuery },
    { langName: "go", wasmName: "tree-sitter-go.wasm", queryText: goQuery },
    { langName: "rust", wasmName: "tree-sitter-rust.wasm", queryText: rustQuery },
    { langName: "c", wasmName: "tree-sitter-c.wasm", queryText: cQuery },
    { langName: "cpp", wasmName: "tree-sitter-cpp.wasm", queryText: cppQuery },
    { langName: "c_sharp", wasmName: "tree-sitter-c_sharp.wasm", queryText: csharpQuery },
    { langName: "java", wasmName: "tree-sitter-java.wasm", queryText: javaQuery },
    { langName: "kotlin", wasmName: "tree-sitter-kotlin.wasm", queryText: kotlinQuery },
    { langName: "ruby", wasmName: "tree-sitter-ruby.wasm", queryText: rubyQuery },
    { langName: "php", wasmName: "tree-sitter-php.wasm", queryText: phpQuery },
    { langName: "swift", wasmName: "tree-sitter-swift.wasm", queryText: swiftQuery },
    { langName: "zig", wasmName: "tree-sitter-zig.wasm", queryText: zigQuery },
]

describe("tree-sitter query compilation", function () {
    this.timeout(30_000)

    before(async () => {
        await Parser.init({
            locateFile(scriptName: string) {
                return path.join(process.cwd(), "node_modules", "web-tree-sitter", scriptName)
            },
        } as any)
    })

    for (const { langName, wasmName, queryText } of testCases) {
        it(`compiles ${langName} query against its WASM grammar`, async () => {
            // Find the WASM file using the same search paths as languageParser.ts
            const searchPaths = [
                path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName),
                path.join(__dirname, "..", wasmName),
                path.join(process.cwd(), "dist", wasmName),
                path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName),
            ]

            let wasmPath: string | undefined
            for (const p of searchPaths) {
                if (fs.existsSync(p)) {
                    wasmPath = p
                    break
                }
            }

            assert.ok(wasmPath, `Could not find WASM for ${langName}: ${wasmName}`)

            const language = await Language.load(wasmPath!)
            // This is the line that throws "Bad pattern structure" on incompatible versions
            const query = language.query(queryText)
            assert.ok(query, `Query for ${langName} should return a valid Query object`)
        })
    }
})
