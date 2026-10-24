/**
 * Narrow file-access port that leaf services depend on instead of the
 * DiracIgnoreController type — consumers declare it, the ignore
 * controller satisfies it structurally.
 */
export interface PathAccessValidator {
	validateAccess(filePath: string): boolean
}
