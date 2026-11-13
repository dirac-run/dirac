const Module = require("module")
const originalRequire = Module.prototype.require

/**
 * VSCode is not available during unit tests
 * @see {@link file://./vscode-mock.ts}
 */
Module.prototype.require = function (path: string) {
	// The unit runner emits CommonJS, but braket exposes only an ESM import condition.
	// Load the pinned dependency's real ESM entry; Node's require(esm) executes its
	// published classifier and binary loader unchanged. Type checks run separately.
	if (path === "braket-cli") {
		return originalRequire.call(this, require.resolve("../../node_modules/braket-cli/dist/index.js"))
	}
	if (path === "vscode") {
		return require("./vscode-mock")
	}
	// Avoid pulling in VSCode-integrated checkpoint/editor code during unit tests
	if (path === "@integrations/checkpoints") {
		return {}
	}
	if (path === "@integrations/checkpoints/MultiRootCheckpointManager") {
		return { MultiRootCheckpointManager: class {} }
	}

	return originalRequire.call(this, path)
}

// Required to have access to String.prototype.toPosix
import "../utils/path"
