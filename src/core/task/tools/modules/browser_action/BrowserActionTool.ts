import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracTextContentBlock, DiracImageContentBlock } from "@shared/messages/content"
import { DiracToolSpec, DiracDefaultTool } from "@shared/tools"
import { formatResponse } from "@/core/prompts/responses"
import { BrowserActionResult, CardStatus } from "@shared/ExtensionMessage"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { DiracIcon } from "@shared/icons"
import { DiracAskResponse } from "@shared/WebviewMessage"

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
            instruction: `The action to perform. The available actions are: 
	* launch: Launch a new Puppeteer-controlled browser instance at the specified URL. This **must always be the first action**. 
		- Use with the \`url\` parameter to provide the URL. 
		- Ensure the URL is valid and includes the appropriate protocol (e.g. http://localhost:3000/page, file:///path/to/file.html, etc.) 
	* click: Click at a specific x,y coordinate. 
		- Use with the \`coordinate\` parameter to specify the location. 
		- Always click in the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot. 
	* type: Type a string of text on the keyboard. You might use this after clicking on a text field to input text. 
		- Use with the \`text\` parameter to provide the string to type. 
	* scroll_down: Scroll down the page by one page height. 
	* scroll_up: Scroll up the page by one page height. 
	* close: Close the Puppeteer-controlled browser instance. This **must always be the final browser action**. 
	    - Example: 'scroll_up'`,
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

        if (!action) {
            return this.handleMissingAction(env, example)
        }

        const card = !isSubagent
            ? await env.ui.createCard({
                icon: DiracIcon.BROWSER,
                header: `Browser: ${action}${action === "launch" && url ? ` ${url}` : action === "click" && coordinate ? ` at ${coordinate}` : action === "type" && text ? ` \"${text.substring(0, 30)}\"` : ""}`,
                collapsed: true,
            })
            : undefined
        try {
            let result: BrowserActionResult

            switch (action) {
                case "launch":
                    if (!url) return this.handleMissingUrl(env, card, example)
                    const permission_result = await env.interaction.askPermission(`Dirac wants to use a browser and launch ${url}`)
                    const permission = permission_result
                    if (permission.action === DiracAskResponse.MESSAGE) {
                        if (permission.text) {
                            await env.ui.upsertText(permission.text, false, "user")
                        }
                        await permission_result.card.finalize(CardStatus.SKIPPED)
                        if (card) {
                            await card.update({ body: `↩ Skipped — user sent a message instead` })
                            await card.finalize(CardStatus.SKIPPED)
                        }
                        return permission.text ? formatResponse.toolDeniedWithFeedback(permission.text) : formatResponse.toolDenied()
                    }
                    await permission_result.card.finalize(permission.approved ? CardStatus.SUCCESS : CardStatus.CANCELLED)
                    if (!permission.approved) return this.handleUserDenial(permission.value, card)
                    if (card) await card.update({ body: `Launching ${url}...` })
                    result = await env.browser.launch(url)
                    break

                case "click":
                    if (!coordinate) return this.handleMissingCoordinate(env, card, example)
                    result = await env.browser.click(coordinate)
                    break

                case "type":
                    if (!text) return this.handleMissingText(env, card, example)
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

            return this.handleActionResult(action, result, card)
        } catch (error: any) {
            return this.handleError(error, card, env)
        }
    }

    private async handleMissingAction(env: IToolEnvironment, example: string): Promise<string> {
        const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
        env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
        await env.browser.close()
        return `Missing value for required parameter 'action'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
    }

    private async handleMissingUrl(env: IToolEnvironment, card: any, example: string): Promise<string> {
        const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
        env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
        await env.browser.close()
        if (card) {
            await card.update({ body: "Missing required parameter 'url' for 'launch' action." })
            await card.finalize(CardStatus.ERROR)
        }
        return `Missing value for required parameter 'url'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
    }

    private async handleMissingCoordinate(env: IToolEnvironment, card: any, example: string): Promise<string> {
        const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
        env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
        await env.browser.close()
        if (card) {
            await card.update({ body: "Missing required parameter 'coordinate' for 'click' action." })
            await card.finalize(CardStatus.ERROR)
        }
        return `Missing value for required parameter 'coordinate'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
    }

    private async handleMissingText(env: IToolEnvironment, card: any, example: string): Promise<string> {
        const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
        env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
        await env.browser.close()
        if (card) {
            await card.update({ body: "Missing required parameter 'text' for 'type' action." })
            await card.finalize(CardStatus.ERROR)
        }
        return `Missing value for required parameter 'text'. Please retry with complete response.\n\nExample of correct usage (arguments JSON):\n${example}\n`
    }

    private async handleUserDenial(reason: string | undefined, card: any): Promise<string> {
        if (card) {
            await card.update({
                body: `User denied browser launch: ${reason || "No reason provided"}`,
            })
            await card.finalize(CardStatus.CANCELLED)
        }
        return reason ? formatResponse.toolDeniedWithFeedback(reason) : formatResponse.toolDenied()
    }

    private async handleActionResult(
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

        const blocks: Array<DiracTextContentBlock | DiracImageContentBlock> = [
            { type: "text", text: responseText }
        ]
        if (result.screenshot) {
            blocks.push({
                type: "image",
                source: { type: "base64", media_type: "image/webp" as any, data: result.screenshot }
            })
        }
        return blocks
    }

    private async handleError(error: any, card: any, env: IToolEnvironment): Promise<never> {
        await env.browser.close()
        if (card) {
            await card.update({ body: error.message })
            await card.finalize(CardStatus.ERROR)
        }
        throw error
    }
}
