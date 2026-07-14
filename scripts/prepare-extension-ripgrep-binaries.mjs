#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import * as tar from "tar"
import { createGunzip } from "node:zlib"

const RIPGREP_VERSION = "14.1.1"
const OUTPUT_DIR = "dist/ripgrep-binaries"
const DOWNLOAD_DIR = "dist/.ripgrep-downloads"

const platforms = [
	{
		targetDir: "darwin-arm64",
		archiveName: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
		url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
		binaryName: "rg",
		archiveType: "tar.gz",
	},
	{
		targetDir: "linux-x64",
		archiveName: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
		url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
		binaryName: "rg",
		archiveType: "tar.gz",
	},
	{
		targetDir: "win-x64",
		archiveName: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
		url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
		binaryName: "rg.exe",
		archiveType: "zip",
	},
]

async function main() {
	fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
	fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
	fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

	for (const platform of platforms) {
		await downloadAndExtractRipgrep(platform)
	}

	fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
}

async function downloadAndExtractRipgrep(platform) {
	const archivePath = path.join(DOWNLOAD_DIR, platform.archiveName)
	const targetDir = path.join(OUTPUT_DIR, platform.targetDir)

	console.log(`[ripgrep] Downloading ${platform.targetDir}`)
	await downloadFile(platform.url, archivePath)
	fs.mkdirSync(targetDir, { recursive: true })

	if (platform.archiveType === "tar.gz") {
		await extractTarBinary(archivePath, targetDir, platform.binaryName)
		fs.chmodSync(path.join(targetDir, platform.binaryName), 0o755)
	} else {
		execFileSync("unzip", ["-j", "-q", archivePath, `*/${platform.binaryName}`, "-d", targetDir])
	}

	const binaryPath = path.join(targetDir, platform.binaryName)
	if (!fs.existsSync(binaryPath)) {
		throw new Error(`Expected ripgrep binary was not extracted: ${binaryPath}`)
	}
}

async function extractTarBinary(archivePath, targetDir, binaryName) {
	await pipeline(
		fs.createReadStream(archivePath),
		createGunzip(),
		tar.extract({
			cwd: targetDir,
			strip: 1,
			filter: (entryPath) => entryPath.endsWith(`/${binaryName}`),
		}),
	)
}

async function downloadFile(url, destination) {
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
	}
	fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
