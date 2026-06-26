// Augments @types/vscode@1.84.0 with Terminal.shellIntegration (added in VS Code 1.93+).
// Moved from VscodeTerminalProcess.test.ts so the augmentation is always loaded,
// not dependent on test file compilation order under ts-node.
// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L7442
declare module "vscode" {
	interface Terminal {
		shellIntegration?: {
			cwd?: vscode.Uri
			executeCommand?: (command: string) => {
				read: () => AsyncIterable<string>
			}
		}
	}
}
