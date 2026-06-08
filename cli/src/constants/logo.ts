/**
 * Shared Dirac ASCII logo and gradient colors.
 * Used by WelcomeView and AsciiMotionCli.
 */

/** 16-line ASCII art Dirac logo. */
export const DIRAC_LOGO = [
	"        █████████████        ",
	"      ███          ▀▀██      ",
	"    ██▀                      ",
	"    ██▄                      ",
	"      ▀██▄                   ",
	"         ▀██▄                ",
	"           ▀██▄              ",
	"         ▄██▀ ▀██▄           ",
	"      ▄██▀      ▀██▄         ",
	"    ▄██▀          ▀██▄       ",
	"  ▄██▀              ▀██▄     ",
	"▄██▀                  ▀██▄   ",
	"▀██▄                  ▄██▀   ",
	"  ▀██▄              ▄██▀     ",
	"    ▀██▄          ▄██▀       ",
	"       ▀▀▀▀▀▀▀▀▀▀▀▀          ",
] as const

/**
 * Per-line gradient from blue (#B1B9F9) at top to gold (#F59E0B) at bottom.
 * Index 0 = top line, index 15 = bottom line.
 */
export const LOGO_GRADIENT: readonly string[] = (() => {
	const top = [0xb1, 0xb9, 0xf9] as const   // #B1B9F9
	const bot = [0xf5, 0x9e, 0x0b] as const   // #F59E0B
	const n = DIRAC_LOGO.length
	return Array.from({ length: n }, (_, i) => {
		const t = i / (n - 1)
		const r = Math.round(top[0] + (bot[0] - top[0]) * t)
		const g = Math.round(top[1] + (bot[1] - top[1]) * t)
		const b = Math.round(top[2] + (bot[2] - top[2]) * t)
		return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
	})
})()
