/**
 * Characterization tests for ContextLoader (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 * Focus: context gathering (file context, mention parsing, workspace state), edge cases.
 */
import { setHostCapabilities } from "@hosts/host-capabilities"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { ContextLoader } from "../ContextLoader"
import { SUPPORTED_DEFAULT_COMMANDS } from "@core/slash-commands/commandRegistry"
import { ContextLoaderDependencies } from "../types/context-loader"

// Module proxies for stubbing direct imports
const mentionsModule = require("@core/mentions")
const slashCommandsModule = require("@core/slash-commands")
const ruleConditionalsModule = require("@core/context/instructions/user-instructions/rule-conditionals")
const skillsModule = require("../../context/instructions/user-instructions/skills")
const workflowsModule = require("../../context/instructions/user-instructions/workflows")
const ruleHelpersModule = require("../../context/instructions/user-instructions/rule-helpers")
const sourceAstModule = require("@services/source-ast/SourceAstService")
const symbolIndexModule = require("../../../services/symbol-index/SymbolIndexService")
const listFilesModule = require("@services/glob/list-files")
// Stub source modules — @core/workspace re-exports are getter-only
const workspaceResolverModule = require("@core/workspace/WorkspaceResolver")
const multiRootModule = require("@core/workspace/multi-root-utils")
const refreshToolRegistryModule = require("../tools/registry/refreshToolRegistry")
const toolRegistryModule = require("../tools/registry/ToolRegistry")

