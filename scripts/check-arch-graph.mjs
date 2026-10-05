#!/usr/bin/env node
// check-arch-graph.mjs — module-graph architecture gate (Step 1 of check-architecture.sh).
//
// Reads a dependency-cruiser JSON report and enforces two rules, against the
// frozen SCC partition in scripts/architecture-cycle-sccs.txt:
//   (a) no module outside the baseline may appear in a cyclic SCC, and
//   (b) no current SCC may contain modules from two different baseline SCCs.
// Non-"no-circular" violations in the report are compared entry-by-entry against
// .dependency-cruiser-known-violations.json (stable key: rule name + from + to).
//
// Usage: node scripts/check-arch-graph.mjs <depcruise-json> [--write-baseline]
// Exit: 0 = pass, 1 = new violation, 2 = bad input.
import { readFileSync, writeFileSync } from "node:fs"

const SCC_BASELINE = "scripts/architecture-cycle-sccs.txt"
const VIOLATIONS_BASELINE = ".dependency-cruiser-known-violations.json"

const [reportPath, flag] = process.argv.slice(2)
if (!reportPath || (flag !== undefined && flag !== "--write-baseline")) {
	console.error("usage: node scripts/check-arch-graph.mjs <depcruise-json> [--write-baseline]")
	process.exit(2)
}
const writeBaseline = flag === "--write-baseline"

let report
try {
	report = JSON.parse(readFileSync(reportPath, "utf8"))
} catch (error) {
	console.error(`ERROR: cannot parse depcruise report ${reportPath}: ${error.message}`)
	process.exit(2)
}
if (!Array.isArray(report.modules)) {
	console.error("ERROR: depcruise report has no modules[] array")
	process.exit(2)
}

// Tarjan SCC over local resolved modules — ported from private/plans/scc-prototype.mjs.
// Returns Map(module -> label) for SCCs that form cycles (size > 1 or self-edge);
// the label is the lexicographically first module in the SCC.
function sccLabels(reportJson) {
	const local = new Set(
		reportJson.modules
			.filter((m) => !m.coreModule && !m.couldNotResolve && !/node_modules/.test(m.source))
			.map((m) => m.source),
	)
	const adj = new Map()
	for (const m of reportJson.modules)
		if (local.has(m.source)) adj.set(m.source, m.dependencies.map((d) => d.resolved).filter((x) => local.has(x)))
	let idx = 0
	const index = new Map(),
		low = new Map(),
		onStack = new Set(),
		stack = [],
		labels = new Map()
	const strong = (v) => {
		const work = [[v, 0]]
		index.set(v, idx)
		low.set(v, idx)
		idx++
		stack.push(v)
		onStack.add(v)
		while (work.length) {
			const [n, i] = work[work.length - 1]
			const ns = adj.get(n) || []
			if (i < ns.length) {
				work[work.length - 1][1]++
				const w = ns[i]
				if (!index.has(w)) {
					index.set(w, idx)
					low.set(w, idx)
					idx++
					stack.push(w)
					onStack.add(w)
					work.push([w, 0])
				} else if (onStack.has(w)) low.set(n, Math.min(low.get(n), index.get(w)))
			} else {
				work.pop()
				if (work.length) {
					const p = work[work.length - 1][0]
					low.set(p, Math.min(low.get(p), low.get(n)))
				}
				if (low.get(n) === index.get(n)) {
					const comp = []
					let w
					do {
						w = stack.pop()
						onStack.delete(w)
						comp.push(w)
					} while (w !== n)
					const selfLoop = comp.length === 1 && (adj.get(n) || []).includes(n)
					if (comp.length > 1 || selfLoop) {
						const label = comp.slice().sort()[0]
						for (const c of comp) labels.set(c, label)
					}
				}
			}
		}
	}
	for (const v of adj.keys()) if (!index.has(v)) strong(v)
	return labels
}

// Baseline SCC file: comment lines (#), one block per SCC separated by blank
// lines, modules sorted inside a block, blocks sorted by first module.
function readSccBaseline(path) {
	const text = readFileSync(path, "utf8")
	const blocks = []
	let block = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "") {
			if (block.length) {
				blocks.push(block)
				block = []
			}
			continue
		}
		if (trimmed.startsWith("#")) continue
		block.push(trimmed)
	}
	if (block.length) blocks.push(block)
	// module -> baseline SCC id (the block's first module)
	const memberToScc = new Map()
	for (const b of blocks) for (const m of b) memberToScc.set(m, b[0])
	return { blocks, memberToScc }
}

