import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"
import { braketAssetsPlugin } from "./braket-assets.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = `
import { classify, classifyReadable } from 'braket-cli';
console.log(JSON.stringify({
  read: classify('ls -la'),
  write: classifyReadable('rm report.txt'),
  empty: classifyReadable('true'),
  unknown: classifyReadable('unknown_command_xyz')
}));
`

for (const format of ["esm", "cjs"]) {
	test(`braket ${format} bundle runs after relocation with its packaged binary and notices`, async () => {
		const temporaryRoot = fs.mkdtempSync(path.join(tmpdir(), "dirac braket package "))
		try {
			const buildDir = path.join(temporaryRoot, "build", "dist")
			const extension = format === "esm" ? "mjs" : "cjs"
			const result = await esbuild.build({
				stdin: { contents: source, resolveDir: repositoryRoot, sourcefile: "braket-smoke.js" },
				bundle: true,
				platform: "node",
				target: "node22.13",
				format,
				minify: true,
				metafile: true,
				outfile: path.join(buildDir, `smoke.${extension}`),
				plugins: [braketAssetsPlugin()],
				...(format === "cjs"
					? {
							define: { "import.meta.url": "_importMetaUrl" },
							banner: { js: "const _importMetaUrl=require('url').pathToFileURL(__filename);" },
						}
					: {}),
			})
			assert.ok(Object.keys(result.metafile.inputs).some((name) => name.includes("braket-cli/dist/")))
			const relocated = path.join(temporaryRoot, "isolated package")
			fs.renameSync(path.dirname(buildDir), relocated)
			const assetDir = path.join(relocated, "dist", "braket")
			assert.ok(fs.statSync(path.join(assetDir, "classifier.bin")).size > 1_000_000)
			for (const name of ["LICENSE", "NOTICE", "LICENSE.unbash"]) {
				assert.ok(fs.statSync(path.join(assetDir, name)).size > 0)
			}
			const metadata = JSON.parse(fs.readFileSync(path.join(assetDir, "package.json"), "utf8"))
			assert.equal(metadata.name, "braket-cli")
			assert.equal(metadata.version, "0.1.0")
			const output = execFileSync(process.execPath, [path.join(relocated, "dist", `smoke.${extension}`)], {
				cwd: temporaryRoot,
				encoding: "utf8",
			})
			assert.deepEqual(JSON.parse(output), {
				read: 3,
				write: { filesystem: "mutate" },
				empty: {},
				unknown: "unknown",
			})
			if (format === "esm") {
				const cliPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "cli/package.json"), "utf8"))
				fs.writeFileSync(path.join(relocated, "package.json"), JSON.stringify(cliPackage))
				const npm = process.platform === "win32" ? "npm.cmd" : "npm"
				const packed = JSON.parse(
					execFileSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
						cwd: relocated,
						encoding: "utf8",
					}),
				)[0]
				for (const name of ["classifier.bin", "package.json", "LICENSE", "NOTICE", "LICENSE.unbash"]) {
					assert.ok(
						packed.files.some((file) => file.path === `dist/braket/${name}`),
						`${name} missing from npm pack`,
					)
				}
			}
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true })
		}
	})
}
