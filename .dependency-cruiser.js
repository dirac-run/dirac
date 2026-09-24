/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "Warn or error on circular dependencies across the codebase",
			from: {},
			to: {
				circular: true,
			},
		},
		{
			name: "task-not-depend-on-controller",
			severity: "error",
			comment: "src/core/task must not import src/core/controller (plan item 1)",
			from: {
				path: "^src/core/task",
			},
			to: {
				path: "^src/core/controller",
			},
		},
		{
			name: "no-vscode-in-core",
			severity: "error",
			comment: "src/core must not import vscode directly (plan item 2)",
			from: {
				path: "^src/core",
			},
			to: {
				// Match both 'vscode' external/shim and resolved paths
				path: "(^vscode$|vscode-shim|hosts/vscode)",
			},
		},
		{
			name: "services-are-leaves",
			severity: "error",
			comment: "src/services must not import core (plan item 5)",
			from: {
				path: "^src/services",
			},
			to: {
				path: "^src/core",
			},
		},
		{
			name: "integrations-are-leaves",
			severity: "error",
			comment: "src/integrations must not import core (plan item 5)",
			from: {
				path: "^src/integrations",
			},
			to: {
				path: "^src/core",
			},
		},
		{
			name: "tool-modules-hermetic-seal",
			severity: "error",
			comment: "Tool modules must not import sibling tool modules (production code only)",
			from: {
				path: "^src/core/task/tools/modules/([^/]+)/",
				pathNot: "(/__tests__/|\\.test\\.ts$)",
			},
			to: {
				path: "^src/core/task/tools/modules/([^/]+)/",
				pathNot: [
					// Same module is allowed: backreferences aren't in JS regex, but depcruise matches capture groups via $1
					"^src/core/task/tools/modules/$1/",
					"(/__tests__/|\\.test\\.ts$)",
				],
			},
		},
		{
			name: "webview-no-core-services-escape",
			severity: "error",
			comment: "webview-ui must consume core via generated protobufs, not direct imports (plan item 11)",
			from: {
				path: "^webview-ui/src",
			},
			to: {
				path: "^src/(core|services|integrations|hosts)",
			},
		},
	],
	options: {
		doNotFollow: {
			path: "node_modules",
		},
		tsPreCompilationDeps: true,
		tsConfig: {
			fileName: "./tsconfig.json",
		},
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
		},
		reporterOptions: {
			dot: {
				collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)",
			},
			archi: {
				collapsePattern: "^(packages|src|lib|app|bin|test(s?)|spec(s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)",
			},
			text: {
				highlightFocused: true,
			},
		},
	},
}
