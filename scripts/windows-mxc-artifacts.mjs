import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const MXC_REVISION = "fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2"
export const HELPER_VERSION = "1.0.0"
export const PROTOCOL = 1
export const ARTIFACT_FILES = [
	"dirac-windows-mxc.exe",
	"manifest.json",
	"MXC-LICENSE.txt",
	"APACHE-2.0.txt",
	"THIRD-PARTY-NOTICES.txt",
	"DEPENDENCY-LICENSES.txt",
]
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

/** Validate before copying; no auto-download, compilation, or runtime installation. */
export function verifyWindowsMxcArtifact(directory, arch) {
	if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported Windows helper architecture")
	for (const name of ARTIFACT_FILES) {
		if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`MXC artifact is not a regular file: ${name}`)
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
	const executable = fs.readFileSync(path.join(directory, "dirac-windows-mxc.exe"))
	if (
		manifest.protocol !== PROTOCOL ||
		manifest.version !== HELPER_VERSION ||
		manifest.revision !== MXC_REVISION ||
		manifest.arch !== arch ||
		manifest.sha256 !== sha256(executable) ||
		executable.subarray(0, 2).toString() !== "MZ"
	)
		throw new Error("Windows MXC artifact identity or integrity mismatch")
	for (const name of ARTIFACT_FILES.filter((name) => name.endsWith(".txt"))) {
		if (manifest.notices?.[name] !== sha256(fs.readFileSync(path.join(directory, name))))
			throw new Error(`MXC notice integrity mismatch: ${name}`)
	}
	return manifest
}

/** Shared by extension, CLI, npm and standalone packaging (their dist is copied whole). */
export function copyWindowsMxcArtifacts(
	destination,
	{
		source = path.join(repositoryRoot, "native/windows-mxc/artifacts"),
		requireArchitectures = process.env.DIRAC_REQUIRE_WINDOWS_MXC === "1" ? ["x64", "arm64"] : [],
	} = {},
) {
	const found = []
	// A normal rebuild with no source artifacts must not retain an older helper.
	fs.rmSync(path.join(destination, "native/windows-mxc"), { recursive: true, force: true })
	for (const arch of ["x64", "arm64"]) {
		const directory = path.join(source, arch)
		if (!fs.existsSync(directory)) {
			if (requireArchitectures.includes(arch))
				throw new Error(
					`Required native Windows MXC helper missing (${arch}); run scripts/build-windows-mxc.mjs on the matching Windows build host`,
				)
			continue
		}
		verifyWindowsMxcArtifact(directory, arch)
		const output = path.join(destination, "native/windows-mxc", arch)
		fs.mkdirSync(output, { recursive: true })
		for (const name of ARTIFACT_FILES) fs.copyFileSync(path.join(directory, name), path.join(output, name))
		found.push(arch)
	}
	return found
}
