import { StringRequest } from "@shared/proto/dirac/common"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/dirac/state"
import { SquareArrowOutUpRightIcon } from "lucide-react"
import { marked } from "marked"
import type { ComponentProps } from "react"
import React, { memo, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import rehypeHighlight, { Options } from "rehype-highlight"
import remarkGfm from "remark-gfm"
import type { Node, Parent } from "unist"
import { visit } from "unist-util-visit"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { FileServiceClient, StateServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import MermaidBlock from "@/shared/ui/MermaidBlock"
import { WithCopyButton } from "./CopyButton"
import UnsafeImage from "./UnsafeImage"
import "@/features/modular-ui/styles/modular-codeblock.css"

// --- Types ---

interface UnistNode extends Node {
    children?: UnistNode[]
    value?: string
    lang?: string
    data?: {
        hName?: string
        hProperties?: Record<string, unknown>
        [key: string]: unknown
    }
}

interface TextNode extends UnistNode {
    type: "text"
    value: string
}

interface CodeNode extends UnistNode {
    type: "code"
    lang?: string
    value: string
}

interface InlineCodeNode extends UnistNode {
    type: "inlineCode"
    value: string
}

interface StrongNode extends UnistNode {
    type: "strong"
    children: UnistNode[]
}

// --- Constants ---

const FILE_PATH_REGEX = /^(?!\/)[\w\-./]+(?<!\/)$/

// --- Helper Components ---

const PreWithCopyButton = ({ children, ...preProps }: React.HTMLAttributes<HTMLPreElement>) => {
    const preRef = useRef<HTMLPreElement>(null)

    // Extract language label from child code element
    let language = ""
    if (Array.isArray(children) && children.length === 1 && React.isValidElement(children[0])) {
        const child = children[0] as React.ReactElement<{ className?: string }>
        const match = child.props?.className?.match(/language-(\w+)/)
        if (match) {
            language = match[1]
        }
    }

    const handleCopy = () => {
        if (preRef.current) {
            const codeElement = preRef.current.querySelector("code")
            const textToCopy = codeElement ? codeElement.textContent : preRef.current.textContent

            if (!textToCopy) {
                return
            }
            return textToCopy
        }
        return null
    }

    return (
        <WithCopyButton ariaLabel="Copy code" onCopy={handleCopy} position="top-right">
            <pre {...preProps} ref={preRef} className={cn(preProps.className, "relative")}>
                {language && (
                    <span className="absolute top-2.5 left-3 text-xs text-(--vscode-descriptionForeground) opacity-60 select-none pointer-events-none">
                        {language}
                    </span>
                )}
                {children}
            </pre>
        </WithCopyButton>
    )
}

/**
 * Component that renders inline code and checks if it's a valid file path asynchronously
 * Shows the code immediately, then adds the file link icon when confirmed
 */
const filePathCache = new Map<string, boolean>()


const InlineCodeWithFileCheck: React.FC<ComponentProps<"code"> & { [key: string]: unknown }> = (props) => {
    const [isFilePath, setIsFilePath] = useState<boolean | null>(null)
    const filePath = typeof props.children === "string" ? props.children : String(props.children || "")
    const isPotentialFilePath = props["data-potential-file-path"] === "true"

    useEffect(() => {
        if (!isPotentialFilePath) {
            return
        }

        if (filePathCache.has(filePath)) {
            setIsFilePath(filePathCache.get(filePath)!)
            return
        }

        let cancelled = false

        // Check file existence asynchronously
        FileServiceClient.ifFileExistsRelativePath(StringRequest.create({ value: filePath }))
            .then((exists) => {
                filePathCache.set(filePath, exists.value)
                if (!cancelled) {
                    setIsFilePath(exists.value)
                }
            })
            .catch((err) => {
                console.debug(`Failed to check file existence for ${filePath}:`, err)
                if (!cancelled) {
                    setIsFilePath(false)
                }
            })

        return () => {
            cancelled = true
        }
    }, [filePath, isPotentialFilePath])

    // If confirmed as a file path, render as clickable button
    if (isFilePath) {
        return (
            <Button
                className="p-0 ml-0.5 leading-none align-middle transition-opacity text-preformat gap-0.5 inline text-left"
                onClick={() => FileServiceClient.openFileRelativePath({ value: filePath })}
                size="icon"
                title={`Open ${filePath} in editor`}
                type="button"
                variant="icon">
                <code {...props} />
                <SquareArrowOutUpRightIcon className="inline align-middle ml-0.5" />
            </Button>
        )
    }

    // Otherwise render as regular code (shows immediately, before file check completes)
    const isInlineCode = !(props.className || "").includes("language-")
    return (
        <code
            {...props}
            className={cn(
                props.className,
                isInlineCode && "bg-(--vscode-textCodeBlock-background) px-1.5 py-0.5 rounded text-sm",
            )}
        />
    )
}

/**
 * A component for Act Mode text that contains a clickable toggle and keyboard shortcut hint.
 */
const ActModeHighlight: React.FC = () => {
    const { mode } = useSettingsStore()

    return (
        <button
            className={cn("text-link inline-flex items-center gap-1 p-0 border-none bg-transparent font-inherit cursor-pointer", {
                "hover:opacity-90": mode === "plan",
                "cursor-not-allowed opacity-60": mode !== "plan",
            })}
            onClick={() => {
                // Only toggle to Act mode if we're currently in Plan mode
                if (mode === "plan") {
                    StateServiceClient.togglePlanActModeProto(
                        TogglePlanActModeRequest.create({
                            mode: PlanActMode.ACT,
                        }),
                    )
                }
            }}
            title={mode === "plan" ? "Click to toggle to Act Mode" : "Already in Act Mode"}
            type="button">
            <div className="p-1 rounded-md bg-code flex items-center justify-end w-7 border border-input-border">
                <div className="rounded-full bg-link w-2 h-2" />
            </div>
            Act Mode (⌘⇧A)
        </button>
    )
}

// --- Remark Plugins ---

/**
 * Custom remark plugin that converts plain URLs in text into clickable links
 */
const remarkUrlToLink = () => {
    return (tree: Node) => {
        visit(tree, "text", (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
            const urlRegex = /https?:\/\/[^\s<>)"]+/g
            const matches = node.value.match(urlRegex)
            if (!matches || !parent || typeof index === "undefined") {
                return
            }

            const parts = node.value.split(urlRegex)
            const children: Node[] = []

            parts.forEach((part: string, i: number) => {
                if (part) {
                    children.push({ type: "text", value: part } as Node)
                }
                if (matches[i]) {
                    children.push({
                        type: "link",
                        url: matches[i],
                        children: [{ type: "text", value: matches[i] } as Node],
                    } as Node)
                }
            })

            parent.children.splice(index, 1, ...children)
        })
    }
}

/**
 * Custom remark plugin that highlights "to Act Mode" mentions and adds keyboard shortcut hint
 */
const remarkHighlightActMode = () => {
    return (tree: Node) => {
        visit(tree, "text", (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
            const actModeRegex = /\bto\s+Act\s+Mode\b(?!\s*\(⌘⇧A\))/i

            if (!node.value.match(actModeRegex) || !parent || typeof index === "undefined") {
                return
            }

            const parts = node.value.split(actModeRegex)
            const matches = node.value.match(actModeRegex)

            if (!matches || parts.length <= 1) {
                return
            }

            const children: Node[] = []

            parts.forEach((part: string, i: number) => {
                if (part) {
                    children.push({ type: "text", value: part } as Node)
                }

                if (matches[i]) {
                    const matchText = matches[i]
                    const toIndex = matchText.toLowerCase().indexOf("to")
                    const actModeIndex = matchText.toLowerCase().indexOf("act mode", toIndex + 2)

                    if (toIndex !== -1 && actModeIndex !== -1) {
                        const toPart = matchText.substring(toIndex, actModeIndex).trim()
                        children.push({ type: "text", value: `${toPart} ` } as Node)

                        const actModePart = matchText.substring(actModeIndex)
                        children.push({
                            type: "strong",
                            children: [{ type: "text", value: `${actModePart} (⌘⇧A)` } as Node],
                        } as Node)
                    } else {
                        children.push({ type: "text", value: `${matchText} ` } as Node)
                        children.push({
                            type: "strong",
                            children: [{ type: "text", value: "(⌘⇧A)" } as Node],
                        } as Node)
                    }
                }
            })

            parent.children.splice(index, 1, ...children)
        })
    }
}

/**
 * Custom remark plugin that highlights [+N] as green and [-N] as red
 */
const remarkColorStats = () => {
    return (tree: Node) => {
        visit(tree, "text", (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
            if (!parent || typeof index === "undefined") {
                return
            }

            const regex = /\[(\+\d+)\]|\[(-\d+)\]/g
            if (!regex.test(node.value)) {
                return
            }

            regex.lastIndex = 0
            const children: Node[] = []
            let lastIndex = 0
            let match = regex.exec(node.value)

            while (match !== null) {
                if (match.index > lastIndex) {
                    children.push({ type: "text", value: node.value.slice(lastIndex, match.index) } as Node)
                }

                if (match[1]) {
                    children.push({
                        type: "statPlus",
                        data: {
                            hName: "span",
                            hProperties: { className: "text-success font-bold" },
                        },
                        children: [{ type: "text", value: match[1] } as Node],
                    } as Node)
                } else if (match[2]) {
                    children.push({
                        type: "statMinus",
                        data: {
                            hName: "span",
                            hProperties: { className: "text-error font-bold" },
                        },
                        children: [{ type: "text", value: match[2] } as Node],
                    } as Node)
                }
                lastIndex = regex.lastIndex
                match = regex.exec(node.value)
            }

            if (lastIndex < node.value.length) {
                children.push({ type: "text", value: node.value.slice(lastIndex) } as Node)
            }

            parent.children.splice(index, 1, ...children)
        })
    }
}

/**
 * Custom remark plugin that prevents filenames with extensions from being parsed as bold text
 */
const remarkPreventBoldFilenames = () => {
    return (tree: Node) => {
        visit(tree, "strong", (node: StrongNode, index: number | undefined, parent: Parent | undefined) => {
            if (!parent || typeof index === "undefined" || index === parent.children.length - 1) {
                return
            }

            const nextNode = parent.children[index + 1] as UnistNode

            if (nextNode.type !== "text" || !nextNode.value?.match(/^\.[a-zA-Z0-9]+/)) {
                return
            }

            if (node.children?.length !== 1) {
                return
            }

            const strongContent = node.children[0].value
            if (!strongContent || typeof strongContent !== "string") {
                return
            }

            if (!strongContent.match(/^[a-zA-Z0-9_-]+$/)) {
                return
            }

            const newNode = {
                type: "text",
                value: `__${strongContent}__${nextNode.value}`,
            }

            parent.children.splice(index, 2, newNode as Node)
        })
    }
}

/**
 * Custom remark plugin that marks potential file paths in inline code blocks
 */
const remarkMarkPotentialFilePaths = () => {
    return (tree: Node) => {
        visit(tree, "inlineCode", (node: InlineCodeNode) => {
            if (FILE_PATH_REGEX.test(node.value) && !node.value.includes("\n")) {
                node.data = node.data || {}
                node.data.hProperties = node.data.hProperties || {}
                node.data.hProperties["data-potential-file-path"] = "true"
            }
        })
    }
}

/**
 * Custom remark plugin that adds default language to code blocks if missing
 */
const remarkAddDefaultLanguage = () => {
    return (tree: Node) => {
        visit(tree, "code", (node: CodeNode) => {
            if (!node.lang) {
                node.lang = "javascript"
            } else if (node.lang.includes(".")) {
                node.lang = node.lang.split(".").slice(-1)[0]
            }
        })
    }
}

// --- Logic ---

function parseMarkdownIntoBlocks(markdown: string): string[] {
    try {
        const tokens = marked.lexer(markdown)
        return tokens?.map((token) => token.raw)
    } catch {
        return [markdown]
    }
}

// biome-ignore lint/suspicious/noExplicitAny: react-markdown component props are complex
const MARKDOWN_COMPONENTS = {
    pre: ({ children, ...preProps }: any) => {
        if (Array.isArray(children) && children.length === 1 && React.isValidElement(children[0])) {
            const child = children[0] as React.ReactElement<{ className?: string }>
            if (child.props?.className?.includes("language-mermaid")) {
                return child
            }
        }
        return <PreWithCopyButton {...preProps}>{children}</PreWithCopyButton>
    },
    code: (props: any) => {
        const className = props.className || ""
        if (className.includes("language-mermaid")) {
            const codeText = String(props.children || "")
            return <MermaidBlock code={codeText} />
        }
        return <InlineCodeWithFileCheck {...props} />
    },
    strong: (props: any) => {
        const childrenText = React.Children.toArray(props.children)
            .map((child) => {
                if (typeof child === "string") {
                    return child
                }
                if (typeof child === "object" && child !== null && "props" in child && child.props.children) {
                    return String(child.props.children)
                }
                return ""
            })
            .join("")

        if (/^act mode\s*\(⌘⇧A\)$/i.test(childrenText)) {
            return <ActModeHighlight />
        }

        return <strong {...props} />
    },
    img: (props: any) => <UnsafeImage {...props} />,
    statPlus: (props: any) => <span className="text-success font-bold">{props.children}</span>,
    statMinus: (props: any) => <span className="text-error font-bold">{props.children}</span>,
} as any


const MemoizedMarkdownBlock = memo(
    ({ content }: { content: string }) => {
        return (
            <ReactMarkdown
                components={MARKDOWN_COMPONENTS}
                // biome-ignore lint/suspicious/noExplicitAny: rehypeHighlight types are sometimes incompatible with react-markdown
                rehypePlugins={[[rehypeHighlight as any, {} as Options]]}
                remarkPlugins={[
                    [remarkGfm, { singleTilde: false }],
                    remarkColorStats,
                    remarkPreventBoldFilenames,
                    remarkUrlToLink,
                    remarkHighlightActMode,
                    remarkMarkPotentialFilePaths,
                    remarkAddDefaultLanguage,
                ]}>
                {content}
            </ReactMarkdown>
        )
    },
    (prevProps, nextProps) => {
        if (prevProps.content !== nextProps.content) return false
        return true
    },
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

const MemoizedMarkdown = memo(({ content, id }: { content: string; id: string }) => {
    const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content])
    return blocks?.map((block, index) => {
        const key = `${id}-block_${index}`
        return <MemoizedMarkdownBlock content={block} key={key} />
    })
})

MemoizedMarkdown.displayName = "MemoizedMarkdown"

interface MarkdownBlockProps {
    markdown?: string
    compact?: boolean
    showCursor?: boolean
}

const MarkdownBlock = memo(({ markdown, compact, showCursor }: MarkdownBlockProps) => {
    return (
        <div className="inline-markdown-block">
            <span
                className={cn("inline [&>p]:mt-0", {
                    "inline-cursor-container": showCursor,
                    "[&>p]:m-0": compact,
                })}>
                {markdown ? <MemoizedMarkdown content={markdown} id="markdown-block" /> : markdown}
            </span>
        </div>
    )
})

export default MarkdownBlock
