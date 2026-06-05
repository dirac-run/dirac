import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { CardStatus } from "@/shared/ExtensionMessage"
import { formatResponse } from "../../../../prompts/responses"
import { TOOL_EXAMPLES } from "../../../../prompts/tool-examples"

export interface GetFunctionArgs {
    paths: string[]
    function_names: string[]
}

export const get_function_spec: DiracToolSpec = {
    id: DiracDefaultTool.GET_FUNCTION,
    name: "get_function",
    description:
        "Extracts the complete implementation of one or more functions or methods from one or more files. Use this to inspect specific functions' logic without reading the entire files. You can specify multiple files and multiple functions, it will return an all to all lookup result. Use dot-separated path to the function.",
    parameters: [
        {
            name: "paths",
            required: true,
            type: "array",
            items: { type: "string" },
            instruction: "An array of relative paths to the source files.",
            usage: '["src/utils/math.ts", "src/utils/string.ts"]',
        },
        {
            name: "function_names",
            required: true,
            type: "array",
            items: { type: "string" },
            instruction: "Exact names of the functions or methods to extract.",
            usage: '["calculateTotal", "StringHelper.format"]',
        },
    ],
}

export class GetFunctionTool implements IDiracTool<GetFunctionArgs> {
    private updateMistakeCount(env: IToolEnvironment, shouldReset: boolean) {
        const currentCount = env.orchestration.getTaskState("consecutiveMistakeCount")
        if (shouldReset) {
            env.orchestration.setTaskState("consecutiveMistakeCount", 0)
        } else {
            env.orchestration.setTaskState("consecutiveMistakeCount", currentCount + 1)
        }
    }

    spec(): DiracToolSpec {
        return get_function_spec
    }

    supportedSurfaces(): SurfaceType[] {
        return ["all"]
    }

    async processCall(args: GetFunctionArgs, env: IToolEnvironment): Promise<any> {
        const paths = Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []
        const functionNames = Array.isArray(args.function_names) ? args.function_names : args.function_names ? [args.function_names] : []

        if (paths.length === 0 || functionNames.length === 0) {
            return this.handleMissingParameters(paths, env)
        }

        const results: string[] = []
        const foundNamesTotal = new Set<string>()
        const functionHashes = env.context.task.get<Record<string, string>>("functionHashes") || {}

        for (const relPath of paths) {
            const result = await this.processFile(relPath, functionNames, functionHashes, env)
            results.push(result.content)
            for (const name of result.foundNames) {
                foundNamesTotal.add(name)
            }
        }

        await env.context.task.set("functionHashes", functionHashes)
        this.updateMistakeCount(env, true)

        env.telemetry.captureCustomMetadata({
            foundFunctionNames: Array.from(foundNamesTotal),
            missingFunctionNames: functionNames.filter((name) => !foundNamesTotal.has(name)),
        })

        return this.formatFinalResult(results, functionNames, foundNamesTotal)
    }

    private async handleMissingParameters(paths: string[], env: IToolEnvironment): Promise<string> {
        this.updateMistakeCount(env, false)
        const paramName = paths.length === 0 ? "paths" : "function_names"
        const example = TOOL_EXAMPLES[DiracDefaultTool.GET_FUNCTION]

        if (!env.config.isSubagentExecution) {
            await env.ui.upsertText(`Dirac tried to use ${DiracDefaultTool.GET_FUNCTION} without providing a value for '${paramName}'. Retrying...`)
        }

        return formatResponse.toolError(formatResponse.missingToolParameterError(paramName, example))
    }

    private async processFile(
        relPath: string,
        functionNames: string[],
        functionHashes: Record<string, string>,
        env: IToolEnvironment,
    ): Promise<{ content: string; foundNames: string[] }> {
        const isSubagent = env.config.isSubagentExecution
        let card: any | undefined

        try {
            const { absolutePath, displayPath } = await env.workspace.resolvePath(relPath)
            card = !isSubagent
                ? await env.ui.createCard({
                    header: `Extracting ${functionNames[0]}${functionNames.length > 1 ? ` (+${functionNames.length - 1} more)` : ""} from ${displayPath}`,
                    icon: DiracIcon.FUNCTION_EXTRACT,
                    collapsed: true,
                })
                : undefined
            const result = await env.ast.getFunctions(absolutePath, displayPath, functionNames)

            if (result) {
                const processedFuncs = this.processFunctionHashes(relPath, result.formattedContent, functionHashes)
                const bodyLines = result.foundNames.map((name) => `✓ ${name}`)
                await card?.update({
                    header: `Extracted ${functionNames[0]}${functionNames.length > 1 ? ` (+${functionNames.length - 1} more)` : ""} from ${displayPath}`,
                    status: result.foundNames.length > 0 ? CardStatus.SUCCESS : CardStatus.ERROR,
                    body: bodyLines.length > 0 ? bodyLines.join("\n") : `No requested functions found in ${displayPath}`,
                })
                await card?.finalize(result.foundNames.length > 0 ? CardStatus.SUCCESS : CardStatus.ERROR)
                return { content: processedFuncs.join("\n\n---\n\n"), foundNames: result.foundNames }
            } else {
                await card?.update({
                    status: CardStatus.ERROR,
                    body: `Access denied or file not found: ${displayPath}`,
                })
                await card?.finalize(CardStatus.ERROR)
                return {
                    content: `None of the requested functions (${functionNames.join(", ")}) were found in ${relPath}`,
                    foundNames: [],
                }
            }
        } catch (error: any) {
            await card?.update({ status: CardStatus.ERROR, body: `Error: ${error.message}` })
            await card?.finalize(CardStatus.ERROR)
            return { content: `Error extracting functions from ${relPath}: ${error.message}`, foundNames: [] }
        }
    }

    private processFunctionHashes(relPath: string, formattedContent: string, functionHashes: Record<string, string>): string[] {
        const individualFuncs = formattedContent.split("\n\n---\n\n")
        const processedFuncs: string[] = []

        for (const funcContent of individualFuncs) {
            const firstLine = funcContent.split("\n")[0]
            const functionName = firstLine.split("::")[1]

            if (functionName) {
                const currentHashMatch = funcContent.match(/\[Function Hash: ([a-f0-9]+)\]/)
                const currentHash = currentHashMatch ? currentHashMatch[1] : undefined
                const cacheKey = `${relPath}::${functionName}`
                const lastKnownHash = functionHashes[cacheKey]

                if (currentHash && lastKnownHash === currentHash) {
                    processedFuncs.push(
                        `${firstLine}\nno changes have been made to the function since your last read (Hash: ${currentHash})`,
                    )
                } else {
                    processedFuncs.push(funcContent)
                    if (currentHash) {
                        functionHashes[cacheKey] = currentHash
                    }
                }
            } else {
                processedFuncs.push(funcContent)
            }
        }
        return processedFuncs
    }

    private formatFinalResult(results: string[], functionNames: string[], foundNamesTotal: Set<string>): string {
        const missingNamesTotal = functionNames.filter((name) => !foundNamesTotal.has(name))
        let finalResult = results.join("\n\n" + "=".repeat(20) + "\n\n")

        if (missingNamesTotal.length > 0) {
            finalResult += `\n\nNote: The following functions were not found in any of the provided files: ${missingNamesTotal.join(
                ", ",
            )}`
        }
        return finalResult
    }
}
