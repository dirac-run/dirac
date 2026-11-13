import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("braket-cli"))), "..")
const originalAssetPath = "../data/classifier.bin"
const bundledAssetPath = "./braket/classifier.bin"
const metadataFiles = ["package.json", "LICENSE", "NOTICE", "LICENSE.unbash"]

/** Bundle the published ESM library while keeping its binary and notices beside the output. */
export function braketAssetsPlugin() {
	return {
		name: "braket-assets",
		setup(build) {
			let usesClassifierAsset = false
			build.onLoad({ filter: /[\\/]braket-cli[\\/]dist[\\/].*\.js$/ }, (args) => {
				const source = fs.readFileSync(args.path, "utf8")
				if (!source.includes(originalAssetPath)) return
				usesClassifierAsset = true
				// Keep import.meta.url intact: CLI ESM uses it directly; root CJS builds
				// already map it to the output bundle's __filename.
				return { contents: source.replaceAll(originalAssetPath, bundledAssetPath), loader: "js" }
			})
			build.onEnd((result) => {
				if (result.errors.length || !usesClassifierAsset) return
				const options = build.initialOptions
				const outputDir = options.outdir ?? path.dirname(options.outfile)
				const destination = path.resolve(options.absWorkingDir ?? process.cwd(), outputDir, "braket")
				fs.mkdirSync(destination, { recursive: true })
				fs.copyFileSync(path.join(packageRoot, "data/classifier.bin"), path.join(destination, "classifier.bin"))
				for (const name of metadataFiles) {
					fs.copyFileSync(path.join(packageRoot, name), path.join(destination, name))
				}
			})
		},
	}
}
