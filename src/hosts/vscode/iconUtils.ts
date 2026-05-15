import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"

export function getDiracIconUri(): vscode.Uri {
	return vscode.Uri.joinPath(vscode.Uri.file(HostProvider.get().extensionFsPath), "assets", "icons", "icon.svg")
}
