import type { Card } from "@shared/ExtensionMessage"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Observation only: no raw HTML, navigation, remote images, or executable code controls. */
export function CommunicationCardBody({ card }: { card: Card }) {
	const body = card.body ?? ""
	return (
		<div className="flex flex-col gap-2 border-t border-foreground/10 p-2.5">
			{body && (
				<div
					className="overflow-auto break-words text-sm leading-relaxed"
					id={`communication-content-${card.id}`}
					style={{ maxHeight: 320 }}>
					{card.renderType === "markdown" ? (
						<ReactMarkdown
							components={{
								a: ({ children, href }) => (
									<span>
										{children}
										{href ? ` (${href})` : ""}
									</span>
								),
								img: ({ alt, src }) => (
									<span>
										{alt}
										{src ? ` (${src})` : ""}
									</span>
								),
								input: ({ checked }) => <span>{checked ? "[x]" : "[ ]"}</span>,
								pre: ({ children }) => (
									<pre className="overflow-x-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 font-mono">
										{children}
									</pre>
								),
								p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
								ul: ({ children }) => <ul className="mb-2 list-disc pl-5">{children}</ul>,
								ol: ({ children }) => <ol className="mb-2 list-decimal pl-5">{children}</ol>,
							}}
							remarkPlugins={[remarkGfm]}>
							{body}
						</ReactMarkdown>
					) : (
						<pre className="whitespace-pre-wrap font-mono">{body}</pre>
					)}
				</div>
			)}
		</div>
	)
}
