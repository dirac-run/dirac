import type { ApiProvider } from "@shared/api"

/**
 * Filters dynamic OpenRouter-style model IDs based on provider-specific rules.
 * OpenRouter and Vercel AI Gateway must not expose internal Dirac model IDs.
 */
export function filterOpenRouterModelIds(modelIds: string[], _provider: ApiProvider): string[] {
	return modelIds.filter((id) => !id.startsWith("dirac/"))
}

/**
 * OpenRouter canonical slugs carry a trailing release stamp in one of several
 * shapes. Ordered most-specific first so a full date wins over a bare month.
 */
const CANONICAL_DATE_PARSERS: Array<(canonicalSlug: string) => string | undefined> = [
	// vendor/model-2025-02-03 -> 20250203
	(canonicalSlug) => {
		const match = /(\d{4})-(\d{2})-(\d{2})$/u.exec(canonicalSlug)
		return match ? `${match[1]}${match[2]}${match[3]}` : undefined
	},
	// vendor/model-20251222 -> 20251222
	(canonicalSlug) => {
		const match = /(20\d{2})(\d{2})(\d{2})$/u.exec(canonicalSlug)
		return match ? `${match[1]}${match[2]}${match[3]}` : undefined
	},
	// vendor/model-05-2026 -> 20260501
	(canonicalSlug) => {
		const match = /(\d{2})-(20\d{2})$/u.exec(canonicalSlug)
		return match ? `${match[2]}${match[1]}01` : undefined
	},
	// vendor/model-2026-05 -> 20260501
	(canonicalSlug) => {
		const match = /(20\d{2})-(\d{2})$/u.exec(canonicalSlug)
		return match ? `${match[1]}${match[2]}01` : undefined
	},
	// vendor/model-250324 -> 20250324
	(canonicalSlug) => {
		const match = /(2\d)(\d{2})(\d{2})$/u.exec(canonicalSlug)
		return match ? `20${match[1]}${match[2]}${match[3]}` : undefined
	},
	// vendor/model-2603 -> 20260301
	(canonicalSlug) => {
		const match = /(2\d)(\d{2})$/u.exec(canonicalSlug)
		return match ? `20${match[1]}${match[2]}01` : undefined
	},
]

/**
 * Derives a sortable `YYYYMMDD` release key from a canonical slug.
 * Returns undefined when the slug carries no recognisable date stamp.
 */
export function releaseDateKey(canonicalSlug: string | undefined): string | undefined {
	if (!canonicalSlug) return undefined
	for (const parse of CANONICAL_DATE_PARSERS) {
		const key = parse(canonicalSlug)
		if (key !== undefined) return key
	}
	return undefined
}

/**
 * Orders model IDs so the most useful and current models are advertised first.
 *
 * ACP clients cap how many models they display and keep the leading entries, so
 * an alphabetical list silently truncates current models behind obsolete ones.
 * Rank in tiers: version aliases (how users reach "latest" releases), then
 * dated base models newest-first, then undated base models, and finally
 * suffixed variants such as `:batch` and `:free`, which restate a base model
 * and should never push that base model out of view.
 */
export function rankModelIdsForDisplay(
	modelIds: string[],
	canonicalSlugFor: (modelId: string) => string | undefined,
): string[] {
	const aliases: string[] = []
	const dated: Array<{ id: string; date: string }> = []
	const undated: string[] = []
	const variants: string[] = []

	for (const id of modelIds) {
		if (id.startsWith("~")) {
			aliases.push(id)
			continue
		}
		if (id.includes(":")) {
			variants.push(id)
			continue
		}
		const date = releaseDateKey(canonicalSlugFor(id))
		if (date === undefined) {
			undated.push(id)
		} else {
			dated.push({ id, date })
		}
	}

	aliases.sort((left, right) => left.localeCompare(right))
	undated.sort((left, right) => left.localeCompare(right))
	variants.sort((left, right) => left.localeCompare(right))
	dated.sort((left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id))

	return [...aliases, ...dated.map((entry) => entry.id), ...undated, ...variants]
}
