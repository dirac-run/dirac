import type { IBrowserTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the browser trait — delegates to the BrowserSession service.
export function buildBrowserTrait(config: TaskConfig): IBrowserTrait {
	const session = () => config.services.browserSession
	return {
		launch: async (url: string) => {
			config.services.browserSession = await config.callbacks.applyLatestBrowserSettings()
			await config.services.browserSession.launchBrowser()
			return await config.services.browserSession.navigateToUrl(url)
		},
		click: async (coordinate: string) => await session().click(coordinate),
		type: async (text: string) => await session().type(text),
		scroll: async (direction: "up" | "down") => direction === "up" ? await session().scrollUp() : await session().scrollDown(),
		close: async () => await session().closeBrowser(),
	}
}
