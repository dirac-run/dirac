import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Read image from system clipboard and save to a temporary file.
 * Returns the path to the temporary file, or null if no image in clipboard.
 */
export async function readImageFromClipboard(): Promise<string | null> {
	const tmpDir = os.tmpdir()
	const tmpPath = path.join(tmpDir, `dirac-clipboard-${Date.now()}.png`)

	try {
		if (process.platform === "darwin") {
			// macOS: Use osascript to save clipboard image to file
			// We try multiple formats: PNG, TIFF, and JPEG
			const script = `
				set found to false
				set theData to missing value
				
				-- Try PNG first
				try
					set theData to the clipboard as «class PNGf»
					set found to true
				on error
					-- Try TIFF
					try
						set theData to the clipboard as «class TIFF»
						set found to true
					on error
						-- Try JPEG
						try
							set theData to the clipboard as JPEG picture
							set found to true
						end try
					end try
				end try

				if found then
					try
						set theFile to (open for access POSIX file "${tmpPath}" with write permission)
						set eof theFile to 0
						write theData to theFile
						close access theFile
						return "OK"
					on error
						try
							close access theFile
						end try
						return "ERR_WRITE"
					end try
				else
					return "ERR_NO_IMAGE"
				end if
			`
			const result = execSync(`osascript -e '${script.replace(/\n/g, " ")}'`)
				.toString()
				.trim()
			if (result === "OK" && fs.existsSync(tmpPath)) {
				return tmpPath
			}
		} else if (process.platform === "linux") {
			// Linux: Try wl-paste (Wayland) first, then xclip (X11)
			try {
				// Check for wl-paste
				execSync("wl-paste --version", { stdio: "ignore" })
				execSync(`wl-paste -t image/png > "${tmpPath}"`, { stdio: "ignore" })
				if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
					return tmpPath
				}
			} catch {
				// Fallback to xclip
				try {
					execSync(`xclip -selection clipboard -t image/png -o > "${tmpPath}"`, { stdio: "ignore" })
					if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
						return tmpPath
					}
				} catch {
					// Fallback or tools not installed
				}
			}
		} else if (process.platform === "win32") {
			// Windows: Use PowerShell to save clipboard image to file
			const psCommand = `Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $img = [System.Windows.Forms.Clipboard]::GetImage(); $img.Save('${tmpPath}', [System.Drawing.Imaging.ImageFormat]::Png); echo "OK" }`
			execSync(`powershell -command "${psCommand}"`, { stdio: "ignore" })
			if (fs.existsSync(tmpPath)) {
				return tmpPath
			}
		}
	} catch (error) {
		// console.error("Error reading image from clipboard:", error)
	}

	if (fs.existsSync(tmpPath)) {
		try {
			fs.unlinkSync(tmpPath)
		} catch {}
	}
	return null
}
