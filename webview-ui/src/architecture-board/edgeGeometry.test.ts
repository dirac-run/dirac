import { describe, expect, it } from "vitest"
import { Position } from "@xyflow/react"
import type { ArchitectureDiagram } from "@shared/architecture"
import ELK from "elkjs/lib/elk.bundled.js"
import fixture from "./fixtures/goals-and-subagents.json"
import wideFixture from "./fixtures/tool-execution.json"
import compoundFixture from "./fixtures/goals-vs-subagents.json"
import { roundedRoute } from "./edgeGeometry"
import { applyLayoutPorts, toFlowGraph } from "./flowGraph"
import { fromElkGraph, toElkGraph } from "./layoutGraph"
import { arrangeCandidates, layoutCandidates } from "./layoutCandidates"
import { absoluteBoxes } from "./routeGeometry"
import type { LayoutInput } from "./layoutGraph"

async function arrange(input: LayoutInput) {
	const elk = new ELK()
	const outcomes: Array<{ graph: Awaited<ReturnType<ELK["layout"]>> } | { error: unknown }> = []
	for (const candidate of layoutCandidates(input)) {
		try {
			outcomes.push({ graph: await elk.layout(toElkGraph(input, candidate.options)) })
		} catch (error) {
			outcomes.push({ error })
		}
	}
	return arrangeCandidates(input, () => {
		const outcome = outcomes.shift()!
		if ("error" in outcome) throw outcome.error
		return structuredClone(outcome.graph)
	})
}

function bounds(diagram: ArchitectureDiagram, layout: ReturnType<typeof fromElkGraph>) {
	const boxes = absoluteBoxes(diagram, layout)
	return {
		width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
		height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)),
	}
}

const diagram = fixture as ArchitectureDiagram

