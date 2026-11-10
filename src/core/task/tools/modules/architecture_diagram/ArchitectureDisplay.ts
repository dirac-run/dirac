import { CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { ICardHandle } from "../../interfaces/ICardHandle"
import type { ArchitectureDisplayAvailability } from "../../interfaces/IArchitectureTrait"
import { ToolExecutionDeadline } from "../../runtime/ToolExecutionDeadline"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import type { ArchitectureDiagramArguments } from "./ArchitectureDiagramArguments"
import type { ArchitectureDiagramEnvironment } from "./ArchitectureDiagramEnvironment"

type DisplayArguments = Extract<ArchitectureDiagramArguments, { operation: "display_diagram" | "display_comparison" }>
type SavedDiagram = { name: string; version: number }

export async function displayArchitecture(
	args: DisplayArguments,
	env: ArchitectureDiagramEnvironment,
	card: ICardHandle,
	saved?: SavedDiagram,
): Promise<string> {
	const selection =
		args.operation === "display_comparison"
			? { name: args.name, mode: "comparison" as const, startVersion: args.start_version, endVersion: args.end_version }
			: args.version === undefined
				? { name: args.name, mode: "latest" as const }
				: { name: args.name, mode: "exact" as const, version: args.version }
	const description =
		args.operation === "display_comparison"
			? `Diagram "${args.name}", version ${args.start_version} (left) versus version ${args.end_version} (right).`
			: `${saved ? "Saved diagram" : "Diagram"} "${args.name}", ${args.version === undefined ? "latest version" : `version ${args.version}`}.`
	const result = { operation: saved ? "upsert_diagram" : args.operation, ...(saved ? { ...saved, saved: true } : {}), selection }
	let opened: ArchitectureDisplayAvailability
	try {
		opened = env.architecture?.openDisplay
			? await new ToolExecutionDeadline("architecture_diagram").run("opening architecture display", () =>
				env.architecture!.openDisplay!(selection),
			)
			: {
				available: false,
				reason: "Architecture viewer is unavailable in this execution. Use fetch_diagram and continue in chat.",
			}
	} catch (error) {
		return failDisplay(env, card, result, description, "error", error instanceof Error ? error.message : String(error), saved)
	}
	if (!opened.available) return failDisplay(env, card, result, description, "unavailable", opened.reason, saved)

	await card.update({
		architectureReference: opened.selection,
		header: args.operation === "display_comparison" ? "Architecture comparison" : "Architecture diagram",
		body: opened.waitForInput
			? `${description}\nThe architecture board is open. Reply directly in chat or save comments and Send Feedback; both are equally valid. Chat does not submit pending board comments. Opening or closing the board does not answer this interaction.`
			: `${description}\nThe architecture board is open. Autonomous mode continues without waiting for feedback. Reply directly in chat or save comments and Send Feedback later; chat does not submit pending board comments. Use the Open action to return to this view.`,
		status: opened.waitForInput ? CardStatus.WAITING_FOR_INPUT : CardStatus.RUNNING,
		requireFeedback: opened.waitForInput,
		feedbackPlaceholder: opened.waitForInput ? "Reply about the architecture…" : undefined,
		collapsed: false,
	})
	if (!opened.waitForInput) {
		await card.finalize(CardStatus.SUCCESS)
		return JSON.stringify({
			...result,
			outcome: "displayed",
			message:
				"The architecture board was opened and Open navigation remains on the transcript card. No user reply is being awaited. Continue without claiming feedback, visual verification, or approval.",
		})
	}
	let finalStatus = CardStatus.CANCELLED
	try {
		// Intentional user wait has no board I/O deadline. Shared cancellation/input semantics remain authoritative.
		const reply = await card.waitForInteraction()
		finalStatus = reply.response === DiracAskResponse.REJECT ? CardStatus.SKIPPED : CardStatus.SUCCESS
		return JSON.stringify({
			...result,
			outcome: finalStatus === CardStatus.SUCCESS ? "answered" : "declined",
			response: reply.text ?? reply.value ?? "",
		})
	} catch (error) {
		if (error instanceof ToolSkippedByUserMessage) finalStatus = CardStatus.SKIPPED
		throw error
	} finally {
		await card.update({ requireFeedback: false })
		if (!isFinalStatus(card.status)) await card.finalize(finalStatus)
	}
}

async function failDisplay(
	env: ArchitectureDiagramEnvironment,
	card: ICardHandle,
	result: { operation: string; selection: unknown },
	description: string,
	outcome: string,
	error: string,
	saved?: SavedDiagram,
): Promise<string> {
	env.orchestration.reportFailure()
	const recovery = saved
		? ` Version ${saved.version} is saved. Retry display_diagram with name "${saved.name}" and version ${saved.version}, not upsert_diagram; do not create a duplicate version.`
		: ""
	const body = `${description} Display failed: ${error}.${recovery} No Open action was created and no user input is being awaited.`
	try {
		await card.update({ body })
	} finally {
		await card.finalize(CardStatus.ERROR)
	}
	return JSON.stringify({ ...result, outcome, error: body })
}
