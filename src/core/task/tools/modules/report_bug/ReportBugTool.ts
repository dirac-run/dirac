import { showSystemNotification } from "@integrations/notifications"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { createAndOpenGitHubIssue } from "@utils/github-url-utils"
import { formatResponse } from "@core/formatResponse"
import { TOOL_EXAMPLES } from "@core/tool-examples"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"

export const report_bug_spec: DiracToolSpec = {
	id: DiracDefaultTool.REPORT_BUG,
	name: "report_bug",
	description:
		"Submit a bug report to the Dirac GitHub page. Collects system information and opens a pre-filled GitHub issue template.",
	parameters: [
		{
			name: "title",
			required: true,
			instruction: "Concise description of the issue.",
		},
		{
			name: "what_happened",
			required: true,
			instruction: "What happened and also what the user expected to happen instead.",
		},
		{
			name: "steps_to_reproduce",
			required: true,
			instruction: "What steps are required to reproduce the bug.",
		},
		{
			name: "api_request_output",
			required: true,
			instruction: "Relevant API request output.",
		},
		{
			name: "additional_context",
			required: true,
			instruction: "Any other context about this bug not already mentioned.",
		},
	],
}

export class ReportBugTool implements IDiracTool {
	spec(): DiracToolSpec {
		return report_bug_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		if (env.config.isSubagentExecution) {
			return "Bug reporting is not supported in subagents."
		}

		const validationError = await this.validateParameters(args, env)
		if (validationError) return validationError

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		this.notifyUser(args.title, env)

		const systemInfo = await env.system.getSystemInfo()
		const bugReportData = this.prepareBugReportData(args, systemInfo)

		const card = await env.ui.createCard({
			header: `Bug Report: ${args.title}`,
			icon: DiracIcon.BUG,
			collapsed: false,
		})
		await card.update({
			body: `**Title:** ${args.title}\n\n**What happened:** ${args.what_happened}\n\n**Steps to reproduce:** ${args.steps_to_reproduce}`,
		})

		await this.setupCardActions(card)

		const interaction = await card.waitForInteraction()
		const askResponse = {
			text: interaction.text || (interaction.action === "submit" ? "" : interaction.value || "cancelled"),
			images: [] as string[],
			files: [] as string[],
		}

		if (this.hasUserFeedback(askResponse)) {
			return this.collectBugReportFeedback(askResponse, card, env)
		}

		return this.submitBugReport(args, systemInfo, card)
	}

	private async validateParameters(args: any, env: IToolEnvironment): Promise<any | null> {
		const requiredParams = ["title", "what_happened", "steps_to_reproduce", "api_request_output", "additional_context"]
		for (const param of requiredParams) {
			if (!args[param]) {
				const currentMistakeCount = (env.orchestration.getTaskState("consecutiveMistakeCount") || 0) + 1
				env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount)
				await env.ui.upsertText(
					`Dirac tried to use ${DiracDefaultTool.REPORT_BUG} without providing a value for '${param}'. Retrying...`,
				)
				return formatResponse.toolError(
					formatResponse.missingToolParameterError(param, TOOL_EXAMPLES[DiracDefaultTool.REPORT_BUG]),
				)
			}
		}
		return null
	}

	private notifyUser(title: string, env: IToolEnvironment) {
		if (env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dirac wants to create a github issue...",
				message: `Dirac is suggesting to create a github issue with the title: ${title}`,
			})
		}
	}

	private prepareBugReportData(args: any, systemInfo: any): string {
		return JSON.stringify({
			title: args.title,
			what_happened: args.what_happened,
			steps_to_reproduce: args.steps_to_reproduce,
			api_request_output: args.api_request_output,
			additional_context: args.additional_context,
			provider_and_model: systemInfo.providerAndModel,
			operating_system: systemInfo.operatingSystem,
			system_info: systemInfo.systemInfo,
			dirac_version: systemInfo.diracVersion,
		})
	}

	private async setupCardActions(card: any) {
		await card.update({
			requireFeedback: true,
			feedbackPlaceholder: "Add more details or click Submit...",
			actions: [
				{ label: "Submit Bug Report", value: "submit", primary: true },
				{ label: "Cancel", value: "cancel", style: "secondary" },
			],
		})
	}

	private hasUserFeedback(askResponse: any): boolean {
		return !!(
			askResponse.text ||
			(askResponse.images && askResponse.images.length > 0) ||
			(askResponse.files && askResponse.files.length > 0)
		)
	}

	private async collectBugReportFeedback(askResponse: any, card: any, env: IToolEnvironment): Promise<any> {
		let fileContentString = ""
		if (askResponse.files && askResponse.files.length > 0) {
			fileContentString = await processFilesIntoText(askResponse.files)
		}

		await env.ui.upsertText(askResponse.text ?? "", false, "user")

		await card.update({
			status: CardStatus.SKIPPED,
			body: `User provided feedback instead of submitting the bug report.`,
		})

		return formatResponse.toolResult(
			`The user did not submit the bug, and provided feedback on the Github issue generated instead:\n<feedback>\n${askResponse.text}\n</feedback>`,
			askResponse.images,
			fileContentString,
		)
	}

	private async submitBugReport(args: any, systemInfo: any, card: any): Promise<string> {
		try {
			const params = new Map<string, string>()
			params.set("title", args.title)
			params.set("operating-system", systemInfo.operatingSystem)
			params.set("dirac-version", systemInfo.diracVersion)
			params.set("system-info", systemInfo.systemInfo)
			params.set("additional-context", args.additional_context)
			params.set("what-happened", args.what_happened)
			params.set("steps", args.steps_to_reproduce)
			params.set("provider-model", systemInfo.providerAndModel)
			params.set("logs", args.api_request_output)

			await createAndOpenGitHubIssue("dirac", "dirac", "bug_report.yml", params)

			await card.update({
				header: "Bug Report Submitted",
				status: CardStatus.SUCCESS,
				collapsed: true,
			})
			await card.finalize(CardStatus.SUCCESS)
			return "The user accepted the creation of the Github issue."
		} catch (error: any) {
			await card.update({ status: CardStatus.ERROR, body: error.message })
			await card.finalize(CardStatus.ERROR)
			throw error
		}
	}
}
