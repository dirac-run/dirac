#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const CLI_DIR = join(__dirname, "..")
const REPO_ROOT = join(CLI_DIR, "..")
const FORMULA_PATH = join(CLI_DIR, "dirac.rb")

interface PackageJson {
	version: string
}

interface Args {
	packageDir: string
	packDestination: string
	keepTarball: boolean
	usesTemporaryPackDestination: boolean
}

function resolveFromRepoRoot(inputPath: string): string {
	return isAbsolute(inputPath) ? inputPath : resolve(REPO_ROOT, inputPath)
}

function parseArgs(): Args {
	let packageDir = CLI_DIR
	let packDestination = ""
	let keepTarball = false

	const args = process.argv.slice(2)
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		switch (arg) {
			case "--package-dir":
				packageDir = resolveFromRepoRoot(args[++i])
				break
			case "--pack-destination":
				packDestination = resolveFromRepoRoot(args[++i])
				break
			case "--keep-tarball":
				keepTarball = true
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	const usesTemporaryPackDestination = !packDestination
	if (!packDestination) {
		packDestination = join(tmpdir(), `dirac-brew-pack-${process.pid}`)
	}

	return { packageDir, packDestination, keepTarball, usesTemporaryPackDestination }
}

async function getPackageVersion(packageDir: string): Promise<string> {
	const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf-8")) as PackageJson
	return packageJson.version
}

async function packAndGetSHA256(version: string, args: Args): Promise<{ sha256: string; tarballPath: string }> {
	await mkdir(args.packDestination, { recursive: true })

	console.log(`Packing package from ${args.packageDir}...`)
	execFileSync("npm", ["pack", args.packageDir, "--pack-destination", args.packDestination], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	})

	const tarballPath = join(args.packDestination, `dirac-cli-${version}.tgz`)
	console.log(`Computing SHA256 for ${tarballPath}...`)

	const buffer = await readFile(tarballPath)
	const sha256 = createHash("sha256").update(buffer).digest("hex")

	if (!args.keepTarball) {
		await unlink(tarballPath)
	}
	if (args.usesTemporaryPackDestination) {
		await rm(args.packDestination, { recursive: true, force: true })
	}

	return { sha256, tarballPath }
}

async function updateFormula(version: string, sha256: string) {
	console.log("Updating Homebrew formula...")

	let formula = await readFile(FORMULA_PATH, "utf-8")

	const tarballUrl = `https://registry.npmjs.org/dirac-cli/-/dirac-cli-${version}.tgz`

	formula = formula.replace(/url "https:\/\/registry\.npmjs\.org\/dirac-cli\/-\/dirac-cli-[^"]+\.tgz"/, `url "${tarballUrl}"`)
	formula = formula.replace(/sha256 "[a-f0-9]+"/, `sha256 "${sha256}"`)

	await writeFile(FORMULA_PATH, formula, "utf-8")
}

async function main() {
	try {
		const args = parseArgs()
		const version = await getPackageVersion(args.packageDir)
		console.log(`\nPackage version: ${version}`)

		const { sha256, tarballPath } = await packAndGetSHA256(version, args)
		console.log(`SHA256: ${sha256}`)

		const tarballUrl = `https://registry.npmjs.org/dirac-cli/-/dirac-cli-${version}.tgz`
		console.log(`Tarball URL: ${tarballUrl}`)

		await updateFormula(version, sha256)

		console.log("\n✓ Homebrew formula updated successfully!")
		if (args.keepTarball) {
			console.log(`✓ Packed npm tarball retained at: ${tarballPath}`)
		}
		console.log("\nNext steps:")
		console.log("1. Review the changes in dirac.rb")
		console.log("2. Test locally: brew install --build-from-source ./dirac.rb")
		console.log("3. Commit and push to your homebrew tap repository")
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error(`\n✗ Error: ${errorMessage}\n`)
		process.exit(1)
	}
}

main()
