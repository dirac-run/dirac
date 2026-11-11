#!/usr/bin/env node
// Inspect actual TypeScript syntax on added lines, not words in strings/comments.
// Like the architecture gate's other ratchets, compare tracked working-tree code
// (including staged changes) with the supplied merge base; exclude test files.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

export function addedLineNumbers(diff) {
	const added = new Set()
	let line
	for (const text of diff.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
		if (hunk) {
			line = Number(hunk[1])
		} else if (line !== undefined && text.startsWith("+")) {
			added.add(line++)
		} else if (line !== undefined && text.startsWith(" ")) {
			line++
		}
	}
	return added
}

export function findAddedAnyUsages(file, source, addedLines) {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	const lines = source.split(/\r?\n/)
	const violations = new Set()
	function visit(node) {
		if (node.kind === ts.SyntaxKind.AnyKeyword) {
			// Keep the existing `as any` / `: any` scope, including suffixes
			// such as `: any[]`. Other explicit-any forms are not this ratchet.
			let type = node
			while (ts.isTypeNode(type.parent) && type.parent.getStart(ast) === node.getStart(ast)) type = type.parent
			const owner = type.parent
			const annotation = owner.type === type && owner.getChildren(ast).some((child) => child.kind === ts.SyntaxKind.ColonToken)
			if (annotation || (ts.isAsExpression(owner) && owner.type === type)) {
				const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
				if (addedLines.has(line)) violations.add(`${file}:${lines[line - 1]}`)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(ast)
	return [...violations]
}

export function checkAnyRatchet(base, cwd = process.cwd()) {
	const changes = git([
		"diff", "--name-status", "-z", "--diff-filter=AMRT", base, "--", "src", "cli/src", "webview-ui/src",
	], cwd).split("\0")
	const violations = []
	for (let index = 0; index < changes.length - 1;) {
		const status = changes[index++]
		const paths = [changes[index++]]
		if (status.startsWith("R")) paths.push(changes[index++])
		const file = paths.at(-1)
		if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.|__tests__/.test(file)) continue
		// Include the old path for renames so unchanged legacy code is not
		// mistaken for a newly added file.
		const diff = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", base, "--", ...paths], cwd)
		violations.push(...findAddedAnyUsages(file, readFileSync(resolve(cwd, file), "utf8"), addedLineNumbers(diff)))
	}
	return violations
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const base = process.argv[2]
	if (!base || process.argv.length !== 3) {
		console.error("usage: node scripts/check-any-ratchet.mjs <merge-base>")
		process.exitCode = 2
	} else {
		for (const violation of checkAnyRatchet(base)) console.log(violation)
	}
}
