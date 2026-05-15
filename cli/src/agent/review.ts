import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import * as Diff from "diff"
import type { ApiConfiguration } from "@shared/api"
import type { DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger.js"
import { buildApiHandler } from "@/core/api"
import type { Controller } from "@/core/controller"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const REVIEW_SEVERITY_ORDER: Record<ReviewFinding["severity"], number> = {
	high: 0,
	medium: 1,
	low: 2,
}

export const ACP_REVIEW_COMMANDS: acp.AvailableCommand[] = [
	{
		name: "/review",
		description: "Review uncommitted working tree changes",
		input: {
			hint: "Optional review instructions",
		},
	},
	{
		name: "/review-branch",
		description: "Review changes against the merge-base with a branch",
		input: {
			hint: "<branch> [optional review instructions]",
		},
	},
	{
		name: "/review-commit",
		description: "Review a single commit",
		input: {
			hint: "<commit> [optional review instructions]",
		},
	},
]

export type ReviewCommand =
	| { kind: "review"; instructions?: string }
	| { kind: "review-branch"; target?: string; instructions?: string }
	| { kind: "review-commit"; target?: string; instructions?: string }

export interface ReviewFinding {
	severity: "high" | "medium" | "low"
	path: string
	line: number
	title: string
	explanation: string
}

export interface ReviewDiffFile {
	path: string
	oldText: string
	newText: string
}

export interface ReviewContext {
	diffLabel: string
	diffText: string
	files: ReviewDiffFile[]
	skippedBinaryFiles: string[]
}

export interface ReviewCommandHandlerOptions {
	commandText: string
	controller: Controller
	sessionId: string
	cwd: string
	emitSessionUpdate: (sessionId: string, update: acp.SessionUpdate) => Promise<void>
}

interface ReviewModelInput {
	command: ReviewCommand
	context: ReviewContext
}

interface ReviewCommandHandlerDependencies {
	collectReviewContext?: (command: ReviewCommand, cwd: string) => Promise<ReviewContext>
	runReviewModel?: (controller: Controller, input: ReviewModelInput) => Promise<string>
}

interface DiffFileSpec {
	currentPath: string
	oldPath: string
	oldRef: string | null
	newRef: string | "WORKTREE" | null
}

export function parseReviewCommand(text: string): ReviewCommand | null {
	const trimmed = text.trim()

	if (!trimmed.startsWith("/review")) {
		return null
	}

	const reviewMatch = trimmed.match(/^\/review(?:\s+([\s\S]*))?$/)
	if (reviewMatch) {
		return {
			kind: "review",
			instructions: reviewMatch[1]?.trim() || undefined,
		}
	}

	const branchMatch = trimmed.match(/^\/review-branch(?:\s+(\S+))?(?:\s+([\s\S]*))?$/)
	if (branchMatch) {
		return {
			kind: "review-branch",
			target: branchMatch[1]?.trim() || undefined,
			instructions: branchMatch[2]?.trim() || undefined,
		}
	}

	const commitMatch = trimmed.match(/^\/review-commit(?:\s+(\S+))?(?:\s+([\s\S]*))?$/)
	if (commitMatch) {
		return {
			kind: "review-commit",
			target: commitMatch[1]?.trim() || undefined,
			instructions: commitMatch[2]?.trim() || undefined,
		}
	}

	return null
}

export function formatReviewFindings(findings: ReviewFinding[]): string {
	if (findings.length === 0) {
		return "No review findings."
	}

	const sorted = [...findings].sort((left, right) => {
		const severityDelta = REVIEW_SEVERITY_ORDER[left.severity] - REVIEW_SEVERITY_ORDER[right.severity]
		if (severityDelta !== 0) {
			return severityDelta
		}
		const pathDelta = left.path.localeCompare(right.path)
		if (pathDelta !== 0) {
			return pathDelta
		}
		return left.line - right.line
	})

	return sorted
		.map((finding) => {
			const line = Math.max(1, Math.trunc(finding.line || 1))
			return `- ${finding.path}:${line} [${finding.severity}] ${finding.title}\n${finding.explanation}`
		})
		.join("\n\n")
}

export async function handleAcpReviewCommand(
	options: ReviewCommandHandlerOptions,
	dependencies: ReviewCommandHandlerDependencies = {},
): Promise<acp.PromptResponse | null> {
	const command = parseReviewCommand(options.commandText)
	if (!command) {
		return null
	}

	if (command.kind !== "review" && !command.target) {
		const missingTarget = command.kind === "review-branch" ? "branch" : "commit"
		await options.emitSessionUpdate(options.sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: `Error: /${command.kind} requires a ${missingTarget} argument.`,
			},
		})
		return { stopReason: "end_turn" }
	}

	const collectReviewContext = dependencies.collectReviewContext ?? collectReviewContextFromGit
	const runReviewModel = dependencies.runReviewModel ?? runReviewModelOnDiff
	const context = await collectReviewContext(command, options.cwd)

	if (context.files.length === 0) {
		const skippedText =
			context.skippedBinaryFiles.length > 0 ? ` Skipped binary files: ${context.skippedBinaryFiles.join(", ")}.` : ""
		await options.emitSessionUpdate(options.sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: `No reviewable text changes found.${skippedText}`,
			},
		})
		return { stopReason: "end_turn" }
	}

	const toolCallId = randomUUID()
	await options.emitSessionUpdate(options.sessionId, {
		sessionUpdate: "tool_call",
		toolCallId,
		title: "Review changes",
		kind: "edit",
		status: "completed",
		content: context.files.map((file) => ({
			type: "diff",
			path: file.path,
			oldText: file.oldText,
			newText: file.newText,
		})),
		locations: context.files.map((file) => ({ path: file.path })),
	})

	const reviewResponse = await runReviewModel(options.controller, { command, context })
	const findings = parseReviewFindings(reviewResponse)
	let text = findings ? formatReviewFindings(findings) : reviewResponse.trim()

	if (context.skippedBinaryFiles.length > 0) {
		const skippedText = `Skipped binary files: ${context.skippedBinaryFiles.join(", ")}`
		text = text ? `${text}\n\n${skippedText}` : skippedText
	}

	await options.emitSessionUpdate(options.sessionId, {
		sessionUpdate: "agent_message_chunk",
		content: {
			type: "text",
			text: text || "No review findings.",
		},
	})

	return { stopReason: "end_turn" }
}

