import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../shared/lib/environmentColors"

/**
 * DiracLogoVariable component renders the Dirac logo with automatic theme adaptation
 * and environment-based color indicators.
 *
 * This component uses VS Code theme variables for the fill color, with environment-specific colors:
 * - Local: yellow/orange (development/experimental)
 * - Staging: blue (stable testing)
 * - Production: gray/white (default icon color)
 *
 * @param {SVGProps<SVGSVGElement> & { environment?: Environment }} props - Standard SVG props plus optional environment
 * @returns {JSX.Element} SVG Dirac logo that adapts to VS Code themes and environment
 */
const DiracLogoVariable = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, ...svgProps } = props

	// Determine accent color based on environment
	const accentColor = environment ? getEnvironmentColor(environment) : "#F59E0B"

	return (
		<svg height="129" viewBox="138.273 119.091 129 129" width="129" xmlns="http://www.w3.org/2000/svg" {...svgProps}>
			<rect
				fill="var(--vscode-sideBar-background, #09090B)"
				height="128"
				rx="24"
				style={{ strokeWidth: "1px" }}
				width="128"
				x="138.773"
				y="119.591"
			/>
			<path
				d="M 207.874 166.474 C 205.217 163.661, 203.522 161.402, 202.791 159.696 C 202.060 157.991, 201.872 156.305, 202.226 154.638 C 202.796 151.956, 204.392 149.775, 207.015 148.095 C 209.638 146.415, 212.850 145.575, 216.652 145.575 C 222.095 145.575, 226.408 146.969, 229.592 149.755 L 228.388 155.419 L 224.638 155.419 C 223.481 150.940, 220.623 148.700, 216.066 148.700 C 213.852 148.700, 212.063 149.189, 210.696 150.165 C 209.330 151.142, 208.503 152.307, 208.215 153.661 C 207.955 154.885, 208.208 156.083, 208.974 157.255 C 209.741 158.427, 212.140 161.044, 216.173 165.107 C 219.407 168.388, 221.621 171.513, 222.813 174.482 C 224.005 177.450, 224.169 180.966, 223.305 185.029 C 222.209 190.185, 219.699 194.338, 215.774 197.489 C 211.849 200.640, 207.399 202.216, 202.425 202.216 C 197.425 202.216, 193.712 200.634, 191.286 197.470 C 188.859 194.306, 188.180 190.211, 189.249 185.185 C 191.186 176.070, 197.394 169.833, 207.874 166.474 Z M 210.197 168.779 C 202.795 171.747, 198.200 177.437, 196.412 185.849 C 195.571 189.807, 195.769 193.010, 197.006 195.458 C 198.244 197.906, 200.243 199.130, 203.003 199.130 C 206.154 199.130, 208.878 197.861, 211.176 195.321 C 213.473 192.782, 215.082 189.351, 216.000 185.029 C 216.687 181.799, 216.560 178.935, 215.620 176.435 C 214.680 173.935, 212.872 171.383, 210.197 168.779 Z"
				fill="var(--vscode-foreground, #E4E4E7)"
			/>
			<line
				stroke="var(--vscode-foreground, #E4E4E7)"
				strokeLinecap="round"
				strokeOpacity="0.15"
				strokeWidth="3"
				style={{ strokeWidth: "3px" }}
				x1="154.773"
				x2="250.773"
				y1="231.591"
				y2="231.591"
			/>
			<path
				d="M 153.273 231.591 C 153.273 230.763 153.945 230.091 154.773 230.091 L 250.773 230.091 C 251.601 230.091 252.273 230.763 252.273 231.591 C 252.273 232.419 251.601 233.091 250.773 233.091 L 154.773 233.091 C 153.945 233.091 153.273 232.419 153.273 231.591 Z"
				fill="var(--vscode-foreground, #E4E4E7)"
			/>
			<line
				stroke={accentColor}
				strokeLinecap="round"
				strokeWidth="3"
				style={{ strokeWidth: "3px" }}
				x1="202.773"
				x2="202.773"
				y1="231.591"
				y2="216.591"
			/>
			<path
				d="M 202.773 233.091 C 201.945 233.091 201.273 232.419 201.273 231.591 L 201.273 216.591 C 201.273 215.763 201.945 215.091 202.773 215.091 C 203.601 215.091 204.273 215.763 204.273 216.591 L 204.273 231.591 C 204.273 232.419 203.601 233.091 202.773 233.091 Z"
				fill={accentColor}
			/>
			<circle cx="202.773" cy="211.591" fill={accentColor} r="4" style={{ strokeWidth: "1px" }} />
		</svg>
	)
}

export default DiracLogoVariable
