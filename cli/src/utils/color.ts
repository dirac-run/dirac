/**
 * Convert HSL values to a hex color string.
 *
 * @param h Hue in degrees (0–360)
 * @param s Saturation as a percentage (0–100)
 * @param l Lightness as a percentage (0–100)
 * @returns Hex color string, e.g. "#cc8800"
 */
export function hslToHex(h: number, s: number, l: number): string {
    s /= 100
    l /= 100

    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2

    let r = 0,
        g = 0,
        b = 0

    if (h < 60) {
        r = c; g = x; b = 0
    } else if (h < 120) {
        r = x; g = c; b = 0
    } else if (h < 180) {
        r = 0; g = c; b = x
    } else if (h < 240) {
        r = 0; g = x; b = c
    } else if (h < 300) {
        r = x; g = 0; b = c
    } else {
        r = c; g = 0; b = x
    }

    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0")
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
