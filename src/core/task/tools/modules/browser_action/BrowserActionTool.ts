import { formatResponse } from "@core/formatResponse"
import { BrowserActionResult, CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { DiracImageContentBlock, DiracTextContentBlock } from "@shared/messages/content"
import { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolPermissionDisposition } from "../../autoApprove"
import { SurfaceType } from "../../interfaces/SurfaceType"

export const browser_action_spec: DiracToolSpec = {
	id: DiracDefaultTool.BROWSER,
	name: "browser_action",
	description: `Request to interact with a Puppeteer-controlled browser. Every action, except \`close\`, will be responded to with a screenshot of the browser's current state, along with any new console logs. You may only perform one browser action per message, and wait for the user's response including a screenshot and logs to determine the next action.
- The sequence of actions **must always start with** launching the browser at a URL, and **must always end with** closing the browser. If you need to visit a new URL that is not possible to navigate to from the current webpage, you must first close the browser, then launch again at the new URL.
- While the browser is active, only the \`browser_action\` tool can be used. No other tools should be called during this time. You may proceed to use other tools only after closing the browser. For example if you run into an error and need to fix a file, you must close the browser, then use other tools to make the necessary changes, then re-launch the browser to verify the result.
- The browser window has a resolution of **900x600** pixels. When performing any click actions, ensure the coordinates are within this resolution range.
- Before clicking on any elements such as icons, links, or buttons, you must consult the provided screenshot of the page to determine the coordinates of the element. The click should be targeted at the **center of the element**, not on its edges.`,
	parameters: [
		{
			name: "action",
			required: true,
			type: "string",
			enum: ["launch", "click", "type", "scroll_down", "scroll_up", "close"],
			instruction:
				"Action to perform: launch requires url; click requires coordinate; type requires text; scroll_down and scroll_up scroll one page; close ends the browser session.",
		},
		{
			name: "url",
			required: false,
			instruction: `Use this for providing the URL for the \`launch\` action.`,
		},
		{
			name: "coordinate",
			required: false,
			instruction: `x,y coordinates - The X and Y coordinates for the \`click\` action. Coordinates should be within the **900x600** resolution. Example: '450,300'`,
		},
		{
			name: "text",
			required: false,
			instruction: `Use this for providing the text for the \`type\` action. Example: 'Hello, world!'`,
		},
	],
}

export class BrowserActionTool implements IDiracTool {
	spec(): DiracToolSpec {
		return browser_action_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<string | Array<DiracTextContentBlock | DiracImageContentBlock>> {
		const { action, url, coordinate, text } = args
		const isSubagent = env.config.isSubagentExecution
		const example = '{"action": "launch", "url": "https://google.com"}'
		const utilityPermissionHandlingEnabled = env.config.permissionDecisionBinding !== undefined

		if (!action) {
			return this.reportMissingActionParameter(env, example)
		}

		const card = !isSubagent
			? await env.ui.createCard({
				icon: DiracIcon.BROWSER,
				header: `Browser: ${action}${action === "launch" && url ? ` ${url}` : action === "click" && coordinate ? ` at ${coordinate}` : action === "type" && text ? ` "${text.substring(0, 30)}"` : ""}`,
				collapsed: true,
			})
			: undefined
		try {
			let result: BrowserActionResult

			switch (action) {
				case "launch":
					if (!url) return this.reportMissingUrlParameter(env, card, example)
					const permissionDisposition = utilityPermissionHandlingEnabled
						? this.resolveLaunchPermission(env, url)
						: undefined
					if (permissionDisposition !== "auto_approve") {
						const permissionCard = await env.ui.createCard({
							header: `Launch browser: ${url}`,
							icon: DiracIcon.BROWSER,
							status: CardStatus.WAITING_FOR_INPUT,
							requireApproval: true,
							permissionRequestKind:
								utilityPermissionHandlingEnabled && permissionDisposition === "manual_only"
									? "manual_tool"
									: "tool",
							collapsed: false,
							body: `Dirac wants to launch a browser at ${url}`,
						})
						const interaction = await permissionCard.waitForInteraction()
						const approved = interaction.action === DiracAskResponse.APPROVE
						if (interaction.action === DiracAskResponse.MESSAGE) {
							if (interaction.text) await env.ui.upsertText(interaction.text, false, "user")
							await permissionCard.finalize(CardStatus.SKIPPED)
							if (card) {
								await card.update({ body: `↩ Skipped — user sent a message instead` })
								await card.finalize(CardStatus.SKIPPED)
							}
							return interaction.text
								? formatResponse.toolDeniedWithFeedback(interaction.text)
								: formatResponse.toolDenied()
						}
						await permissionCard.finalize(approved ? CardStatus.SUCCESS : CardStatus.CANCELLED)
						if (!approved) return this.formatLaunchDenialResponse(interaction.value, card)
					}
					if (card) await card.update({ body: `Launching ${url}...` })
					result = await env.browser.launch(url)
					break

				case "click":
					if (!coordinate) return this.reportMissingCoordinateParameter(env, card, example)
					result = await env.browser.click(coordinate)
					break

				case "type":
					if (!text) return this.reportMissingTextParameter(env, card, example)
					result = await env.browser.type(text)
					break

				case "scroll_down":
					result = await env.browser.scroll("down")
					break

				case "scroll_up":
					result = await env.browser.scroll("up")
					break

				case "close":
					await env.browser.close()
					if (card) {
						await card.update({ body: "Browser closed." })
						await card.finalize(CardStatus.SUCCESS)
					}
					return "The browser has been closed. You may now proceed to using other tools."

				default:
					throw new Error(`Unknown browser action: ${action}`)
			}

			return this.formatBrowserActionResult(action, result, card)
		} catch (error: any) {
			return this.abortBrowserWithError(error, card, env)
		}
	}

	private resolveLaunchPermission(env: IToolEnvironment, url: string): ToolPermissionDisposition {
		if (env.config.autoApprover.requiresCounterpartyApproval) return "manual_only"
		const ruleResult = env.config.services.commandPermissionController.validateTool(DiracDefaultTool.BROWSER, url)
		if (!ruleResult.allowed) return "manual_only"
		if (env.config.autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
		if (ruleResult.reason === "allowed" && ruleResult.matchedPattern) return "auto_approve"
		if (env.config.autoApprover.shouldAutoApproveTool(DiracDefaultTool.BROWSER) === true) return "auto_approve"
		return "utility_eligible"
	}

	private async reportMissingActionParameter(env: IToolEnvironment, example: string): Promise<string> {
		const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
		await env.browser.close()
		return `Missing value for required parameter 'action'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
	}

	private async reportMissingUrlParameter(env: IToolEnvironment, card: any, example: string): Promise<string> {
		const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
		await env.browser.close()
		if (card) {
			await card.update({ body: "Missing required parameter 'url' for 'launch' action." })
			await card.finalize(CardStatus.ERROR)
		}
		return `Missing value for required parameter 'url'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
	}

	private async reportMissingCoordinateParameter(env: IToolEnvironment, card: any, example: string): Promise<string> {
		const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
		await env.browser.close()
		if (card) {
			await card.update({ body: "Missing required parameter 'coordinate' for 'click' action." })
			await card.finalize(CardStatus.ERROR)
		}
		return `Missing value for required parameter 'coordinate'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
	}

	private async reportMissingTextParameter(env: IToolEnvironment, card: any, example: string): Promise<string> {
		const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
		await env.browser.close()
		if (card) {
			await card.update({ body: "Missing required parameter 'text' for 'type' action." })
			await card.finalize(CardStatus.ERROR)
		}
		return `Missing value for required parameter 'text'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
	}

	private async formatLaunchDenialResponse(reason: string | undefined, card: any): Promise<string> {
		if (card) {
			await card.update({
				body: `User denied browser launch: ${reason || "No reason provided"}`,
			})
			await card.finalize(CardStatus.CANCELLED)
		}
		return reason ? formatResponse.toolDeniedWithFeedback(reason) : formatResponse.toolDenied()
	}

	private async formatBrowserActionResult(
		action: string,
		result: BrowserActionResult,
		card: any,
	): Promise<Array<DiracTextContentBlock | DiracImageContentBlock>> {
		const responseText = `The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${result.logs || "(No new logs)"
			}\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser. For example, if after analyzing the logs and screenshot you need to edit a file, you must first close the browser before you can use the write_to_file tool.)`

		if (card) {
			await card.update({
				header: `Browser: ${action} (Success)`,
				body: `Action: ${action}\nURL: ${result.currentUrl || "N/A"}\nLogs: ${result.logs || "none"}`,
			})
			await card.finalize(CardStatus.SUCCESS)
		}

		const blocks: Array<DiracTextContentBlock | DiracImageContentBlock> = [{ type: "text", text: responseText }]
		if (result.screenshot) {
			blocks.push(...formatResponse.imageBlocks([result.screenshot]))
		}
		return blocks
	}

	private async abortBrowserWithError(error: any, card: any, env: IToolEnvironment): Promise<never> {
		await env.browser.close()
		if (card) {
			await card.update({ body: error.message })
			await card.finalize(CardStatus.ERROR)
		}
		throw error
	}
}
