import { CardStatus } from "@shared/ExtensionMessage"
import type { ICardHandle } from "../../interfaces/ICardHandle"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { type ArchitectureDiagramArguments, validateArchitectureDiagramArguments } from "./ArchitectureDiagramArguments"
import type { ArchitectureDiagramEnvironment } from "./ArchitectureDiagramEnvironment"
import { displayArchitecture } from "./ArchitectureDisplay"

interface OperationOutcome {
	status: CardStatus
	body: string
	result: unknown
	saved?: { name: string; version: number }
}

function failedOperation(env: ArchitectureDiagramEnvironment, operation: string, outcome: "error" | "unavailable" | "timeout", error: unknown): OperationOutcome {
	env.orchestration.reportFailure()
	const message = `${operation}: ${error instanceof Error ? error.message : String(error)}`
	return { status: CardStatus.ERROR, body: message, result: { operation, outcome, error: message } }
}


async function executeSemanticOperation(
	args: Exclude<ArchitectureDiagramArguments, { operation: "display_diagram" | "display_comparison" }>,
	env: ArchitectureDiagramEnvironment,
): Promise<OperationOutcome> {
	const architecture = env.architecture
	if (!architecture)
		return failedOperation(env, args.operation, "unavailable", "Architecture storage is unavailable in this execution.")
	const deadline = new ToolExecutionDeadline("architecture_diagram")
	try {
		switch (args.operation) {
			case "upsert_diagram": {
				const result = await deadline.run("publishing diagram", () => architecture.upsertDiagram(args.name, args.diagram))
				return { status: CardStatus.SUCCESS, body: `Saved diagram "${result.name}", version ${result.version}.`, result, saved: result }
			}
			case "list_diagrams": {
				const result = await deadline.observe("listing diagrams", () => architecture.listDiagrams())
				return {
					status: CardStatus.SUCCESS,
					body: `Listed ${result.length} task-local diagram(s). Names and versions returned to the model.`,
					result,
				}
			}
			case "fetch_diagram": {
				const result = await deadline.observe("fetching diagram", () => architecture.fetchDiagram(args.name, args.version))
				return {
					status: CardStatus.SUCCESS,
					body: `Fetched diagram "${result.name}", version ${result.version}. Semantic content returned to the model.`,
					result,
				}
			}
		}
	} catch (error) {
		if (error instanceof ToolTimeoutError) {
			const writeWarning =
				args.operation === "upsert_diagram"
					? " Publication has settled but may have committed; timeout is not confirmation of an uncommitted version. List/fetch before deciding whether to retry."
					: ""
			return failedOperation(env, args.operation, "timeout", error.message + writeWarning)
		}
		return failedOperation(env, args.operation, "error", error)
	}
}

/** Only feature operations are converted to explicit failures; shared card failures retain their normal semantics. */
export async function executeArchitectureDiagram(
	input: unknown,
	env: ArchitectureDiagramEnvironment,
	card: ICardHandle,
): Promise<string> {
	let args: ArchitectureDiagramArguments
	try {
		args = validateArchitectureDiagramArguments(input)
	} catch (error) {
		const operation =
			input && typeof input === "object" && "operation" in input && typeof input.operation === "string"
				? input.operation
				: "unknown"
		return completeCard(card, failedOperation(env, operation, "error", error))
	}
	if (args.operation === "display_diagram" || args.operation === "display_comparison") return displayArchitecture(args, env, card)
	const outcome = await executeSemanticOperation(args, env)
	if (outcome.saved) {
		return displayArchitecture({ operation: "display_diagram", ...outcome.saved }, env, card, outcome.saved)
	}
	return completeCard(card, outcome)
}

async function completeCard(card: ICardHandle, outcome: OperationOutcome): Promise<string> {
	try {
		await card.update({ status: outcome.status, body: outcome.body })
	} finally {
		await card.finalize(outcome.status)
	}
	return JSON.stringify(outcome.result)
}
