import { DiracMessage } from "@shared/ExtensionMessage"
import { Check, X } from "lucide-react"
import CodeAccordian from "@/shared/ui/CodeAccordian"
import { DiffEditRow } from "../../DiffEditRow"
import MultiFileResultsDisplay from "../../MultiFileResultsDisplay"
import { BaseToolOutputProps } from "./shared"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"

const handlePathClick = (path: string) => {
	FileServiceClient.openFileRelativePath(StringRequest.create({ value: path })).catch((err: any) =>
		console.error("Failed to open file:", err)
	)
}

interface SymbolOutputProps extends BaseToolOutputProps {
	message: DiracMessage
}

export const SymbolOutput = ({ tool, unit, isExpanded, onToggleExpand, message }: SymbolOutputProps) => {
	switch (tool.tool) {
		case "readFile":
		case "read_file":
		case "readLineRange":
		case "read_line_range": {
			const result = tool.readFileResults?.find((r) => r.path === unit.path)
			const isComplete = !!tool.readFileResults
			return (
				<div className="mt-1">
					<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs mb-2 py-[9px] px-2.5">
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center gap-2 px-1">
								{isComplete ? (
									result?.status === "success" ? (
										<Check className="size-3.5 text-success shrink-0" />
									) : (
										<X className="size-3.5 text-error shrink-0" />
									)
								) : (
									<div className="size-3.5 border-2 border-description/30 border-t-description animate-spin rounded-full shrink-0" />
								)}
								<span className="font-mono text-xs truncate">
									{result?.label || (isComplete ? "Unknown status" : "Reading...")}
								</span>
							</div>
						</div>
					</div>
				</div>
			)
		}

		case "getFileSkeleton":
		case "get_file_skeleton": {
			const content = unit.content || tool.content!
			return (
				<div>
					{tool.skeletons ? (
						<MultiFileResultsDisplay
							files={tool.skeletons}
							isExpanded={true}
							messageTs={message.ts}
							onPathClick={(path: string) => handlePathClick(path)}
							onToggleExpand={() => {}}
							title="File Skeletons"
						/>
					) : (
						<CodeAccordian
							code={content}
							isExpanded={true}
							onPathClick={() => (unit.path || tool.paths?.[0]) && handlePathClick(unit.path || tool.paths![0])}
							onToggleExpand={() => {}}
							path={unit.path || tool.paths?.join(", ") || ""}
						/>
					)}
				</div>
			)
		}

		case "findSymbolReferences":
		case "find_symbol_references":
			return (
				<div>
					<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs mb-2 py-[9px] px-2.5">
						<div className="flex flex-col gap-1">
							<div className="flex flex-wrap gap-1 mt-1">
								<span className="text-xs opacity-70 mr-1">Symbols:</span>
								{tool.symbols?.map((symbol, i) => (
									<span
										className="px-1.5 py-0.5 bg-description/10 text-description rounded-[3px] text-[10px] font-mono border border-description/20"
										key={i}>
										{symbol}
									</span>
								))}
							</div>
						</div>
					</div>
					{tool.references ? (
						<MultiFileResultsDisplay
							files={tool.references}
							isExpanded={true}
							messageTs={message.ts}
							onPathClick={(path: string) => handlePathClick(path)}
							onToggleExpand={() => {}}
							title="Symbol References"
						/>
					) : (
						<CodeAccordian
							code={unit.content || tool.content!}
							isExpanded={true}
							onPathClick={() => (unit.path || tool.paths?.[0]) && handlePathClick(unit.path || tool.paths![0])}
							onToggleExpand={() => {}}
							path={unit.path || tool.paths?.join(", ") || ""}
						/>
					)}
				</div>
			)

		case "replaceSymbol":
		case "renameSymbol":
		case "rename_symbol": {
			const diff = unit.content || tool.diff
			return (
				<div className="flex flex-col gap-2">
					<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs mb-1 py-[9px] px-2.5">
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center gap-2">
								<span className="text-[10px] font-medium uppercase tracking-wider opacity-50">Rename</span>
								<div className="flex items-center gap-1.5 font-mono text-xs">
									<span className="px-1.5 py-0.5 bg-description/10 text-description rounded-[3px] border border-description/20">
										{tool.existing_symbol}
									</span>
									<span className="opacity-50">→</span>
									<span className="px-1.5 py-0.5 bg-success/10 text-success rounded-[3px] border border-success/20">
										{tool.new_symbol}
									</span>
								</div>
							</div>
							{tool.total_replacements !== undefined && (
								<div className="text-[10px] opacity-70">
									{tool.total_replacements} replacements in {tool.files_affected} files
								</div>
							)}
						</div>
					</div>
					{diff && (
						<div className="flex flex-col gap-1">
							<span className="text-[10px] font-medium uppercase tracking-wider opacity-50 ml-1">Diff</span>
							<DiffEditRow patch={diff} path={unit.path || tool.path || ""} />
						</div>
					)}
				</div>
			)
		}


		case "replace_symbol": {
			const diff = unit.content || tool.diff
			return (
				<div className="flex flex-col gap-2">
					{unit.content && !diff?.startsWith(" ") && !diff?.startsWith("-") && !diff?.startsWith("+") && (
						<div className="flex flex-col gap-1">
							<span className="text-[10px] font-medium uppercase tracking-wider opacity-50 ml-1">New Content</span>
							<CodeAccordian
								code={unit.content}
								isExpanded={true}
								onPathClick={() => (unit.path || tool.path) && handlePathClick(unit.path || tool.path!)}
								onToggleExpand={() => {}}
								path={unit.path || tool.path!}
							/>
						</div>
					)}
					{diff && (
						<div className="flex flex-col gap-1">
							<span className="text-[10px] font-medium uppercase tracking-wider opacity-50 ml-1">Diff</span>
							<DiffEditRow patch={diff} path={unit.path || tool.path!} />
						</div>
					)}
				</div>
			)
		}

		case "listCodeDefinitionNames":
		case "getFunction":
		case "get_function":
			return (
				<div className="mt-1">
					{tool.functionNames && tool.functionNames.length > 0 && (
						<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs mb-2 py-[9px] px-2.5">
							<div className="flex flex-col gap-1.5">
								<span className="text-[10px] font-medium uppercase tracking-wider opacity-50 ml-1 mb-1">
									Functions
								</span>
								{tool.functionNames.map((name, i) => {
									const isFound = tool.foundFunctionNames?.includes(name)
									const isComplete = !!tool.foundFunctionNames
									return (
										<div key={i} className="flex items-center gap-2 px-1">
											{isComplete ? (
												isFound ? (
													<Check className="size-3.5 text-success shrink-0" />
												) : (
													<X className="size-3.5 text-error shrink-0" />
												)
											) : (
												<div className="size-3.5 border-2 border-description/30 border-t-description animate-spin rounded-full shrink-0" />
											)}
											<span className="font-mono text-xs truncate">{name}</span>
										</div>
									)
								})}
							</div>
						</div>
					)}
				</div>
			)

		default:
			return null
	}
}
