import type { BannerAction, BannerCardData } from "@shared/dirac/banner"
import React from "react"
import Markdown from "react-markdown"

interface WhatsNewItemsProps {
	welcomeBanners?: BannerCardData[]
	onBannerAction?: (action: BannerAction) => void
	onClose: () => void
	inlineCodeStyle: React.CSSProperties
	onNavigateToModelPicker: (modelId?: string) => void
}

type InlineModelLinkProps = { modelId: string; label: string }

export const WhatsNewItems: React.FC<WhatsNewItemsProps> = ({
	welcomeBanners,
	onBannerAction,
	onClose,
	inlineCodeStyle,
	onNavigateToModelPicker,
}) => {
	const InlineModelLink: React.FC<InlineModelLinkProps> = ({ modelId, label }) => (
		<span
			onClick={() => onNavigateToModelPicker(modelId)}
			style={{ color: "var(--vscode-textLink-foreground)", cursor: "pointer" }}>
			{label}
		</span>
	)

	const hasWelcomeBanners = welcomeBanners && welcomeBanners.length > 0

	return (
		<ul className="text-sm pl-3 list-disc" style={{ color: "var(--vscode-descriptionForeground)" }}>
			{hasWelcomeBanners ? (
				welcomeBanners.map((banner) => (
					<li className="mb-2" key={banner.id}>
						{banner.title && <strong>{banner.title}</strong>}{" "}
						{banner.description && (
							<Markdown
								components={{
									a: ({ href, children }) => (
										<a
											href={href}
											rel="noopener noreferrer"
											style={{ color: "var(--vscode-textLink-foreground)" }}
											target="_blank">
											{children}
										</a>
									),
									code: ({ children }) => <code style={inlineCodeStyle}>{children}</code>,
									p: ({ children }) => <p style={{ display: "inline", margin: 0 }}>{children}</p>,
								}}>
								{banner.description}
							</Markdown>
						)}
						{banner.actions && banner.actions.length > 0 && onBannerAction && (
							<span className="inline-flex gap-2 ml-2 align-middle">
								{banner.actions.map((action, idx) => (
									<a
										href="#"
										key={idx}
										onClick={(event) => {
											event.preventDefault()
											onBannerAction(action)
											onClose()
										}}
										style={{
											color: "var(--vscode-textLink-foreground)",
											cursor: "pointer",
										}}>
										{action.title}
									</a>
								))}
							</span>
						)}
					</li>
				))
			) : (
				<>
					<li className="mb-2">
						<strong>Hash Anchored MultiFile Edits:</strong> Dirac targets line hashes to perform high accuracy code
						edits and can batch multiple edits in a single file and multiple files in one shot.
					</li>
					<li className="mb-2">
						<strong>AST Precision:</strong> Dirac understands language syntax and can read from and manipulate a
						language's syntax directly (such as extract a function or replace a function)
					</li>
					<li className="mb-2">
						<strong>Minimal Roundtrips:</strong> Dirac can process multiple files or run multiple safe commands in
						parallel, minimizing roundtrip and API costs.
					</li>
					<li className="mb-2">
						<strong>Speed and Performance:</strong> Countless context curation optimizations allow Dirac to run lean
						and fast. This low context overhead improves LLM performance.
					</li>
				</>
			)}
		</ul>
	)
}

export default WhatsNewItems
