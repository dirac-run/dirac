import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
	ARTIFACT_FILES,
	MXC_REVISION,
	HELPER_VERSION,
	PROTOCOL,
	copyWindowsMxcArtifacts,
	sha256,
} from "./windows-mxc-artifacts.mjs"

test("Windows artifact packaging is optional locally and fail-closed when release-required", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dirac-mxc-package-"))
	try {
		const stale = path.join(root, "dist/native/windows-mxc/x64")
		mkdirSync(stale, { recursive: true })
		writeFileSync(path.join(stale, "dirac-windows-mxc.exe"), "stale")
		assert.deepEqual(copyWindowsMxcArtifacts(path.join(root, "dist"), { source: path.join(root, "absent") }), [])
		assert.equal(existsSync(stale), false)
		assert.throws(
			() =>
				copyWindowsMxcArtifacts(path.join(root, "dist"), {
					source: path.join(root, "absent"),
					requireArchitectures: ["x64"],
				}),
			/missing/,
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test("packager validates identity, integrity and notices before copying known files", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dirac-mxc-package-"))
	try {
		const source = path.join(root, "artifacts"),
			artifact = path.join(source, "x64"),
			dest = path.join(root, "dist")
		mkdirSync(artifact, { recursive: true })
		const executable = Buffer.from("MZtest-artifact-not-a-runtime")
		writeFileSync(path.join(artifact, ARTIFACT_FILES[0]), executable)
		const notices = {}
		for (const file of ARTIFACT_FILES.filter((file) => file.endsWith(".txt"))) {
			writeFileSync(path.join(artifact, file), "license test\n")
			notices[file] = sha256(Buffer.from("license test\n"))
		}
		const manifest = {
			protocol: PROTOCOL,
			version: HELPER_VERSION,
			revision: MXC_REVISION,
			arch: "x64",
			sha256: sha256(executable),
			notices,
		}
		writeFileSync(path.join(artifact, "manifest.json"), JSON.stringify(manifest))
		writeFileSync(path.join(artifact, "unreviewed.exe"), "must not copy")
		assert.deepEqual(copyWindowsMxcArtifacts(dest, { source }), ["x64"])
		assert.deepEqual(readFileSync(path.join(dest, "native/windows-mxc/x64/dirac-windows-mxc.exe")), executable)
		assert.equal(existsSync(path.join(dest, "native/windows-mxc/x64/unreviewed.exe")), false)
		writeFileSync(path.join(artifact, ARTIFACT_FILES[0]), "MZchanged")
		assert.throws(() => copyWindowsMxcArtifacts(dest, { source }), /integrity/)
		writeFileSync(path.join(artifact, ARTIFACT_FILES[0]), executable)
		writeFileSync(path.join(artifact, "MXC-LICENSE.txt"), "changed")
		assert.throws(() => copyWindowsMxcArtifacts(dest, { source }), /notice integrity/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
