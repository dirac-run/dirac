/**
 * Color constants for the CLI
 * Re-exports from theme.ts for backward compatibility.
 */

import { theme } from "./theme"

export const COLORS = {
    // Primary brand color - light purple-blue
    primaryBlue: theme.primary,

    // Plan mode color
    planYellow: theme.plan,
} as const

/**
 * Get the appropriate color for the current mode
 */
export function getModeColor(mode: "act" | "plan"): string {
    return mode === "plan" ? COLORS.planYellow : COLORS.primaryBlue
}
