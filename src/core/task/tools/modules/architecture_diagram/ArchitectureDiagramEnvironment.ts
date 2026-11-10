import type { IArchitectureTrait } from "../../interfaces/IArchitectureTrait"
import type { CardParams, ICardHandle } from "../../interfaces/ICardHandle"

/** The subset of IToolEnvironment needed by this tool; keeps discovery independent of the task runtime. */
export interface ArchitectureDiagramEnvironment {
	readonly architecture?: IArchitectureTrait
	readonly ui: { createCard(params: CardParams): Promise<ICardHandle> }
	readonly orchestration: { reportFailure(): void }
}
