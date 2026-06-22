import type { SymbolIndexDatabase } from "./SymbolIndexDatabase"
import type { SymbolLocation } from "./SymbolIndexService"

/**
 * Read-only symbol lookup facade over {@link SymbolIndexDatabase}.
 * Holds a db accessor so the service can swap databases without re-wiring queries.
 */
export class SymbolIndexQuery {
	constructor(private readonly getDb: () => SymbolIndexDatabase | null) {}

	// Returns all known locations for a symbol, optionally filtered by type and capped by limit
	getSymbols(symbol: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		return this.getDb()?.getSymbolsByName(symbol, type, limit) || []
	}

	// Convenience wrapper: only reference locations
	getReferences(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "reference", limit)
	}

	// Convenience wrapper: only definition locations
	getDefinitions(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "definition", limit)
	}
}
