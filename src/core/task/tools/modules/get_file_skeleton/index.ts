import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { DiracToolSpec, DiracDefaultTool } from "../../../../../shared/tools"
import { CardStatus } from "../../../../../shared/ExtensionMessage"

export interface GetFileSkeletonArgs {
    paths: string[]
}

export const get_file_skeleton_spec: DiracToolSpec = {
    id: DiracDefaultTool.GET_FILE_SKELETON,
    name: "get_file_skeleton",
    description:
        "Reads the structural outline of one or more files by extracting the lines where classes, functions, and methods are defined (including nested definitions) while stripping all implementation logic. Use this to quickly understand multiple files' structures and APIs before requesting specific functions.",
    parameters: [
        {
            name: "paths",
            required: true,
            type: "array",
            items: { type: "string" },
            instruction: "An array of relative paths to the source files.",
            usage: '["src/utils/math.ts", "src/utils/string.py"]',
        },
    ],
}

export class GetFileSkeletonTool implements IDiracTool<GetFileSkeletonArgs, string> {
    spec(): DiracToolSpec {
        return get_file_skeleton_spec
    }

    supportedSurfaces(): SurfaceType[] {
        return ["all"]
    }

    async processCall(args: GetFileSkeletonArgs, env: IToolEnvironment): Promise<string> {
        const { paths } = args

        if (!paths || paths.length === 0) {
            const currentMistakes = env.orchestration.getTaskState("consecutiveMistakeCount")
            env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakes + 1)
            return "Error: No paths provided for get_file_skeleton."
        }

        const isSubagent = env.config.isSubagentExecution
        const cards = !isSubagent ? new Map<string, any>() : undefined

        try {
            const skeletons: { path: string; content: string }[] = []

            for (const relPath of paths) {
                const { absolutePath, displayPath } = await env.workspace.resolvePath(relPath)
                if (cards) {
                    const fileCard = await env.ui.createCard({
                        header: `Extracting skeleton from ${displayPath}`,
                        icon: DiracIcon.SKELETON_EXTRACT,
                        collapsed: true,
                    })
                    cards.set(absolutePath, fileCard)
                }
                try {
                    const skeleton = await env.ast.getSkeleton(absolutePath, { showCallGraph: true })
                    skeletons.push({ path: displayPath, content: skeleton || `No definitions found in ${relPath}` })
                    if (cards) {
                        const defCount = (skeleton || "").split("\n").filter((l: string) => l.trim().length > 0).length
                        await cards.get(absolutePath)?.update({
                            header: `Extracted skeleton from ${displayPath}`,
                            status: CardStatus.SUCCESS,
                            body: `✓ ${defCount} definitions extracted from ${displayPath}`,
                        })
                        await cards.get(absolutePath)?.finalize(CardStatus.SUCCESS)
                    }
                } catch (error) {
                    skeletons.push({
                        path: displayPath,
                        content: `Error parsing ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
                    })
                    if (cards) {
                        await cards.get(absolutePath)?.update({
                            status: CardStatus.ERROR,
                            body: `✕ Error parsing ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
                        })
                        await cards.get(absolutePath)?.finalize(CardStatus.ERROR)
                    }
                }
            }

            // Reset mistake count on successful execution
            env.orchestration.setTaskState("consecutiveMistakeCount", 0)


            const result = skeletons
                .map((s) => `--- ${s.path} ---\nStable Anchors are provided with each line.\n ${s.content}`)
                .join("\n\n")

            const hasFailure = skeletons.some(
                (s) =>
                    s.content.includes("No definitions found") ||
                    s.content.includes("Unsupported file type") ||
                    s.content.includes("Could not parse") ||
                    s.content.includes("Error parsing"),
            )

            // No definitions found or unsupported file types are valid outcomes,
            // not mistakes. Only missing-parameter mistakes are handled above.

            // Cards are updated individually in the loop

            return result
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (cards) {
                for (const fileCard of cards.values()) {
                    await fileCard.update({
                        status: CardStatus.ERROR,
                        body: `✕ Error: ${errorMessage}`,
                    })
                }
            }
            throw error
        }
    }
}