export async function collectReviewContextFromGit(command: ReviewCommand, cwd: string): Promise<ReviewContext> {
	switch (command.kind) {
		case "review": {
			const hasHead = hasGitRevision(cwd, "HEAD")
			return buildReviewContext({
				cwd,
				diffLabel: hasHead ? "HEAD vs working tree" : "empty tree vs working tree",
				specs: collectWorktreeSpecs(cwd, hasHead),
			})
		}
		case "review-branch": {
			const mergeBase = gitText(cwd, ["merge-base", command.target!, "HEAD"]).trim()
			return buildReviewContext({
				cwd,
				diffLabel: `${command.target}...HEAD (merge-base ${mergeBase})`,
				diffText: gitText(cwd, ["diff", "--find-renames", `${mergeBase}...HEAD`]),
				specs: parseNameStatus(
					gitText(cwd, ["diff", "--name-status", "-z", "--find-renames", `${mergeBase}...HEAD`]),
				).map((entry) => ({
					currentPath: entry.currentPath,
					oldPath: entry.previousPath ?? entry.currentPath,
					oldRef: mergeBase,
					newRef: entry.status === "D" ? null : "HEAD",
				})),
			})
		}
		case "review-commit": {
			const commit = command.target!
			const parentRef = resolveCommitParent(cwd, commit)
			return buildReviewContext({
				cwd,
				diffLabel: `commit ${commit}`,
				diffText: gitText(cwd, ["show", "--format=fuller", "--stat", "--patch", commit]),
				specs: parseNameStatus(gitText(cwd, ["diff-tree", "--root", "--name-status", "-r", "-z", commit])).map(
					(entry) => ({
						currentPath: entry.currentPath,
						oldPath: entry.previousPath ?? entry.currentPath,
						oldRef: entry.status === "A" ? null : parentRef,
						newRef: entry.status === "D" ? null : commit,
					}),
				),
			})
		}
	}
}

