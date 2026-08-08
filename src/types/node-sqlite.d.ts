/**
 * Minimal type declarations for `node:sqlite` (available at runtime on the Node
 * version this project runs, but the bundled `@types/node` does not ship them).
 * Only models the subset used by `SymbolIndexDatabase`.
 */
declare module "node:sqlite" {
	interface StatementResult {
		changes: number | bigint
		lastInsertRowid: number | bigint
	}
	interface StatementSync {
		get(...args: unknown[]): Record<string, unknown> | undefined
		all(...args: unknown[]): Record<string, unknown>[]
		iterate(...args: unknown[]): IterableIterator<Record<string, unknown>>
		run(...args: unknown[]): StatementResult
	}
	class DatabaseSync {
		constructor(path: string)
		prepare(sql: string, ...args: unknown[]): StatementSync
		exec(sql: string): void
		close(): void
	}
	export { DatabaseSync, type StatementSync }
}
