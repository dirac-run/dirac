/** Hook process/output ownership could not be released successfully. Never fail open. */
export class HookCleanupError extends AggregateError {
	constructor(errors: Iterable<unknown>, message: string) {
		super(errors, message)
		this.name = "HookCleanupError"
	}
}