export async function runReviewModelOnDiff(controller: Controller, input: ReviewModelInput): Promise<string> {
	const apiConfiguration = controller.stateManager.getApiConfiguration()
	const mode = controller.stateManager.getGlobalSettingsKey("mode")
	const configWithoutThinking = disableThinking(apiConfiguration)
	const apiHandler = buildApiHandler(configWithoutThinking, mode === "plan" ? "plan" : "act")
	const changedFiles = input.context.files.map((file) => file.path).join("\n")
	const skippedBinaryFiles = input.context.skippedBinaryFiles.join("\n")
	const commandLabel =
		input.command.kind === "review"
			? "/review"
			: `/${input.command.kind} ${input.command.target ?? ""}`.trim()

	const systemPrompt = `You are performing a read-only code review.

Focus only on bugs, regressions, correctness issues, security problems, and missing tests for risky changes.
Do not suggest code edits or praise the patch. Ignore style issues unless they cause a defect.

Return only valid JSON with this shape:
{"findings":[{"severity":"high"|"medium"|"low","path":"relative/path","line":123,"title":"short title","explanation":"concise explanation"}]}

Rules:
- Use only paths that appear in the supplied diff.
- Use 1-based line numbers in the changed file revision.
- If there are no findings, return {"findings":[]}.`

	const userMessage = `Review command: ${commandLabel}
Diff scope: ${input.context.diffLabel}
Additional instructions: ${input.command.instructions ?? "None"}

Changed files:
${changedFiles || "(none)"}

Skipped binary files:
${skippedBinaryFiles || "(none)"}

Diff:
${input.context.diffText}`

	const chunks: string[] = []

	try {
		for await (const chunk of apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: userMessage } satisfies DiracStorageMessage,
		])) {
			if (chunk.type === "text") {
				chunks.push(chunk.text)
			}
		}
	} catch (error) {
		Logger.error("[review] Error running review model:", error)
		throw error
	} finally {
		apiHandler.abort?.()
	}

	return chunks.join("").trim()
}

function disableThinking(apiConfiguration: ApiConfiguration): ApiConfiguration {
	return {
		...apiConfiguration,
		actModeThinkingBudgetTokens: 0,
		planModeThinkingBudgetTokens: 0,
	}
}

function parseReviewFindings(text: string): ReviewFinding[] | null {
	const candidate = stripCodeFence(text.trim())
	if (!candidate) {
		return null
	}

	try {
		const parsed = JSON.parse(candidate) as { findings?: unknown }
		const findings = Array.isArray(parsed) ? parsed : parsed.findings
		if (!Array.isArray(findings)) {
			return null
		}

		return findings
			.map((finding) => normalizeFinding(finding))
			.filter((finding): finding is ReviewFinding => finding !== null)
	} catch {
		return null
	}
}

function normalizeFinding(value: unknown): ReviewFinding | null {
	if (!value || typeof value !== "object") {
		return null
	}

	const finding = value as Record<string, unknown>
	const severity = `${finding.severity ?? ""}`.toLowerCase()
	const path = `${finding.path ?? ""}`.trim()
	const title = `${finding.title ?? ""}`.trim()
	const explanation = `${finding.explanation ?? ""}`.trim()
	const line = Number.parseInt(`${finding.line ?? ""}`, 10)

	if (!path || !title || !explanation || !["high", "medium", "low"].includes(severity)) {
		return null
	}

	return {
		severity: severity as ReviewFinding["severity"],
		path,
		line: Number.isFinite(line) && line > 0 ? line : 1,
		title,
		explanation,
	}
}

function stripCodeFence(text: string): string {
	const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	return fencedMatch ? fencedMatch[1].trim() : text
}

