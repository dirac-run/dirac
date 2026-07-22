import { StringRequest } from "@shared/proto/dirac/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import mermaid from "mermaid"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import styled from "styled-components"
import { FileServiceClient } from "@/shared/api/grpc-client"

const MERMAID_THEME = {
	background: "#1e1e1e",
	textColor: "#ffffff",
	mainBkg: "#2d2d2d",
	nodeBorder: "#888888",
	lineColor: "#cccccc",
	primaryColor: "#3c3c3c",
	primaryTextColor: "#ffffff",
	primaryBorderColor: "#888888",
	secondaryColor: "#2d2d2d",
	tertiaryColor: "#454545",
	classText: "#ffffff",
	labelColor: "#ffffff",
	actorLineColor: "#cccccc",
	actorBkg: "#2d2d2d",
	actorBorder: "#888888",
	actorTextColor: "#ffffff",
	fillType0: "#2d2d2d",
	fillType1: "#3c3c3c",
	fillType2: "#454545",
}

mermaid.initialize({
	startOnLoad: false,
	securityLevel: "strict",
	theme: "dark",
	themeVariables: {
		...MERMAID_THEME,
		fontSize: "16px",
		fontFamily: "var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif)",
		noteTextColor: "#ffffff",
		noteBkgColor: "#454545",
		noteBorderColor: "#888888",
		critBorderColor: "#ff9580",
		critBkgColor: "#803d36",
		taskTextColor: "#ffffff",
		taskTextOutsideColor: "#ffffff",
		taskTextLightColor: "#ffffff",
		sectionBkgColor: "#2d2d2d",
		sectionBkgColor2: "#3c3c3c",
		altBackground: "#2d2d2d",
		linkColor: "#6cb6ff",
		compositeBackground: "#2d2d2d",
		compositeBorder: "#888888",
		titleColor: "#ffffff",
	},
})

interface MermaidBlockProps {
	code: string
}

let nextDiagramId = 0

export default function MermaidBlock({ code }: MermaidBlockProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const renderVersionRef = useRef(0)
	const [renderedSvg, setRenderedSvg] = useState<string>()
	const [renderError, setRenderError] = useState<string>()
	const [isLoading, setIsLoading] = useState(false)

	useEffect(() => {
		const renderVersion = ++renderVersionRef.current
		setIsLoading(true)
		setRenderError(undefined)

		const timer = window.setTimeout(async () => {
			try {
				const isValid = await mermaid.parse(code, { suppressErrors: true })
				if (!isValid) throw new Error("Invalid or incomplete Mermaid code")

				const id = `mermaid-${++nextDiagramId}`
				const { svg } = await mermaid.render(id, code)
				if (renderVersionRef.current !== renderVersion) return
				setRenderedSvg(svg)
			} catch (error) {
				if (renderVersionRef.current !== renderVersion) return
				console.warn("Mermaid parse/render failed:", error)
				setRenderError(code)
				setRenderedSvg(undefined)
			} finally {
				if (renderVersionRef.current === renderVersion) setIsLoading(false)
			}
		}, 500)

		return () => {
			window.clearTimeout(timer)
			if (renderVersionRef.current === renderVersion) renderVersionRef.current++
		}
	}, [code])

	useLayoutEffect(() => {
		const container = containerRef.current
		if (!container) return
		if (renderedSvg) container.innerHTML = renderedSvg
		else if (renderError) container.replaceChildren()
	}, [renderedSvg, renderError])

	const handleClick = async () => {
		const svgElement = containerRef.current?.querySelector("svg")
		if (!svgElement) return

		try {
			const pngDataUrl = await svgToPng(svgElement)
			await FileServiceClient.openImage(StringRequest.create({ value: pngDataUrl }))
		} catch (error) {
			console.error("Error opening Mermaid diagram:", error)
		}
	}

	const handleCopyCode = async () => {
		try {
			await navigator.clipboard.writeText(code)
		} catch (error) {
			console.error("Copy failed", error)
		}
	}

	return (
		<MermaidBlockContainer aria-busy={isLoading}>
			{isLoading && <LoadingMessage role="status">Generating Mermaid diagram…</LoadingMessage>}
			<ButtonContainer>
				<StyledVSCodeButton aria-label="Copy Mermaid code" onClick={handleCopyCode} title="Copy Mermaid code">
					<span className="codicon codicon-copy" />
				</StyledVSCodeButton>
			</ButtonContainer>
			{renderError && !renderedSvg ? <ErrorContainer>{renderError}</ErrorContainer> : null}
			<SvgContainer
				aria-label={renderedSvg ? "Open Mermaid diagram" : undefined}
				onClick={renderedSvg ? handleClick : undefined}
				onKeyDown={(event) => {
					if (renderedSvg && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault()
						handleClick()
					}
				}}
				ref={containerRef}
				role={renderedSvg ? "button" : undefined}
				tabIndex={renderedSvg ? 0 : undefined}
			/>
		</MermaidBlockContainer>
	)
}

