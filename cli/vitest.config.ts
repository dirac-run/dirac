import { createRequire } from "node:module"
import path from "path"
import { defineConfig } from "vitest/config"

const require = createRequire(import.meta.url)

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/", "dist/"],
		},
		projects: [
			{
				extends: true,
				resolve: {
					// Standalone CLI installs share one Ink peer. The workspace also
					// has an older root Ink, so align the real provider and renderer.
					alias: { ink: require.resolve("ink") },
				},
				test: {
					name: "startup",
					include: ["src/components/App.raw-mode.test.tsx"],
					server: { deps: { inline: ["ink-picture"] } },
				},
			},
			{
				extends: true,
				test: {
					name: "unit",
					include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
					exclude: [
						"src/**/*.markdown.test.tsx",
						"src/components/ChatMessage.test.tsx",
						"src/components/App.raw-mode.test.tsx",
					],
				},
			},
			{
				extends: true,
				test: {
					name: "rendering",
					include: ["src/components/ChatMessage.test.tsx"],
					env: { FORCE_COLOR: "3", COLORTERM: "truecolor" },
				},
			},
			{
				extends: true,
				test: {
					name: "markdown",
					include: ["src/**/*.markdown.test.tsx"],
					env: { FORCE_COLOR: "3", COLORTERM: "truecolor" },
				},
			},
		],
	},
	resolve: {
		alias: {
			// Match tsconfig paths - baseUrl is parent directory
			"@": path.resolve(__dirname, "../src"),
			"@api": path.resolve(__dirname, "../src/core/api"),
			"@core": path.resolve(__dirname, "../src/core"),
			"@generated": path.resolve(__dirname, "../src/generated"),
			"@hosts": path.resolve(__dirname, "../src/hosts"),
			"@integrations": path.resolve(__dirname, "../src/integrations"),
			"@packages": path.resolve(__dirname, "../src/packages"),
			"@services": path.resolve(__dirname, "../src/services"),
			"@shared": path.resolve(__dirname, "../src/shared"),
			"@utils": path.resolve(__dirname, "../src/utils"),
		},
	},
})