describe("ContextLoader (characterization)", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let originalMentions: any, originalSlash: any, originalExtractSymbol: any, originalSkills: any
	let originalWorkflows: any, originalEnsureDir: any, originalListFiles: any
	let originalResolveWorkspace: any, originalMultiRoot: any, originalRefreshToolRegistry: any, originalOutline: any

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `dirac-cl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
		// Save originals for module proxy stubbing
		originalMentions = mentionsModule.parseMentions
		originalSlash = slashCommandsModule.parseSlashCommands
		originalExtractSymbol = ruleConditionalsModule.extractSymbolLikeStrings
		originalSkills = skillsModule.getOrDiscoverSkills
		originalWorkflows = workflowsModule.refreshWorkflowToggles
		originalEnsureDir = ruleHelpersModule.ensureLocalDiracDirExists
		originalListFiles = listFilesModule.listFiles
		originalResolveWorkspace = workspaceResolverModule.resolveWorkspacePath
		originalMultiRoot = multiRootModule.isMultiRootEnabled
		originalRefreshToolRegistry = refreshToolRegistryModule.refreshToolRegistryForWorkspace
		originalOutline = sourceAstModule.SourceAstService.prototype.outline
	})

	afterEach(async () => {
		setHostCapabilities(undefined)
		// Restore module proxies
		mentionsModule.parseMentions = originalMentions
		slashCommandsModule.parseSlashCommands = originalSlash
		ruleConditionalsModule.extractSymbolLikeStrings = originalExtractSymbol
		skillsModule.getOrDiscoverSkills = originalSkills
		workflowsModule.refreshWorkflowToggles = originalWorkflows
		ruleHelpersModule.ensureLocalDiracDirExists = originalEnsureDir
		listFilesModule.listFiles = originalListFiles
		workspaceResolverModule.resolveWorkspacePath = originalResolveWorkspace
		multiRootModule.isMultiRootEnabled = originalMultiRoot
		refreshToolRegistryModule.refreshToolRegistryForWorkspace = originalRefreshToolRegistry
		sourceAstModule.SourceAstService.prototype.outline = originalOutline
		sandbox.restore()
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch { }
	})

	function makeDependencies(overrides: Partial<ContextLoaderDependencies> = {}): ContextLoaderDependencies {
		return {
			executionProfile: "standalone",
			ulid: "test-ulid",
			stateManager: {
				getGlobalSettingsKey: sandbox.stub().returns({}),
				getWorkspaceStateKey: sandbox.stub().returns({}),
			} as any,
			getRequestRuntime: () => ({
				workingConfiguration: {
					settings: { globalSkillsToggles: {}, globalWorkflowToggles: {}, yoloModeToggled: false },
					workspaceConfiguration: { localSkillsToggles: {}, workflowToggles: {} },
					executionOptions: { multiRootEnabled: false },
				},
			} as any),
			cwd: tempDir,
			urlContentFetcher: {} as any,
			fileContextTracker: {} as any,
			workspaceManager: undefined,
			diracIgnoreController: { validateAccess: () => true } as any,
			commandPermissionController: {} as any,
			taskState: { availableSkills: [] } as any,
			extensionPath: tempDir,
			sourceDir: tempDir,
			getCurrentProviderInfo: sandbox.stub().returns({} as any),
			getEnvironmentDetails: sandbox.stub().resolves("env-details"),
			postStateToWebview: sandbox.stub().resolves(),
			...overrides,
		}
	}

	function stubParseMentions(returnText: string) {
		mentionsModule.parseMentions = async () => returnText
	}

	function stubParseSlashCommands(result: any = { processedText: "processed", needsDiracrulesFileCheck: false }) {
		slashCommandsModule.parseSlashCommands = async () => result
	}

	function stubSkills(skills: any[] = []) {
		skillsModule.getOrDiscoverSkills = async () => skills
	}

	function stubWorkflows() {
		workflowsModule.refreshWorkflowToggles = async () => ({ localWorkflowToggles: {}, globalWorkflowToggles: {} })
	}

	function stubResolveWorkspacePassthrough() {
		// Resolve relative paths against tempDir
		workspaceResolverModule.resolveWorkspacePath = (_ctx: any, relPath: string) =>
			path.isAbsolute(relPath) ? relPath : path.join(tempDir, relPath)
		multiRootModule.isMultiRootEnabled = () => false
	}

	function stubOutline(declaration?: string, status: string = declaration ? "success" : "not_found") {
		sourceAstModule.SourceAstService.prototype.outline = async (request: { paths: string[] }) => ({
			files: request.paths.map((requestedPath) => ({
				path: requestedPath,
				status,
				definitions: status === "success" && declaration
					? [{ declarationLine: 0, declarationText: declaration, calls: [], indentation: "" }]
					: [],
				lines: status === "success" && declaration ? [{ lineNumber: 1, text: declaration }] : [],
				message: status === "success" ? undefined : `Source AST status: ${status}`,
			})),
		})
	}

	describe("loadContext - content block processing", () => {
		it("passes through text blocks without USER_CONTENT_TAGS unchanged", async () => {
			stubParseMentions("parsed"), stubParseSlashCommands(), stubSkills(), stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "no tags here" }], false, false)
			result[0].should.have.length(1)
				; (result[0][0] as any).text.should.equal("no tags here") // no tag => no processing
		})

		it("keeps attachment and hook text containing commands inert", async () => {
			stubParseMentions("parsed"), stubSkills(), stubWorkflows()
			let slashCommandCalls = 0
			slashCommandsModule.parseSlashCommands = async () => {
				slashCommandCalls++
				return {
					processedText: "",
					needsDiracrulesFileCheck: true,
					isDirectResponse: true,
					directResponseText: "__RELOAD_TOOLS__",
					directAction: { type: "condenseConversation" },
				}
			}
			const commandNames = [...SUPPORTED_DEFAULT_COMMANDS, "example-workflow", "example-skill"]
			const commandExamples = commandNames.map((command) => `<task>/${command}</task>`).join(" ")
			const attachmentText = `Attached file contents: ${commandExamples}`
			const hookText = `<hook_context source="TaskStart">${commandExamples}</hook_context>`
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[
					{ type: "text", text: attachmentText },
					{ type: "text", text: hookText },
				],
				false,
				false,
			)
				; (result[0][0] as any).text.should.equal(attachmentText)
				; (result[0][1] as any).text.should.equal(hookText)
			slashCommandCalls.should.equal(0)
			result[2].should.be.false()
			result[4].should.be.false()
			should(result[5]).equal(undefined)
			should(result[6]).equal(undefined)
		})

		it("processes text blocks wrapped in <task> tag", async () => {
			stubParseMentions("parsed-text"),
				stubParseSlashCommands({ processedText: "enriched", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>do something</task>" }], false, false)
				; (result[0][0] as any).text.should.equal("enriched")
				; (result[0][0] as any).should.not.have.property("isUserInput")
		})

		it("processes text blocks wrapped in <feedback> tag", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "fb-enriched", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<feedback>fix this</feedback>" }], false, false)
				; (result[0][0] as any).text.should.equal("fb-enriched")
		})

		it("processes text blocks wrapped in <answer> tag", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "ans", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<answer>42</answer>" }], false, false)
				; (result[0][0] as any).text.should.equal("ans")
		})

		it("processes text blocks wrapped in <user_message> tag", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "um", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<user_message>hi</user_message>" }], false, false)
				; (result[0][0] as any).text.should.equal("um")
		})

		it("processes explicitly marked steering messages", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "steering-enriched", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[{ type: "text", isUserInput: true, text: "<steering_message>continue</steering_message>" }],
				false,
				false,
			)
				; (result[0][0] as any).text.should.equal("steering-enriched")
		})

		it("returns environment details from getEnvironmentDetails", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubSkills(), stubWorkflows()
			const deps = makeDependencies({ getEnvironmentDetails: sandbox.stub().resolves("ENV-DETAILS") as any })
			const loader = new ContextLoader(deps)
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], true, false)
			result[1].should.equal("ENV-DETAILS")
		})

		it("returns availableSkills and sets them on taskState", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubWorkflows()
			const fakeSkill = { name: "skill1", source: "global", path: "/p" }
			stubSkills([fakeSkill])
			const taskState: any = { availableSkills: [] }
			const deps = makeDependencies({ taskState })
			const loader = new ContextLoader(deps)
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			result[3].should.have.length(1)
			taskState.availableSkills.should.have.length(1)
		})

		it("removes viewer-only skills before headless slash-command processing even from cached metadata", async () => {
			setHostCapabilities({})
			stubParseMentions("p"), stubParseSlashCommands(), stubWorkflows()
			stubSkills(skillsModule.BUILTIN_SKILLS)
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>/architecture-board</task>" }])
			result[3].some((skill) => skill.name === "architecture-board").should.equal(false)
		})

		for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
			it(`filters foreground-only skills before slash-command activation for ${executionProfile}`, async () => {
				setHostCapabilities({ architectureViewer: { prepare: async () => { }, createPanel: async () => { throw new Error("not used") } } })
				stubParseMentions("p"), stubParseSlashCommands(), stubWorkflows()
				stubSkills(skillsModule.BUILTIN_SKILLS)
				const loader = new ContextLoader(makeDependencies({ executionProfile }))
				const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }])
				result[3].some((skill) => skill.name === "architecture-board").should.equal(executionProfile !== "tasklet")
			})
		}

		it("filters out skills disabled by global toggles", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubWorkflows()
			const skills = [
				{ name: "on", source: "global", path: "/on" },
				{ name: "off", source: "global", path: "/off" },
			]
			stubSkills(skills)
			const sm: any = {
				getGlobalSettingsKey: sandbox.stub().returns({ "/off": false }),
				getWorkspaceStateKey: sandbox.stub().returns({}),
			}
			const deps = makeDependencies({ stateManager: sm, getRequestRuntime: () => ({ workingConfiguration: { settings: { globalSkillsToggles: { "/off": false }, globalWorkflowToggles: {}, yoloModeToggled: false }, workspaceConfiguration: { localSkillsToggles: {}, workflowToggles: {} } } } as any) })
			const loader = new ContextLoader(deps)
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			result[3].should.have.length(1)
			result[3][0].name.should.equal("on")
		})

		it("filters out skills disabled by local toggles", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubWorkflows()
			const skills = [
				{ name: "on", source: "local", path: "/on" },
				{ name: "off", source: "local", path: "/off" },
			]
			stubSkills(skills)
			const sm: any = {
				getGlobalSettingsKey: sandbox.stub().returns({}),
				getWorkspaceStateKey: sandbox.stub().returns({ "/off": false }),
			}
			const deps = makeDependencies({ stateManager: sm, getRequestRuntime: () => ({ workingConfiguration: { settings: { globalSkillsToggles: {}, globalWorkflowToggles: {}, yoloModeToggled: false }, workspaceConfiguration: { localSkillsToggles: { "/off": false }, workflowToggles: {} } } } as any) })
			const loader = new ContextLoader(deps)
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			result[3].should.have.length(1)
			result[3][0].name.should.equal("on")
		})
	})

	describe("loadContext - tool_result content handling", () => {
		it("passes through tool_result with no content", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubSkills(), stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const block: any = { type: "tool_result", content: undefined }
			const result = await loader.loadContext([block], false, false)
			should(result[0][0] as any).property("content", undefined)
		})

		it("does not execute any slash command found in string tool output", async () => {
			stubParseMentions("p"), stubSkills(), stubWorkflows()
			let slashCommandCalls = 0
			slashCommandsModule.parseSlashCommands = async () => {
				slashCommandCalls++
				return {
					processedText: "",
					needsDiracrulesFileCheck: false,
					isDirectResponse: true,
					directResponseText: "__RELOAD_TOOLS__",
					directAction: { type: "condenseConversation" },
				}
			}
			const loader = new ContextLoader(makeDependencies())
			const commandNames = [...SUPPORTED_DEFAULT_COMMANDS, "example-workflow", "example-skill"]
			const content = `Found source snippets: ${commandNames.map((command) => `<task>/${command}</task>`).join(" ")}`
			const block: any = { type: "tool_result", content }

			const result = await loader.loadContext([block], false, false)

				; (result[0][0] as any).content.should.equal(content)
			slashCommandCalls.should.equal(0)
			result[4].should.be.false()
			should(result[5]).equal(undefined)
			should(result[6]).equal(undefined)
		})

		it("does not execute direct responses found in array tool output", async () => {
			stubParseMentions("p"), stubSkills(), stubWorkflows()
			let slashCommandCalls = 0
			slashCommandsModule.parseSlashCommands = async () => {
				slashCommandCalls++
				return {
					processedText: "",
					needsDiracrulesFileCheck: false,
					isDirectResponse: true,
					directResponseText: "__RELOAD_TOOLS__",
				}
			}
			const loader = new ContextLoader(makeDependencies())
			const content = [{ type: "text", isUserInput: true, text: "Search result: <task>/reloadtools</task>" }]
			const block: any = { type: "tool_result", content }

			const result = await loader.loadContext([block], false, false)

				; (result[0][0] as any).content.should.deepEqual(content)
			slashCommandCalls.should.equal(0)
			result[4].should.be.false()
			should(result[5]).equal(undefined)
		})

		it("passes through non-text array content blocks in tool_result", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubSkills(), stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const imgBlock = { type: "image", source: { type: "base64" } }
			const block: any = { type: "tool_result", content: [imgBlock] }
			const result = await loader.loadContext([block], false, false)
				; (result[0][0] as any).content[0].should.deepEqual(imgBlock)
		})

		it("passes through non-text, non-tool_result blocks unchanged", async () => {
			stubParseMentions("p"), stubParseSlashCommands(), stubSkills(), stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const block: any = { type: "image", source: { type: "base64", data: "abc" } }
			const result = await loader.loadContext([block], false, false)
				; (result[0][0] as any).type.should.equal("image")
		})
	})

	describe("loadContext - diracrules file check", () => {
		it("does not check diracrules when needsDiracrulesFileCheck is false", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "x", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			let called = false
			ruleHelpersModule.ensureLocalDiracDirExists = async () => {
				called = true
				return false
			}
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			called.should.be.false()
			result[2].should.be.false()
		})

		it("checks diracrules when needsDiracrulesFileCheck is true", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "x", needsDiracrulesFileCheck: true }),
				stubSkills(),
				stubWorkflows()
			ruleHelpersModule.ensureLocalDiracDirExists = async () => true
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			result[2].should.be.true()
		})
	})

	describe("loadContext - direct response (/reloadtools)", () => {
		it("returns isDirectResponse and directResponseText for /reloadtools", async () => {
			stubParseMentions("p")
			stubParseSlashCommands({
				processedText: "",
				needsDiracrulesFileCheck: false,
				isDirectResponse: true,
				directResponseText: "__RELOAD_TOOLS__",
			})
			stubSkills(), stubWorkflows()
			refreshToolRegistryModule.refreshToolRegistryForWorkspace = async () => { }
			// Stub ToolRegistry.getInstance
			const origGetInstance = toolRegistryModule.ToolRegistry.getInstance
			toolRegistryModule.ToolRegistry.getInstance = () =>
				({
					getAllTools: () => [
						{ id: "t1", source: "builtin" },
						{ id: "t2", source: "user" },
					],
					getEnabledTools: () => [{ id: "t1", source: "builtin" }],
				}) as any
			try {
				const loader = new ContextLoader(makeDependencies())
				const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>/reloadtools</task>" }], false, false)
				result[4].should.be.true() // isDirectResponse
					; (result[5] as any).should.be.a.String()
					; (result[5] as string).should.match(/Tools reloaded/)
			} finally {
				toolRegistryModule.ToolRegistry.getInstance = origGetInstance
			}
		})
	})

	describe("loadContext - includePathContext gating", () => {
		it("skips path/symbol context extraction on subsequent turns (includeFileDetails=true means includePathContext=true on first turn only)", async () => {
			// includePathContext = includeFileDetails. When false, extractContext/getPathContext/getSymbolContext are skipped.
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "JUST-TEXT", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			let extractCalled = false
			ruleConditionalsModule.extractSymbolLikeStrings = () => {
				extractCalled = true
				return []
			}
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], false, false)
			extractCalled.should.be.false() // includeFileDetails=false => includePathContext=false => no extraction
				; (result[0][0] as any).text.should.equal("JUST-TEXT")
		})

		it("runs path/symbol context extraction when includeFileDetails=true", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "WITH-CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>x</task>" }], true, false)
				; (result[0][0] as any).text.should.equal("WITH-CTX")
		})
	})

	describe("extractContext - path & symbol detection (via loadContext with includeFileDetails=true)", () => {
		it("detects existing file paths and enriches with skeleton", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			// Create a real file so fs.stat says isFile
			const fileName = "realfile.ts"
			await fs.writeFile(path.join(tempDir, fileName), "export const x = 1")
			stubOutline("SKELETON-CONTENT")
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>see ${fileName} here</task>` }], true, false)
				; (result[0][0] as any).text.should.containEql("SKELETON-CONTENT")
				; (result[0][0] as any).text.should.containEql("file_skeleton")
		})

		it("skips skeleton when source AST reports an unsupported file", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const fileName = "data.json"
			await fs.writeFile(path.join(tempDir, fileName), "{}")
			stubOutline(undefined, "unsupported")
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>see ${fileName} here</task>` }], true, false)
				; (result[0][0] as any).text.should.not.containEql("file_skeleton")
		})

		it("detects directory paths and enriches with directory_list", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const dirName = "subdir"
			await fs.mkdir(path.join(tempDir, dirName))
			listFilesModule.listFiles = async () => [[{ name: "a.ts", path: "a.ts" } as any], false]
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			// Directory must end with / to match path regex
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>see ${dirName}/ here</task>` }], true, false)
				; (result[0][0] as any).text.should.containEql("directory_list")
				; (result[0][0] as any).text.should.containEql(dirName)
		})

		it("limits directory lists to 3 directories", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const dirs = ["d1", "d2", "d3", "d4"]
			for (const d of dirs) await fs.mkdir(path.join(tempDir, d))
			listFilesModule.listFiles = async () => [[], false]
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[{ type: "text", isUserInput: true, text: `<task>see ${dirs.map((d) => d + "/").join(" ")} here</task>` }],
				true,
				false,
			)
			const text = (result[0][0] as any).text as string
			const count = (text.match(/<directory_list/g) || []).length
			count.should.equal(3) // capped at 3
		})

		it("does not detect paths inside code fences", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			let symbolCalled = false
			ruleConditionalsModule.extractSymbolLikeStrings = (t: string) => {
				symbolCalled = true
				return []
			}
			const fileName = "fenced.ts"
			await fs.writeFile(path.join(tempDir, fileName), "x")
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[{ type: "text", isUserInput: true, text: `<task>\`\`\`\n${fileName}\n\`\`\`\nhere</task>` }],
				true,
				false,
			)
				; (result[0][0] as any).text.should.not.containEql("file_skeleton") // fenced => not detected
		})

		it("does not detect URLs as paths", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[{ type: "text", isUserInput: true, text: `<task>see https://example.com/foo.ts here</task>` }],
				true,
				false,
			)
				; (result[0][0] as any).text.should.not.containEql("file_skeleton")
		})

		it("does not detect @-mentions as paths", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const fileName = "mentioned.ts"
			await fs.writeFile(path.join(tempDir, fileName), "x")
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>@${fileName} here</task>` }], true, false)
				; (result[0][0] as any).text.should.not.containEql("file_skeleton")
		})

		it("does not detect slash commands as paths", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			stubOutline()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>/compact here</task>` }], true, false)
				; (result[0][0] as any).text.should.not.containEql("file_skeleton")
		})

		it("trims trailing punctuation from detected paths", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const fileName = "trail.ts"
			await fs.writeFile(path.join(tempDir, fileName), "x")
			stubOutline("SKEL")
			const loader = new ContextLoader(makeDependencies())
			// Trailing comma should be trimmed, file should still be detected
			const result = await loader.loadContext([{ type: "text", isUserInput: true, text: `<task>see ${fileName}, please</task>` }], true, false)
				; (result[0][0] as any).text.should.containEql("file_skeleton")
		})

		it("deduplicates repeated file paths", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => []
			const fileName = "dup.ts"
			await fs.writeFile(path.join(tempDir, fileName), "x")
			stubOutline("SKEL")
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[{ type: "text", isUserInput: true, text: `<task>${fileName} and ${fileName} here</task>` }],
				true,
				false,
			)
			const text = (result[0][0] as any).text as string
			const count = (text.match(/<file_skeleton/g) || []).length
			count.should.equal(1) // deduped
		})
	})

	describe("extractContext - symbol enrichment", () => {
		it("enriches context with symbol definitions when symbols detected", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => ["myFunc"]
			stubOutline()
			// Stub SymbolIndexService.getInstance
			const origGetInstance = symbolIndexModule.SymbolIndexService.getInstance
			symbolIndexModule.SymbolIndexService.getInstance = () =>
				({
					getProjectRoot: () => tempDir,
					getDefinitions: () => [{ path: path.join(tempDir, "s.ts"), startLine: 0, type: "function" }],
					getReferences: () => [],
				}) as any
			await fs.writeFile(path.join(tempDir, "s.ts"), "export function myFunc() {}")
			try {
				const loader = new ContextLoader(makeDependencies())
				const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>use myFunc</task>" }], true, false)
				const text = (result[0][0] as any).text as string
				text.should.containEql("symbol_context")
				text.should.containEql("myFunc")
			} finally {
				symbolIndexModule.SymbolIndexService.getInstance = origGetInstance
			}
		})

		it("skips symbol enrichment when more than MAX_AUTO_SYMBOL_MATCHES (3) symbols detected", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => ["a", "b", "c", "d"] // 4 > 3
			stubOutline()
			const origGetInstance = symbolIndexModule.SymbolIndexService.getInstance
			let defsCalled = false
			symbolIndexModule.SymbolIndexService.getInstance = () =>
				({
					getProjectRoot: () => tempDir,
					getDefinitions: () => {
						defsCalled = true
						return []
					},
					getReferences: () => [],
				}) as any
			try {
				const loader = new ContextLoader(makeDependencies())
				const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>a b c d</task>" }], true, false)
				defsCalled.should.be.false()
					; (result[0][0] as any).text.should.not.containEql("symbol_context")
			} finally {
				symbolIndexModule.SymbolIndexService.getInstance = origGetInstance
			}
		})

		it("skips lines that are too long (>200 bytes)", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "CTX", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			stubResolveWorkspacePassthrough()
			ruleConditionalsModule.extractSymbolLikeStrings = () => ["big"]
			stubOutline()
			const longLine = "x".repeat(250)
			await fs.writeFile(path.join(tempDir, "big.ts"), longLine)
			const origGetInstance = symbolIndexModule.SymbolIndexService.getInstance
			symbolIndexModule.SymbolIndexService.getInstance = () =>
				({
					getProjectRoot: () => tempDir,
					getDefinitions: () => [{ path: path.join(tempDir, "big.ts"), startLine: 0, type: "function" }],
					getReferences: () => [],
				}) as any
			try {
				const loader = new ContextLoader(makeDependencies())
				const result = await loader.loadContext([{ type: "text", isUserInput: true, text: "<task>big</task>" }], true, false)
				const text = (result[0][0] as any).text as string
				text.should.containEql("line too long, skipped")
			} finally {
				symbolIndexModule.SymbolIndexService.getInstance = origGetInstance
			}
		})
	})

	describe("loadContext - multiple content blocks", () => {
		it("processes multiple text blocks in parallel", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "E", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const result = await loader.loadContext(
				[
					{ type: "text", isUserInput: true, text: "<task>one</task>" },
					{ type: "text", isUserInput: true, text: "<task>two</task>" },
				],
				false,
				false,
			)
				; (result[0][0] as any).text.should.equal("E")
				; (result[0][1] as any).text.should.equal("E")
		})

		it("collects direct actions from every user block in input order", async () => {
			mentionsModule.parseMentions = async (text: string) => text
			slashCommandsModule.parseSlashCommands = async (text: string) => {
				if (text.includes("one")) {
					await new Promise((resolve) => setTimeout(resolve, 10))
					return {
						processedText: "first",
						needsDiracrulesFileCheck: false,
						directAction: { type: "activateSkill", skillId: "first-skill" },
					}
				}
				return {
					processedText: "second",
					needsDiracrulesFileCheck: false,
					directAction: { type: "activateSkill", skillId: "second-skill" },
				}
			}
			stubSkills(), stubWorkflows()
			const loader = new ContextLoader(makeDependencies())

			const result = await loader.loadContext(
				[
					{ type: "text", isUserInput: true, text: "<task>one</task>" },
					{ type: "text", isUserInput: true, text: "<task>two</task>" },
				],
				false,
				false,
			)

			result[6]!.should.deepEqual([
				{ type: "activateSkill", skillId: "first-skill" },
				{ type: "activateSkill", skillId: "second-skill" },
			])
		})

		it("processes user text while preserving tool results", async () => {
			stubParseMentions("p"),
				stubParseSlashCommands({ processedText: "E", needsDiracrulesFileCheck: false }),
				stubSkills(),
				stubWorkflows()
			const loader = new ContextLoader(makeDependencies())
			const toolOutput = "plain <task>/compact</task>"
			const result = await loader.loadContext(
				[
					{ type: "text", isUserInput: true, text: "<task>one</task>" } as any,
					{ type: "tool_result", content: toolOutput } as any,
				],
				false,
				false,
			)
				; (result[0][0] as any).text.should.equal("E")
				; (result[0][1] as any).content.should.equal(toolOutput)
		})
	})
})
