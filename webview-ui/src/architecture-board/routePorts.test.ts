import { describe, expect, it, vi } from "vitest"
import * as router from "./orthogonalRouter"
import type { ArchitectureDiagram } from "@shared/architecture"
import { optimizeRoutePorts, dockShapeRoutes } from "./routePorts"
import { routeLength } from "./routeGeometry"
import { terminalSide } from "./nodeShapes"
import { measureLayout } from "./layoutQuality"
import { planLineJumps } from "./lineJumps"

const diagram: ArchitectureDiagram = {
	title: "The function can receive a result from its right",
	summary: "",
	nodes: [
		{ id: "tool", kind: "component", label: "Fan-out component" },
		{ id: "join", kind: "function", label: "Join ALL" },
	],
	edges: [{ id: "join", source: "tool", target: "join", kind: "dependency" }],
}
const layout = {
	positions: { tool: { x: 300, y: 0 }, join: { x: 0, y: 180 } },
	sizes: { tool: { width: 248, height: 96 }, join: { width: 248, height: 80 } },
	routes: {
		join: [
			{ x: 548, y: 48 },
			{ x: 580, y: 48 },
			{ x: 580, y: 160 },
			{ x: -20, y: 160 },
			{ x: -20, y: 220 },
			{ x: 0, y: 220 },
		],
	},
}

describe("Endpoint-aware routing", () => {
	it("spends a difficult edge's budget across distinct sides before retrying similar stubs", () => {
		const attempts: string[] = []
		const search = vi
			.spyOn(router, "shortestOrthogonalRoute")
			.mockImplementation((_a, _b, incoming, outgoing, _boxes, _lanes, budget) => {
				attempts.push(`${incoming}:${outgoing}`)
				budget.checks = budget.limit!
				budget.exhausted = true
				return undefined
			})
		try {
			const result = optimizeRoutePorts(diagram, layout)
			expect(attempts).toHaveLength(10)
			expect(new Set(attempts).size).toBe(attempts.length)
			expect(result.checks).toBe(40_000)
			expect(result.changed).toEqual([])
			expect(result.layout.routes).toEqual(layout.routes)
		} finally {
			search.mockRestore()
		}
	})
	it("replaces a forced left-side target with a short right-side approach", () => {
		const optimized = optimizeRoutePorts(diagram, layout)
		const result = dockShapeRoutes(diagram, optimized.layout)
		const route = result.routes.join
		expect(terminalSide(route.at(-1)!, route.at(-2)!)).toBe("right")
		expect(routeLength(route)).toBeLessThan(200)
		expect(result.positions).toEqual(layout.positions)
		expect(result.sizes).toEqual(layout.sizes)
		expect(measureLayout(diagram, result).invalid).toBeUndefined()
		expect(planLineJumps(diagram, result).issues).toEqual([])
		expect(optimized.changed).toEqual(["join"])
		expect(optimized.checks).toBeLessThanOrEqual(600_000)
		expect(optimizeRoutePorts(diagram, layout)).toEqual(optimized)
	})
	it("never treats a source-to-itself route as an ordinary two-node port choice", () => {
		const self = { ...diagram, edges: [{ ...diagram.edges[0], source: "tool", target: "tool" }] }
		const result = optimizeRoutePorts(self, layout)
		expect(result.changed).toEqual([])
		expect(result.layout.routes).toEqual(layout.routes)
	})
})