function buildReviewContext(options: {
	cwd: string
	diffLabel: string
	diffText?: string
	specs: DiffFileSpec[]
}): ReviewContext {
	const files: ReviewDiffFile[] = []
	const skippedBinaryFiles: string[] = []

	for (const spec of options.specs) {
		const oldBuffer = readBufferForSpec(options.cwd, spec.oldRef, spec.oldPath)
		const newBuffer = readBufferForSpec(options.cwd, spec.newRef, spec.currentPath)
		if (looksBinary(oldBuffer) || looksBinary(newBuffer)) {
			skippedBinaryFiles.push(spec.currentPath)
			continue
		}

		files.push({
			path: spec.currentPath,
			oldText: oldBuffer.toString("utf8"),
			newText: newBuffer.toString("utf8"),
		})
	}

	return {
		diffLabel: options.diffLabel,
		diffText: options.diffText ?? buildUnifiedDiffText(files),
		files,
		skippedBinaryFiles,
	}
}

function gitText(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
}

function readBufferForSpec(cwd: string, ref: string | "WORKTREE" | null, filePath: string): Buffer {
	if (!ref) {
		return Buffer.alloc(0)
	}

	if (ref === "WORKTREE") {
		const absolutePath = path.join(cwd, filePath)
		if (!existsSync(absolutePath)) {
			return Buffer.alloc(0)
		}
		return readFileSync(absolutePath)
	}

	try {
		return execFileSync("git", ["show", `${ref}:${filePath}`], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
	} catch {
		return Buffer.alloc(0)
	}
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.includes(0)
}

function hasGitRevision(cwd: string, revision: string): boolean {
	try {
		gitText(cwd, ["rev-parse", "--verify", revision])
		return true
	} catch {
		return false
	}
}

function collectWorktreeSpecs(cwd: string, hasHead: boolean): DiffFileSpec[] {
	if (!hasHead) {
		return collectPaths(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).map((filePath) => ({
			currentPath: filePath,
			oldPath: filePath,
			oldRef: null,
			newRef: "WORKTREE",
		}))
	}

	const specs: DiffFileSpec[] = parseNameStatus(gitText(cwd, ["diff", "--name-status", "-z", "--find-renames", "HEAD", "--"])).map(
		(entry) => ({
			currentPath: entry.currentPath,
			oldPath: entry.previousPath ?? entry.currentPath,
			oldRef: "HEAD",
			newRef: entry.status === "D" ? null : "WORKTREE",
		}),
	)

	for (const filePath of collectPaths(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])) {
		specs.push({
			currentPath: filePath,
			oldPath: filePath,
			oldRef: null,
			newRef: "WORKTREE",
		})
	}

	return specs
}

function resolveCommitParent(cwd: string, commit: string): string {
	try {
		return gitText(cwd, ["rev-parse", `${commit}^`]).trim()
	} catch {
		return EMPTY_TREE_SHA
	}
}

function parseNameStatus(output: string): Array<{ status: string; currentPath: string; previousPath?: string }> {
	const parts = output.split("\0").filter((part) => part.length > 0)
	const entries: Array<{ status: string; currentPath: string; previousPath?: string }> = []

	for (let index = 0; index < parts.length; ) {
		const statusToken = parts[index++]
		const status = statusToken[0]
		if (status === "R" || status === "C") {
			const previousPath = parts[index++]
			const currentPath = parts[index++]
			if (previousPath && currentPath) {
				entries.push({ status, currentPath, previousPath })
			}
			continue
		}

		const currentPath = parts[index++]
		if (currentPath) {
			entries.push({ status, currentPath })
		}
	}

	return entries
}

function collectPaths(cwd: string, args: string[]): string[] {
	return gitText(cwd, args)
		.split("\0")
		.filter((part) => part.length > 0)
}

function buildUnifiedDiffText(files: ReviewDiffFile[]): string {
	return files
		.map((file) => {
			const oldFileName = file.oldText.length === 0 && file.newText.length > 0 ? "/dev/null" : `a/${file.path}`
			const newFileName = file.newText.length === 0 && file.oldText.length > 0 ? "/dev/null" : `b/${file.path}`
			return Diff.createTwoFilesPatch(oldFileName, newFileName, file.oldText, file.newText, "", "", {
				context: 3,
			}).trim()
		})
		.join("\n\n")
}