async function svgToPng(svgElement: SVGElement): Promise<string> {
	const svgClone = svgElement.cloneNode(true) as SVGElement
	const viewBox = svgClone.getAttribute("viewBox")?.split(" ").map(Number) || []
	const originalWidth = viewBox[2] || svgClone.clientWidth
	const originalHeight = viewBox[3] || svgClone.clientHeight
	if (!originalWidth || !originalHeight) throw new Error("Mermaid diagram has no measurable dimensions")

	const editorWidth = 3_600
	const scaledHeight = originalHeight * (editorWidth / originalWidth)
	svgClone.setAttribute("width", `${editorWidth}`)
	svgClone.setAttribute("height", `${scaledHeight}`)

	const svgString = new XMLSerializer().serializeToString(svgClone)
	const bytes = new TextEncoder().encode(svgString)
	const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
	const svgDataUrl = `data:image/svg+xml;base64,${base64}`

	return new Promise((resolve, reject) => {
		const image = new Image()
		image.onload = () => {
			const canvas = document.createElement("canvas")
			canvas.width = editorWidth
			canvas.height = scaledHeight
			const context = canvas.getContext("2d")
			if (!context) {
				reject(new Error("Canvas context not available"))
				return
			}

			context.fillStyle = MERMAID_THEME.background
			context.fillRect(0, 0, canvas.width, canvas.height)
			context.imageSmoothingEnabled = true
			context.imageSmoothingQuality = "high"
			context.drawImage(image, 0, 0, editorWidth, scaledHeight)
			resolve(canvas.toDataURL("image/png", 1))
		}
		image.onerror = () => reject(new Error("Failed to rasterize Mermaid diagram"))
		image.src = svgDataUrl
	})
}

const MermaidBlockContainer = styled.div`
	position: relative;
	min-width: 0;
	margin: 8px 0;
`

const ButtonContainer = styled.div`
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 1;
	opacity: 0.7;
	transition: opacity 0.2s ease;

	&:hover,
	&:focus-within {
		opacity: 1;
	}
`

const LoadingMessage = styled.div`
	position: absolute;
	top: 8px;
	left: 8px;
	z-index: 1;
	padding: 3px 6px;
	border-radius: 3px;
	background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
	color: var(--vscode-descriptionForeground);
	font-size: 0.8em;
`

const ErrorContainer = styled.pre`
	box-sizing: border-box;
	max-width: 100%;
	max-height: 240px;
	margin: 0;
	padding: 12px;
	overflow: auto;
	white-space: pre-wrap;
	word-break: break-word;
`

const SvgContainer = styled.div`
	min-height: 56px;
	max-width: 100%;
	overflow: auto;
	cursor: pointer;
	display: flex;
	justify-content: center;

	&:empty {
		cursor: default;
	}

	&:focus-visible {
		outline: 2px solid var(--vscode-focusBorder);
		outline-offset: 2px;
	}

	& > svg {
		max-width: 100%;
		height: auto;
	}
`

const StyledVSCodeButton = styled(VSCodeButton)`
	padding: 4px;
	height: 24px;
	width: 24px;
	min-width: unset;
	background-color: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border: 1px solid var(--vscode-button-border);
	border-radius: 3px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background-color 0.2s ease, border-color 0.2s ease;

	.codicon {
		font-size: 14px;
	}

	&:hover {
		background-color: var(--vscode-button-secondaryHoverBackground);
		border-color: var(--vscode-button-border);
	}
`