function writeSccBaseline(path, labels) {
	const groups = new Map()
	for (const [m, label] of labels) {
		if (!groups.has(label)) groups.set(label, [])
		groups.get(label).push(m)
	}
	const blocks = [...groups.values()].map((b) => b.sort()).sort((a, b) => a[0].localeCompare(b[0]))
	const header =
		"# architecture-cycle-sccs.txt — cyclic SCC partition baseline.\n" +
		"# One block per SCC; modules sorted within a block; blocks sorted by first module.\n" +
		"# Regenerate: bash scripts/check-architecture.sh --write-baseline\n"
	writeFileSync(path, header + blocks.map((b) => b.join("\n")).join("\n\n") + "\n")
	return blocks.length
}

// Stable violation key: rule name + from + to. Module-level violations have no "to".
const violationKey = (v) => `${v.rule?.name ?? ""}|${v.from ?? ""}|${v.to ?? ""}`

function collectViolations(reportJson) {
	if (Array.isArray(reportJson.summary?.violations)) return reportJson.summary.violations
	const violations = []
	for (const m of reportJson.modules) {
		for (const d of m.dependencies || []) {
			for (const r of d.rules || []) {
				if (r.severity === "error" || r.severity === "warn") violations.push({ rule: r, from: m.source, to: d.resolved })
			}
		}
	}
	return violations
}

const labels = sccLabels(report)
const violations = collectViolations(report)

if (writeBaseline) {
	const sccCount = writeSccBaseline(SCC_BASELINE, labels)
	// cycles are judged by the SCC baseline, so only non-circular violations are frozen here
	const boundaryViolations = violations.filter((v) => v.rule?.name !== "no-circular")
	writeFileSync(VIOLATIONS_BASELINE, JSON.stringify(boundaryViolations))
	console.log(
		`wrote ${SCC_BASELINE}: ${labels.size} cyclic modules in ${sccCount} SCCs; ` +
			`wrote ${VIOLATIONS_BASELINE}: ${boundaryViolations.length} known boundary violations`,
	)
	process.exit(0)
}

let baseline
try {
	baseline = readSccBaseline(SCC_BASELINE)
} catch {
	console.error(`ERROR: cannot read SCC baseline ${SCC_BASELINE} — run check-architecture.sh --write-baseline`)
	process.exit(2)
}
let knownViolations
try {
	knownViolations = JSON.parse(readFileSync(VIOLATIONS_BASELINE, "utf8"))
} catch {
	console.error(`ERROR: cannot read violations baseline ${VIOLATIONS_BASELINE}`)
	process.exit(2)
}
const knownKeys = new Set(knownViolations.map(violationKey))

let failed = false

// (a) modules newly participating in a cyclic SCC
const newCyclic = [...labels.keys()].filter((m) => !baseline.memberToScc.has(m)).sort()
if (newCyclic.length) {
	failed = true
	console.error(`NEW cyclic-SCC member(s) (${newCyclic.length}):`)
	for (const m of newCyclic.slice(0, 20)) console.error(`  + ${m} (SCC ${labels.get(m)})`)
	if (newCyclic.length > 20) console.error(`  … and ${newCyclic.length - 20} more`)
}

// (b) baseline SCCs merged in the current graph
const currentGroups = new Map()
for (const [m, label] of labels) {
	if (!currentGroups.has(label)) currentGroups.set(label, new Set())
	if (baseline.memberToScc.has(m)) currentGroups.get(label).add(baseline.memberToScc.get(m))
}
const merges = [...currentGroups.entries()].filter(([, sccs]) => sccs.size > 1)
if (merges.length) {
	failed = true
	for (const [label, sccs] of merges)
		console.error(`SCC MERGE at ${label}: baseline SCCs ${[...sccs].sort().join(" + ")} are now one cycle`)
}

// non-no-circular violations vs the known-violations baseline
const newViolations = violations.filter((v) => v.rule?.name !== "no-circular" && !knownKeys.has(violationKey(v)))
if (newViolations.length) {
	failed = true
	console.error(`NEW rule violation(s) (${newViolations.length}):`)
	for (const v of newViolations.slice(0, 20)) console.error(`  + ${v.rule.name}: ${v.from} -> ${v.to ?? "(module)"}`)
	if (newViolations.length > 20) console.error(`  … and ${newViolations.length - 20} more`)
}

if (failed) process.exit(1)
const sccCount = new Set(labels.values()).size
console.log(
	`module graph OK: ${labels.size} modules in ${sccCount} cyclic SCCs (baseline ${baseline.blocks.length}), ` +
		`${violations.length} violation(s) all known`,
)
process.exit(0)