describe("Architecture connection presentation", () => {
	it("rounds orthogonal bends without changing endpoints and labels the longest segment", () => {
		const route = roundedRoute([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 50 },
		])
		expect(route.path).toBe("M 0 0 L 90 0 Q 100 0 100 10 L 100 50")
		expect(route.label).toEqual({ x: 50, y: 0 })
		expect(
			roundedRoute([
				{ x: 1, y: 2 },
				{ x: 1, y: 2 },
				{ x: 3, y: 2 },
			]).path,
		).not.toMatch(/NaN|Infinity/)
	})
	it("keeps parallel relationships individually addressable even before layout", () => {
		const { nodes, edges } = toFlowGraph(diagram)
		const parallel = edges.filter((edge) => edge.source === "goal-coordinator" && edge.target === "goal-host")
		expect(parallel).toHaveLength(2)
		expect(new Set(parallel.map((edge) => edge.sourceHandle)).size).toBe(2)
		expect(new Set(parallel.map((edge) => edge.targetHandle)).size).toBe(2)
		for (const edge of edges) {
			expect(nodes.find((node) => node.id === edge.source)!.data.ports.some((port) => port.id === edge.sourceHandle)).toBe(
				true,
			)
			expect(nodes.find((node) => node.id === edge.target)!.data.ports.some((port) => port.id === edge.targetHandle)).toBe(
				true,
			)
		}
	})
	it("converts group-local routes to canvas coordinates and derives accurate boundary handles", () => {
		const layout = fromElkGraph({
			id: "root",
			children: [
				{
					id: "node:g",
					x: 100,
					y: 200,
					width: 400,
					height: 300,
					children: [
						{ id: "node:a", x: 20, y: 40, width: 100, height: 60 },
						{ id: "node:b", x: 200, y: 40, width: 100, height: 60 },
					],
				},
			],
			edges: [
				{
					id: "edge:e",
					sources: ["node:a"],
					targets: ["node:b"],
					container: "node:g",
					sections: [{ id: "s", startPoint: { x: 120, y: 70 }, endPoint: { x: 200, y: 70 } }],
				},
			],
		})
		expect(layout.routes.e).toEqual([
			{ x: 220, y: 270 },
			{ x: 300, y: 270 },
		])
		const { nodes } = toFlowGraph({
			title: "Group",
			summary: "",
			nodes: [
				{ id: "g", kind: "group", label: "G" },
				{ id: "a", kind: "component", label: "A", parentId: "g" },
				{ id: "b", kind: "component", label: "B", parentId: "g" },
			],
			edges: [{ id: "e", kind: "data_flow", source: "a", target: "b" }],
		})
		const routed = applyLayoutPorts(nodes, layout)
		expect(routed.find((node) => node.id === "a")!.data.ports[0]).toMatchObject({ side: Position.Right, offset: 50 })
		expect(routed.find((node) => node.id === "b")!.data.ports[0]).toMatchObject({ side: Position.Left, offset: 50 })
	})
	it("naturally wraps a wide flow toward 16:9 without stretching cards or changing topology", async () => {
		const diagram = wideFixture as ArchitectureDiagram
		const dimensions = Object.fromEntries(
			toFlowGraph(diagram).nodes.map((node) => [
				node.id,
				{
					width: Number(node.style!.width),
					height: Number(node.style!.height),
				},
			]),
		)
		const elk = new ELK()
		// Composition is chosen by the production candidate search, not one raw ELK strategy.
		const layout = await arrange({ diagram, dimensions, canvas: { width: 1600, height: 900 } })
		const wrapped = bounds(diagram, layout)
		const unwrapped = bounds(
			diagram,
			fromElkGraph(await elk.layout(toElkGraph({ diagram, dimensions }, { wrapRoot: false }))),
		)
		const distance = (width: number, height: number) => Math.abs(Math.log(width / height / (16 / 9)))
		expect(distance(wrapped.width!, wrapped.height!)).toBeLessThan(distance(unwrapped.width!, unwrapped.height!))
		expect(wrapped.width! / wrapped.height!).toBeGreaterThan(1.4)
		expect(wrapped.width! / wrapped.height!).toBeLessThan(2.2)
		expect(Object.keys(layout.positions).sort()).toEqual(diagram.nodes.map((node) => node.id).sort())
		expect(Object.keys(layout.routes).sort()).toEqual(diagram.edges.map((edge) => edge.id).sort())
		for (const node of diagram.nodes.filter((node) => node.kind !== "group")) {
			expect(layout.sizes[node.id]).toEqual(dimensions[node.id])
		}
		for (const route of Object.values(layout.routes)) {
			for (let i = 1; i < route.length; i++) {
				expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true)
			}
		}
	}, 10_000)
	it("wraps inside the reported 17-node subsystems without losing cross-group relationships", async () => {
		const diagram = compoundFixture as ArchitectureDiagram
		const dimensions = Object.fromEntries(diagram.nodes.map((node) => [node.id, { width: 248, height: 102 }]))
		const input = { diagram, dimensions }
		const elk = new ELK()
		const original = await elk.layout(toElkGraph(input))
		const layout = await arrange(input)
		const compact = bounds(diagram, layout)
		const extent = (width: number, height: number) => Math.max(width / (16 / 9), height)
		expect(original.width! / original.height!).toBeGreaterThan(3)
		expect(compact.width! / compact.height!).toBeGreaterThan(1.4)
		expect(compact.width! / compact.height!).toBeLessThan(2.3)
		expect(extent(compact.width!, compact.height!)).toBeLessThan(extent(original.width!, original.height!))
		expect(Object.keys(layout.positions).sort()).toEqual(diagram.nodes.map((node) => node.id).sort())
		expect(Object.keys(layout.routes).sort()).toEqual(diagram.edges.map((edge) => edge.id).sort())
		for (const node of diagram.nodes.filter((node) => node.kind !== "group"))
			expect(layout.sizes[node.id]).toEqual(dimensions[node.id])
		for (const route of Object.values(layout.routes)) {
			for (let i = 1; i < route.length; i++) {
				expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true)
			}
		}
	}, 10_000)
	it("lays out the retained geometry-only cycle with distinct routes and correct call direction", async () => {
		const dimensions = Object.fromEntries(diagram.nodes.map((node) => [node.id, { width: 248, height: 110 }]))
		const graph = toElkGraph({ diagram, dimensions })
		// A caller with an incoming result cannot use ELK's hard FIRST constraint.
		const parent = graph
			.children!.find((node) => node.id === "node:subagent-group")!
			.children!.find((node) => node.id === "node:subagent-parent")!
		expect(parent.layoutOptions?.["elk.layered.layering.layerConstraint"]).toBeUndefined()
		expect(graph.edges!.find((edge) => edge.id === "edge:subagent-call")).toMatchObject({
			sources: ["node:subagent-parent"],
			targets: ["node:subagent-tool"],
		})
		const layout = fromElkGraph(await new ELK().layout(graph))
		expect(Object.keys(layout.routes).sort()).toEqual(diagram.edges.map((edge) => edge.id).sort())
		expect(layout.routes["goal-start"]).not.toEqual(layout.routes["goal-control"])
		const boxes = absoluteBoxes(diagram, layout)
		const call = layout.routes["subagent-call"]
		for (const [id, point] of [
			["subagent-parent", call[0]],
			["subagent-tool", call.at(-1)!],
		] as const) {
			const box = boxes.find((box) => box.id === id)!
			expect(point.x).toBeGreaterThanOrEqual(box.x)
			expect(point.x).toBeLessThanOrEqual(box.x + box.width)
			expect(point.y).toBeGreaterThanOrEqual(box.y)
			expect(point.y).toBeLessThanOrEqual(box.y + box.height)
		}
		for (const route of Object.values(layout.routes)) {
			expect(route.length).toBeGreaterThanOrEqual(2)
			for (const point of route) expect(Number.isFinite(point.x + point.y)).toBe(true)
		}
	}, 10_000)
})
