import { GlobalFileNames } from "@core/storage/disk"
import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import { DiracContent, DiracTextContentBlock, DiracUserToolResultContentBlock } from "@shared/messages/content"
import { SkillMetadata } from "@/shared/skills"
import { ensureLocalDiracDirExists } from "../context/instructions/user-instructions/rule-helpers"
import { getOrDiscoverSkills } from "../context/instructions/user-instructions/skills"
import { refreshWorkflowToggles } from "../context/instructions/user-instructions/workflows"
import { FileContextLoader } from "./context/FileContextLoader"
import { MentionContextLoader } from "./context/MentionContextLoader"
import { ContextLoaderDependencies } from "./types/context-loader"

type ToolResultBlock = DiracUserToolResultContentBlock
function isToolResultBlock(block: DiracContent): block is ToolResultBlock {
	return block.type === "tool_result"
}

export class ContextLoader {
	private fileContextLoader: FileContextLoader
	private mentionContextLoader: MentionContextLoader

	constructor(private dependencies: ContextLoaderDependencies) {
		this.fileContextLoader = new FileContextLoader(dependencies)
		this.mentionContextLoader = new MentionContextLoader(dependencies, this.fileContextLoader)
	}

	// Load and enrich context for all user content blocks, returning processed content, env details, skills, and direct response info
	async loadContext(
		userContent: DiracContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DiracContent[], string, boolean, SkillMetadata[], boolean, string?]> {
		let needsDiracrulesFileCheck = false
		const cwd = this.dependencies.cwd
		const { localWorkflowToggles, globalWorkflowToggles } = await refreshWorkflowToggles(this.dependencies.stateManager, cwd)

		// Discover and filter skills by toggles
		const availableSkills = await this.resolveAvailableSkills(cwd)
		this.dependencies.taskState.availableSkills = availableSkills

		let isDirectResponse = false
		let directResponseText: string | undefined

		// Parse a single text block through mention/slash enrichment
		const parseTextBlock = async (text: string): Promise<string> => {
			const {
				enrichedText,
				needsDiracrulesFileCheck: needsCheck,
				isDirectResponse: direct,
				directResponseText: directText,
			} = await this.mentionContextLoader.enrichContext(
				text,
				cwd,
				localWorkflowToggles,
				globalWorkflowToggles,
				this.dependencies.ulid,
				this.dependencies.getCurrentProviderInfo(),
				includeFileDetails,
				availableSkills,
			)
			if (needsCheck) needsDiracrulesFileCheck = true
			if (direct) {
				directResponseText = directText
				isDirectResponse = true
			}
			return enrichedText
		}

		// Process all content and environment details in parallel
		const [processedUserContent, environmentDetails] = await Promise.all([
			Promise.all(userContent.map((block) => this.processContentBlock(block, parseTextBlock))),
			this.dependencies.getEnvironmentDetails(includeFileDetails),
		])

		const diracrulesError = needsDiracrulesFileCheck
			? await ensureLocalDiracDirExists(this.dependencies.cwd, GlobalFileNames.diracRules)
			: false

		return [processedUserContent, environmentDetails, diracrulesError, availableSkills, isDirectResponse, directResponseText]
	}

	// Discover skills and filter by global/local toggles
	private async resolveAvailableSkills(cwd: string): Promise<SkillMetadata[]> {
		const resolvedSkills = await getOrDiscoverSkills(cwd, this.dependencies.taskState)
		const globalToggles = this.dependencies.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localToggles = this.dependencies.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		return resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalToggles : localToggles
			return toggles[skill.path] !== false
		})
	}

	// Process a single content block, delegating text/tool_result handling
	private async processContentBlock(
		block: DiracContent,
		parseTextBlock: (text: string) => Promise<string>,
	): Promise<DiracContent> {
		if (block.type === "text") return this.processTextContent(block, parseTextBlock)
		if (isToolResultBlock(block)) return this.processToolResult(block, parseTextBlock)
		return block
	}

	// Process a text block only if it contains a USER_CONTENT_TAG
	private async processTextContent(
		block: DiracTextContentBlock,
		parseTextBlock: (text: string) => Promise<string>,
	): Promise<DiracTextContentBlock> {
		if (block.type !== "text" || !this.hasUserContentTag(block.text)) return block
		const processedText = await parseTextBlock(block.text)
		return { ...block, text: processedText }
	}

	// Process a tool_result block, handling string and array content
	private async processToolResult(
		block: ToolResultBlock,
		parseTextBlock: (text: string) => Promise<string>,
	): Promise<DiracContent> {
		if (!block.content) return block

		// String content: skip tool output, otherwise convert to array and process
		if (typeof block.content === "string") {
			if (this.isLikelyToolOutput(block.content)) return block
			const processed = await this.processTextContent({ type: "text", text: block.content }, parseTextBlock)
			return { ...block, content: [processed] }
		}

		// Array content: process each text block, skipping tool output
		if (Array.isArray(block.content)) {
			const processedContent = await Promise.all(
				block.content.map(async (contentBlock) => {
					if (contentBlock.type === "text") {
						if (this.isLikelyToolOutput(contentBlock.text)) return contentBlock
						return this.processTextContent(contentBlock, parseTextBlock)
					}
					return contentBlock
				}),
			)
			return { ...block, content: processedContent }
		}

		return block
	}

	// Check if text contains any USER_CONTENT_TAG
	private hasUserContentTag(text: string): boolean {
		return USER_CONTENT_TAGS.some((tag: string) => text.includes(tag))
	}

	// Detect read_file tool output by signature markers to skip mention processing
	private isLikelyToolOutput(text: string): boolean {
		return text.includes("[File Hash:") || text.includes("--- ")
	}
}
