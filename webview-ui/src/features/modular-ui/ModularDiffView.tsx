import { memo } from "react"
import ReactMarkdown from "react-markdown"
import rehypeHighlight, { Options } from "rehype-highlight"
import { cn } from "@/lib/utils"

interface ModularDiffViewProps {
	diff: string
}

export const ModularDiffView = memo(({ diff }: ModularDiffViewProps) => {
	// Wrap diff in a markdown code block to trigger rehype-highlight
	const markdown = `\`\`\`diff\n${diff}\n\`\`\``

	const diffViewClasses = cn(
		"[&>pre]:m-0 [&>pre]:rounded [&>pre]:p-2 [&>pre]:overflow-x-auto",
		"[&>pre>code]:font-[var(--vscode-editor-font-family,'SF Mono',Monaco,Menlo,Courier,monospace)] [&>pre>code]:text-[var(--vscode-editor-font-size,12px)] [&>pre>code]:leading-6",
		// Diff highlight colors using VS Code theme variables
		"[&_.hljs-deletion]:inline-block [&_.hljs-deletion]:w-full",
		"[&_.hljs-addition]:inline-block [&_.hljs-addition]:w-full",
		"[&_.hljs-meta]:font-bold",
	)


	return (
		<div
			className={diffViewClasses}
			>
			<ReactMarkdown
				components={{
					pre: ({ children }) => <pre>{children}</pre>,
					code: ({ children, className }) => <code className={className}>{children}</code>,
				}}
				rehypePlugins={[[rehypeHighlight as any, {} as Options]]}>
				{markdown}
			</ReactMarkdown>
		</div>
	)
})

ModularDiffView.displayName = "ModularDiffView"
