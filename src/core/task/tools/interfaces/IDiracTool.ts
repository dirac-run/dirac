import { DiracToolSpec } from "../../../../shared/tools"

import { IToolEnvironment } from "./IToolEnvironment"
import { SurfaceType } from "./SurfaceType"

export interface IDiracTool<TArgs = any, TResult = any> {
	/**
	 * 1. DEFINITION
	 * Returns the JSON schema injected into the LLM's system prompt.
	 */
	spec(): DiracToolSpec

	/**
	 * 2. ENVIRONMENT CONSTRAINTS
	 * Returns the surfaces this tool supports (e.g., ['all'], ['ide', 'cli']).
	 */
	supportedSurfaces(): SurfaceType[]

	/**
	 * 3. EXECUTION
	 * The core logic of the tool. 
	 * The tool is responsible for its own validation, security (permissions), and UI updates.
	 */
	processCall(args: TArgs, env: IToolEnvironment): Promise<TResult>
}
