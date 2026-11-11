#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
	ARTIFACT_FILES,
	HELPER_VERSION,
	MXC_REVISION,
	PROTOCOL,
	repositoryRoot,
	sha256,
	verifyWindowsMxcArtifact,
} from "./windows-mxc-artifacts.mjs"

/** Bundle original notices from the locked Cargo dependency source, not SPDX names alone. */
function dependencyNotices(manifest, triple) {
	const metadata = JSON.parse(
		execFileSync(
			"cargo",
			["metadata", "--locked", "--manifest-path", manifest, "--format-version", "1", "--filter-platform", triple],
			{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
		),
	)
	return (
		metadata.packages
			.map((pkg) => {
				let directory = path.dirname(pkg.manifest_path)
				let notices = []
				for (let depth = 0; depth < 4 && !notices.length; depth++) {
					notices = fs
						.readdirSync(directory)
						.filter(
							(name) =>
								/^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(name) &&
								fs.statSync(path.join(directory, name)).isFile(),
						)
						.map((name) => `${name}\n${fs.readFileSync(path.join(directory, name), "utf8")}`)
					if (!notices.length) directory = path.dirname(directory)
				}
				if (!notices.length && pkg.license_file)
					notices.push(fs.readFileSync(path.resolve(path.dirname(pkg.manifest_path), pkg.license_file), "utf8"))
				if (!notices.length)
					throw new Error(`Release license review required: original notice missing for ${pkg.name}@${pkg.version}`)
				return `===== ${pkg.name} ${pkg.version} (${pkg.license ?? "license-file"}) =====\n${pkg.repository ?? ""}\n${notices.join("\n\n")}`
			})
			.join("\n\n") + "\n"
	)
}

/** Build reviewed pinned dependency source only; no Node >=24 SDK or runtime download. */
export function buildWindowsMxc(arch = process.arch) {
	if (process.platform !== "win32")
		throw new Error(
			"Native helper release builds require a Windows MSVC developer shell (Linux portable cargo tests do not build the native backend)",
		)
	if (!["x64", "arm64"].includes(arch)) throw new Error("Usage: node scripts/build-windows-mxc.mjs [x64|arm64]")
	const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc"
	const source = path.join(repositoryRoot, "native/windows-mxc")
	const lock = fs.readFileSync(path.join(source, "Cargo.lock"))
	if (!lock.toString().includes(`${MXC_REVISION}#${MXC_REVISION}`))
		throw new Error("Cargo.lock does not pin the reviewed MXC revision")
	// --locked refuses transitive updates; default features exclude VM, WSLc,
	// hyperlight, isolation_session, test-support and tier-forcing facilities.
	execFileSync(
		"cargo",
		["build", "--locked", "--release", "--manifest-path", path.join(source, "Cargo.toml"), "--target", triple],
		{ stdio: "inherit", cwd: repositoryRoot },
	)
	const directory = path.join(source, "artifacts", arch)
	fs.mkdirSync(directory, { recursive: true })
	fs.copyFileSync(
		path.join(source, "target", triple, "release", "dirac-windows-mxc.exe"),
		path.join(directory, ARTIFACT_FILES[0]),
	)
	fs.copyFileSync(path.join(source, "MXC-LICENSE.txt"), path.join(directory, "MXC-LICENSE.txt"))
	fs.copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(directory, "APACHE-2.0.txt"))
	fs.copyFileSync(path.join(source, "THIRD-PARTY-NOTICES.txt"), path.join(directory, "THIRD-PARTY-NOTICES.txt"))
	fs.writeFileSync(path.join(directory, "DEPENDENCY-LICENSES.txt"), dependencyNotices(path.join(source, "Cargo.toml"), triple))
	const sourceFiles = ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/native.rs"]
	const manifest = {
		protocol: PROTOCOL,
		version: HELPER_VERSION,
		revision: MXC_REVISION,
		arch,
		target: triple,
		sha256: sha256(fs.readFileSync(path.join(directory, ARTIFACT_FILES[0]))),
		compiler: execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" }).trim(),
		sources: Object.fromEntries(sourceFiles.map((file) => [file, sha256(fs.readFileSync(path.join(source, file)))])),
		notices: Object.fromEntries(
			ARTIFACT_FILES.filter((file) => file.endsWith(".txt")).map((file) => [
				file,
				sha256(fs.readFileSync(path.join(directory, file))),
			]),
		),
	}
	fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
	verifyWindowsMxcArtifact(directory, arch)
	console.log(`Built Windows native-only MXC helper: ${directory}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWindowsMxc(process.argv[2])
