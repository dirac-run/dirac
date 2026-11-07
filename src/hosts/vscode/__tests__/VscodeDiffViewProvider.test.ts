import * as assert from "assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import type * as vscode from "vscode"
import { URI } from "vscode-uri"
import { Position, Range } from "@/test/vscode-mock"
import { expectLoggerErrors } from "@/test/loggerGuard"

class TabInputText {
	constructor(readonly uri: URI) {}
}
class TabInputTextDiff {
	constructor(
		readonly original: URI,
		readonly modified: URI,
	) {}
}
class TabInputNotebook {
	constructor(readonly uri: URI) {}
}
class TabInputNotebookDiff extends TabInputTextDiff {}

function event<T>() {
	const listeners = new Set<(value: T) => void>()
	return {
		listeners,
		subscribe: (listener: (value: T) => void) => {
			listeners.add(listener)
			return { dispose: () => listeners.delete(listener) }
		},
		fire: (value: T) => {
			for (const listener of listeners) listener(value)
		},
	}
}

function createHost() {
	const active = event<vscode.TextEditor | undefined>()
	const visible = event<readonly vscode.TextEditor[]>()
	const changed = event<{ document: vscode.TextDocument }>()
	const tabs: Array<{ input: unknown; label: string; isDirty: boolean }> = []
	const group = { tabs, viewColumn: 1, activeTab: undefined as (typeof tabs)[number] | undefined }
	const editors = new Map<string, vscode.TextEditor>()
	const decorations: Array<{ dispose: sinon.SinonSpy }> = []
	const watchers: Array<{ dispose: sinon.SinonSpy; onDidChange: sinon.SinonStub }> = []
	const contexts = new Map<string, boolean>()
	const tempFiles = new Map<string, Uint8Array>()
	const window = {
		activeTextEditor: undefined as vscode.TextEditor | undefined,
		visibleTextEditors: [] as vscode.TextEditor[],
		onDidChangeActiveTextEditor: active.subscribe,
		onDidChangeVisibleTextEditors: visible.subscribe,
		createTextEditorDecorationType: () => {
			const decoration = { dispose: sinon.spy() }
			decorations.push(decoration)
			return decoration
		},
		showErrorMessage: sinon.stub(),
		showTextDocument: sinon.stub(),
		tabGroups: {
			all: [group],
			close: sinon.spy(async (tab: (typeof tabs)[number]) => {
				tabs.splice(tabs.indexOf(tab), 1)
				return true
			}),
		},
	}
	function addEditor(path: string, text: string, uri = URI.file(path)) {
		let content = text
		const document = {
			uri,
			isDirty: true,
			get lineCount() {
				return content.split("\n").length
			},
			getText: () => content,
			save: sinon.spy(async () => true),
			lineAt: (line: number) => ({ range: new Range(line, 0, line, content.split("\n")[line]?.length ?? 0) }),
		}
		const editor = {
			document,
			viewColumn: 1,
			setDecorations: sinon.spy(),
			revealRange: sinon.spy(),
		} as unknown as vscode.TextEditor
		editors.set(path, editor)
		return {
			editor,
			save: document.save,
			setText: (text: string) => {
				content = text
			},
		}
	}
	class WorkspaceEdit {
		changes: Array<{ uri: URI; range: Range; text: string }> = []
		replace(uri: URI, range: Range, text: string) {
			this.changes.push({ uri, range, text })
		}
	}
	const contents = new Map<string, ReturnType<typeof addEditor>>()
	const host = {
		"@noCallThru": true,
		Uri: URI,
		Position,
		Range,
		Selection: Range,
		WorkspaceEdit,
		TabInputText,
		TabInputNotebook,
		TabInputTextDiff,
		TabInputNotebookDiff,
		RelativePattern: class {
			constructor(
				readonly base: string,
				readonly pattern: string,
			) {}
		},
		window,
		extensions: { getExtension: () => ({ isActive: true }) },
		workspace: {
			get textDocuments() {
				return [...editors.values()].map((editor) => editor.document)
			},
			onDidChangeTextDocument: changed.subscribe,
			applyEdit: async (edit: WorkspaceEdit) => {
				for (const change of edit.changes) {
					const target = contents.get(change.uri.fsPath)!
					const lines = target.editor.document.getText().split("\n")
					assert.strictEqual(change.range.start.line, 0)
					assert.ok(change.range.end.line >= lines.length)
					target.setText(change.text)
				}
				return true
			},
			createFileSystemWatcher: () => {
				const watcher = { dispose: sinon.spy(), onDidChange: sinon.stub() }
				watchers.push(watcher)
				return watcher
			},
			fs: {
				readFile: async (uri: URI): Promise<Uint8Array> => tempFiles.get(uri.toString())!,
				writeFile: async (uri: URI, content: Uint8Array) => {
					tempFiles.set(uri.toString(), content)
				},
				delete: sinon.spy(async (uri: URI) => {
					tempFiles.delete(uri.toString())
				}),
			},
		},
		commands: {
			executeCommand: sinon.spy(async (command: string, ...args: any[]) => {
				if (command === "setContext") contexts.set(args[0], args[1])
				if (command === "vscode.changes") tabs.push({ label: args[0], input: {}, isDirty: false })
				if (command !== "vscode.diff") return
				const [original, modified, label] = args as [URI, URI, string]
				if (modified.fsPath.includes("dirac-modified-")) {
					tabs.push({ label, input: new TabInputNotebookDiff(original, modified), isDirty: false })
					return
				}
				const tab = { label, input: new TabInputTextDiff(original, modified), isDirty: false }
				tabs.push(tab)
				group.activeTab = tab
				const editor = editors.get(modified.fsPath)!
				window.visibleTextEditors = [editor]
				// preserveFocus deliberately leaves another task's editor active.
				visible.fire(window.visibleTextEditors)
			}),
		},
	}
	return {
		host,
		tabs,
		contents,
		decorations,
		watchers,
		contexts,
		tempFiles,
		active,
		visible,
		changed,
		addFile(path: string, text: string) {
			const file = addEditor(path, text)
			contents.set(path, file)
			return file
		},
		preview(index: number) {
			const call = host.commands.executeCommand.getCalls().filter((call) => call.args[0] === "vscode.changes")[index]
			const uri = call.args[2][0][2] as URI
			return addEditor(uri.fsPath, Buffer.from(uri.query, "base64").toString("utf8"), uri)
		},
		focus(editor: vscode.TextEditor) {
			window.activeTextEditor = editor
			active.fire(editor)
		},
	}
}

function loadProvider(host: ReturnType<typeof createHost>["host"]) {
	const load = (name: string, dependencies: Record<string, unknown> = {}) =>
		proxyquire(`../${name}`, {
			vscode: host,
			...Object.fromEntries(
				Object.entries(dependencies).map(([key, value]) => [key, { ...(value as object), "@noCallThru": true }]),
			),
		})
	const tabs = load("TabManager")
	const decorations = load("DecorationControllerManager", { "./DecorationController": load("DecorationController") })
	const notebook = load("NotebookDiffManager", { "./NotebookDiffView": load("NotebookDiffView") })
	const review = load("ReviewContextManager", { "./TabManager": tabs })
	const { VscodeDiffViewProvider } = load("VscodeDiffViewProvider", {
		"@/hosts/vscode/TabManager": tabs,
		"@/hosts/vscode/DecorationControllerManager": decorations,
		"@/hosts/vscode/NotebookDiffManager": notebook,
		"@/hosts/vscode/ReviewContextManager": review,
		"@/hosts/vscode/StreamingTextUpdater": load("StreamingTextUpdater"),
		"@/hosts/vscode/DocumentOperationManager": load("DocumentOperationManager"),
	}) as typeof import("../VscodeDiffViewProvider")
	return class TestProvider extends VscodeDiffViewProvider {
		async initialize(path: string, original = "original") {
			this.absolutePath = path
			this.relPath = path
			this.editType = "modify"
			this.isEditing = true
			// Exercise the real reset implementation without filesystem setup.
			this.fileOpManager = { originalContent: original, reset() {} } as typeof this.fileOpManager
			await this.openDiffEditor()
		}
		text() {
			return this.getDocumentText()
		}
		save() {
			return this.saveDocument()
		}
		specialize() {
			return this.switchToSpecializedEditor()
		}
		closeViews() {
			return this.closeAllDiffViews()
		}
	}
}

describe("VscodeDiffViewProvider owned resources", function () {
	this.timeout(10_000)
	let host: ReturnType<typeof createHost>
	let Provider: ReturnType<typeof loadProvider>
	let providers: InstanceType<ReturnType<typeof loadProvider>>[]

	beforeEach(() => {
		host = createHost()
		Provider = loadProvider(host.host)
		providers = [new Provider(), new Provider(), new Provider()]
	})
	afterEach(async () => {
		await Promise.all(providers.map((provider) => provider.reset()))
		sinon.restore()
	})

	it("reads the current unsaved buffer without saving or focusing it", async () => {
		const target = host.addFile("/dirty.ts", "unsaved changes")
		const other = host.addFile("/other.ts", "other content")
		host.focus(other.editor)

		assert.strictEqual(await providers[0].readText("/dirty.ts"), "unsaved changes")
		target.setText("")
		assert.strictEqual(await providers[0].readText("/dirty.ts"), "")
		sinon.assert.notCalled(target.save)
		sinon.assert.notCalled(other.save)
		assert.strictEqual(host.host.window.activeTextEditor, other.editor)
	})

	it("uses the configured text transport when the document is not open", async () => {
		const readText = sinon.stub().resolves({ content: "disk content", encoding: "utf8" })
		const provider = new Provider({ readText, writeText: sinon.stub() })
		providers.push(provider)

		assert.strictEqual(await provider.readText("/closed.ts"), "disk content")
		sinon.assert.calledOnceWithExactly(readText, "/closed.ts")
	})

	it("reads and saves the owning editor while another provider or no editor has focus", async () => {
		const files = ["/a.ts", "/b.ts", "/c.ts"].map((path) => host.addFile(path, path))
		await Promise.all(providers.map((provider, index) => provider.initialize(files[index].editor.document.uri.fsPath)))
		host.focus(files[2].editor)
		assert.strictEqual(await providers[0].text(), "/a.ts")
		assert.strictEqual(await providers[0].save(), true)
		assert.strictEqual(files[0].save.callCount, 1)
		assert.strictEqual(files[2].save.callCount, 0)
		host.host.window.activeTextEditor = undefined
		assert.strictEqual(await providers[1].text(), "/b.ts")
		assert.strictEqual(await providers[1].save(), true)
		assert.strictEqual(host.visible.listeners.size, 0, "open listeners are released")
	})

	it("resets one distinct-file provider while preserving modified content and sibling views", async () => {
		const files = ["/a.ts", "/b.ts", "/c.ts"].map((path) => host.addFile(path, `edited ${path}`))
		await Promise.all(providers.map((provider, index) => provider.initialize(files[index].editor.document.uri.fsPath)))
		host.focus(files[2].editor)
		const siblings = host.tabs.slice(1)
		await providers[0].reset()
		assert.strictEqual(files[0].editor.document.getText(), "edited /a.ts")
		assert.strictEqual(files[0].save.callCount, 0)
		assert.deepStrictEqual(host.tabs, siblings)
		assert.deepStrictEqual(await Promise.all(providers.map((provider) => provider.text())), [
			undefined,
			"edited /b.ts",
			"edited /c.ts",
		])
		assert.deepStrictEqual(
			host.decorations.map((decoration) => decoration.dispose.callCount),
			[1, 1, 0, 0, 0, 0],
		)
		assert.strictEqual(files[1].save.callCount, 0)
		assert.strictEqual(files[2].save.callCount, 0)
		await providers[0].reset()
		assert.deepStrictEqual(host.tabs, siblings, "repeat cleanup is idempotent")
	})

	for (const activeKind of ["ordinary", "sibling"] as const) {
		it(`finds the visible owned diff in another group instead of an inactive copy beside an active ${activeKind} tab`, async () => {
			const { TabManager } = proxyquire("../TabManager", { vscode: host.host }) as typeof import("../TabManager")
			const manager = new TabManager()
			const sibling = new TabManager()
			const file = host.addFile("/shared.ts", "shared")
			const uri = file.editor.document.uri as URI
			const original = manager.originalUri("/shared.ts", "original") as URI
			const owned = { input: new TabInputTextDiff(original, uri), label: "owned", isDirty: false }
			const active = {
				input:
					activeKind === "ordinary"
						? new TabInputText(uri)
						: new TabInputTextDiff(sibling.originalUri("/shared.ts", "original") as URI, uri),
				label: activeKind,
				isDirty: false,
			}
			host.tabs.push(owned, active)
			host.host.window.tabGroups.all[0].activeTab = active
			const secondEditor = { ...file.editor, viewColumn: 2 } as vscode.TextEditor
			const secondGroup = { tabs: [{ ...owned }], activeTab: undefined as typeof owned | undefined, viewColumn: 2 }
			host.host.window.tabGroups.all.push(secondGroup)
			host.host.window.visibleTextEditors = [file.editor]
			let show!: () => void
			host.host.commands.executeCommand = sinon.spy(async (_command: string, ..._args: any[]) => {
				await new Promise<void>((resolve) => {
					show = resolve
				})
				secondGroup.activeTab = secondGroup.tabs[0]
				host.host.window.visibleTextEditors = [file.editor, secondEditor]
				host.visible.fire(host.host.window.visibleTextEditors)
			})
			let resolved = false
			const opening = manager.openDiffEditor("/shared.ts", "modify", "original").then((result) => {
				resolved = true
				return result
			})
			await Promise.resolve()
			await Promise.resolve()
			assert.strictEqual(resolved, false, "an inactive owned tab cannot claim a visible ordinary/sibling editor")
			show()
			assert.strictEqual((await opening).editor, secondEditor)
			assert.strictEqual(host.visible.listeners.size, 0)
		})
	}

	it("keeps same-file sibling tabs and decorations distinct on reset", async () => {
		const file = host.addFile("/shared.ts", "shared workspace content")
		const userTab = { input: new TabInputText(file.editor.document.uri as URI), label: "shared.ts", isDirty: false }
		host.tabs.push(userTab)
		await Promise.all(providers.map((provider) => provider.initialize("/shared.ts")))
		const diffTabs = host.tabs.slice(1)
		assert.strictEqual(new Set(diffTabs.map((tab) => (tab.input as TabInputTextDiff).original.toString())).size, 3)
		await providers[1].reset()
		assert.deepStrictEqual(host.tabs, [userTab, diffTabs[0], diffTabs[2]])
		assert.strictEqual(file.editor.document.getText(), "shared workspace content")
		assert.deepStrictEqual(
			host.decorations.map((decoration) => decoration.dispose.callCount),
			[0, 0, 1, 1, 0, 0],
		)
	})

	it("preserves a sibling's saved shared-file content on reset", async () => {
		const file = host.addFile("/shared.ts", "original")
		await Promise.all(providers.map((provider) => provider.initialize("/shared.ts")))
		await providers[0].replaceText("owner write", { startLine: 0, endLine: 1 }, undefined)
		await providers[1].replaceText("sibling write", { startLine: 0, endLine: 1 }, undefined)
		await providers[1].save()
		const siblings = host.tabs.slice(1)
		await providers[0].reset()
		assert.strictEqual(file.editor.document.getText(), "sibling write")
		assert.deepStrictEqual(host.tabs, siblings)
		assert.strictEqual(await providers[1].text(), "sibling write")
		assert.strictEqual(file.save.callCount, 1, "reset does not save or rewrite the document")
	})

	it("hides only one review and keeps sibling review context and listeners alive", async () => {
		const files = ["/a.ts", "/b.ts", "/c.ts"].map((path) => host.addFile(path, path))
		await Promise.all(
			providers.map((provider, index) =>
				provider.showReview(
					[
						{
							absolutePath: files[index].editor.document.uri.fsPath,
							displayPath: "file",
							content: files[index].editor.document.getText(),
						},
					],
					{ taskId: "root", cardId: `review-${index}` },
				),
			),
		)
		const reviews = [...host.tabs]
		assert.strictEqual(new Set(reviews.map((tab) => tab.label)).size, 3)
		const preview = host.preview(2)
		host.focus(preview.editor)
		await providers[0].hideReview()
		assert.deepStrictEqual(host.tabs, reviews.slice(1))
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), true)
		assert.strictEqual(host.contexts.get("dirac.isFileModified"), false)
		preview.setText("user edit")
		host.changed.fire({ document: preview.editor.document })
		assert.strictEqual(host.contexts.get("dirac.isFileModified"), true)
		host.focus(files[0].editor)
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), false)
		await providers[1].hideReview()
		assert.strictEqual(host.changed.listeners.size, 1)
		await providers[2].hideReview()
		assert.strictEqual(host.changed.listeners.size, 0)
		assert.strictEqual(host.active.listeners.size, 0)
	})

	it("retains sibling review registration for the same file", async () => {
		const file = host.addFile("/shared.ts", "proposal")
		await Promise.all(
			providers.map((provider, index) =>
				provider.showReview([{ absolutePath: "/shared.ts", displayPath: "shared.ts", content: "proposal" }], {
					taskId: "root",
					cardId: `review-${index}`,
				}),
			),
		)
		host.focus(host.preview(2).editor)
		await providers[1].reset()
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), true)
		assert.strictEqual(host.tabs.length, 2)
	})

	it("does not forcibly close dirty owned text diffs or unrelated scheme tabs", async () => {
		host.addFile("/a.ts", "edited")
		await providers[0].initialize("/a.ts")
		host.tabs[0].isDirty = true
		const foreign = {
			input: new TabInputTextDiff(URI.parse("dirac-diff:/foreign"), URI.file("/foreign")),
			label: "foreign",
			isDirty: false,
		}
		host.tabs.push(foreign)
		await providers[0].closeViews()
		assert.strictEqual(host.tabs.length, 2)
		host.tabs[0].isDirty = false
		await providers[0].closeViews()
		assert.deepStrictEqual(host.tabs, [foreign])
	})

	it("cleans only owned notebook tabs, watchers and unique temp files even for the same path and timestamp", async () => {
		sinon.stub(Date, "now").returns(1234)
		const file = host.addFile("/shared.ipynb", '{"cells":[]}')
		await Promise.all(providers.map((provider) => provider.initialize("/shared.ipynb")))
		host.focus(host.addFile("/unrelated.ts", "not JSON").editor)
		await Promise.all(providers.map((provider) => provider.specialize()))
		assert.strictEqual(host.tempFiles.size, 3)
		assert.strictEqual(host.watchers.length, 3)
		const notebookTabs = host.tabs.filter((tab) => tab.input instanceof TabInputNotebookDiff)
		assert.strictEqual(notebookTabs.length, 3)
		await providers[1].reset()
		await new Promise((resolve) => setImmediate(resolve)) // Detached notebook backing-file cleanup.
		assert.strictEqual(host.tempFiles.size, 2)
		assert.deepStrictEqual(
			host.watchers.map((watcher) => watcher.dispose.callCount),
			[0, 1, 0],
		)
		assert.ok(host.tabs.includes(notebookTabs[0]))
		assert.ok(!host.tabs.includes(notebookTabs[1]))
		assert.ok(host.tabs.includes(notebookTabs[2]))
		assert.strictEqual(file.editor.document.getText(), '{"cells":[]}')
	})

	it("retains dirty notebook backing files while closing clean owned tabs and stopping synchronization", async () => {
		const file = host.addFile("/a.ipynb", '{"cells":[]}')
		await providers[0].initialize("/a.ipynb")
		await providers[0].specialize()
		const notebookTab = host.tabs.find((tab) => tab.input instanceof TabInputNotebookDiff)!
		notebookTab.isDirty = true
		const input = notebookTab.input as TabInputNotebookDiff
		const cleanTab = {
			input: new TabInputTextDiff(input.original, input.modified),
			label: "clean owned text view of notebook",
			isDirty: false,
		}
		host.tabs.push(cleanTab)
		const notifyChange = host.watchers[0].onDidChange.firstCall.args[0] as () => void
		await providers[0].reset()
		assert.deepStrictEqual(host.tabs, [notebookTab])
		assert.strictEqual(host.host.window.tabGroups.close.calledWith(notebookTab), false)
		assert.strictEqual(host.host.window.tabGroups.close.calledWith(cleanTab), true)
		assert.strictEqual(host.host.workspace.fs.delete.callCount, 0)
		assert.ok(host.tempFiles.has(input.modified.toString()))
		assert.strictEqual(host.watchers[0].dispose.callCount, 1)
		host.tempFiles.set(input.modified.toString(), new TextEncoder().encode('{"cells":["unsynced"]}'))
		notifyChange()
		await new Promise((resolve) => setImmediate(resolve))
		assert.strictEqual(file.editor.document.getText(), '{"cells":[]}')
	})

	for (const Input of [TabInputText, TabInputNotebook]) {
		for (const isDirty of [false, true]) {
			it(`retains a notebook backing file referenced by an ordinary ${Input.name} (${isDirty ? "dirty" : "clean"})`, async () => {
				host.addFile("/a.ipynb", '{"cells":[]}')
				await providers[0].initialize("/a.ipynb")
				await providers[0].specialize()
				const diff = host.tabs.find((tab) => tab.input instanceof TabInputNotebookDiff)!
				const uri = (diff.input as TabInputNotebookDiff).modified
				const ordinary = { input: new Input(uri), label: "user view", isDirty }
				host.tabs.push(ordinary)
				// Reopening with a text editor can replace the diff entirely.
				if (Input === TabInputText) host.tabs.splice(host.tabs.indexOf(diff), 1)
				await providers[0].reset()
				await new Promise((resolve) => setImmediate(resolve))
				assert.deepStrictEqual(host.tabs, [ordinary])
				assert.strictEqual(host.host.window.tabGroups.close.calledWith(ordinary), false)
				assert.strictEqual(host.host.workspace.fs.delete.callCount, 0)
				assert.ok(host.tempFiles.has(uri.toString()))
				assert.strictEqual(host.watchers[0].dispose.callCount, 1)
			})
		}
	}

	it("reset does not wait for text tab closure acknowledgements", async () => {
		host.addFile("/a.ts", "a")
		await providers[0].initialize("/a.ts")
		const close = host.host.window.tabGroups.close
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		host.host.window.tabGroups.close = sinon.spy(async (tab: (typeof host.tabs)[number]) => {
			await gate
			return close(tab)
		})
		await providers[0].reset()
		assert.strictEqual(host.tabs.length, 1, "reset completes while host closure is pending")
		release()
		await new Promise((resolve) => setImmediate(resolve))
		assert.strictEqual(host.tabs.length, 0)
	})

	it("reset retains notebook backing files until detached closure is acknowledged", async () => {
		host.addFile("/a.ipynb", '{"cells":[]}')
		await providers[0].initialize("/a.ipynb")
		await providers[0].specialize()
		const notebookTab = host.tabs.find((tab) => tab.input instanceof TabInputNotebookDiff)!
		const uri = (notebookTab.input as TabInputNotebookDiff).modified.toString()
		const close = host.host.window.tabGroups.close
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		host.host.window.tabGroups.close = sinon.spy(async (tab: (typeof host.tabs)[number]) => {
			if (tab === notebookTab) await gate
			return close(tab)
		})
		await providers[0].reset()
		assert.ok(host.tabs.includes(notebookTab))
		assert.ok(host.tempFiles.has(uri), "pending closure must retain its backing file")
		assert.strictEqual(host.watchers[0].dispose.callCount, 1)
		release()
		await new Promise((resolve) => setImmediate(resolve))
		assert.ok(!host.tabs.includes(notebookTab))
		assert.ok(!host.tempFiles.has(uri), "confirmed closure permits backing-file deletion")
	})

	it("retains the backing file when an ordinary view opens during pending diff closure", async () => {
		host.addFile("/a.ipynb", '{"cells":[]}')
		await providers[0].initialize("/a.ipynb")
		await providers[0].specialize()
		const notebookTab = host.tabs.find((tab) => tab.input instanceof TabInputNotebookDiff)!
		const uri = (notebookTab.input as TabInputNotebookDiff).modified
		const close = host.host.window.tabGroups.close
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		host.host.window.tabGroups.close = sinon.spy(async (tab: (typeof host.tabs)[number]) => {
			if (tab === notebookTab) await gate
			return close(tab)
		})
		await providers[0].reset()
		const ordinary = { input: new TabInputNotebook(uri), label: "new user view", isDirty: true }
		host.tabs.push(ordinary)
		release()
		await new Promise((resolve) => setImmediate(resolve))
		assert.deepStrictEqual(host.tabs, [ordinary])
		assert.strictEqual(host.host.window.tabGroups.close.calledWith(ordinary), false)
		assert.ok(host.tempFiles.has(uri.toString()))
		assert.strictEqual(host.host.workspace.fs.delete.callCount, 0)
	})

	it("reset does not wait for a pending host diff command", async () => {
		host.addFile("/a.ts", "a")
		const executeCommand = host.host.commands.executeCommand
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		host.host.commands.executeCommand = sinon.spy(async (command: string, ...args: any[]) => {
			if (command === "vscode.diff") await gate
			await executeCommand(command, ...args)
		})
		const opening = providers[0].initialize("/a.ts")
		await providers[0].reset()
		release()
		await opening
		assert.strictEqual(await providers[0].text(), undefined)
	})

	it("notebook temp deletion failure does not prevent reset or the next edit", async () => {
		expectLoggerErrors()
		host.addFile("/a.ipynb", '{"cells":[]}')
		await providers[0].initialize("/a.ipynb")
		await providers[0].specialize()
		host.host.workspace.fs.delete = sinon.spy(async (_uri: URI): Promise<void> => {
			throw new Error("delete failed")
		})
		await providers[0].reset()
		await new Promise((resolve) => setImmediate(resolve))
		assert.strictEqual(host.host.workspace.fs.delete.callCount, 1)
		host.addFile("/next.ts", "next")
		await providers[0].initialize("/next.ts")
		assert.strictEqual(await providers[0].text(), "next")
	})

	it("reset cleans idle review-only resources", async () => {
		const files = ["/a.ts", "/b.ts", "/c.ts"].map((absolutePath) => ({
			absolutePath,
			displayPath: absolutePath,
			content: "proposal",
		}))
		await Promise.all(
			providers.map((provider, index) =>
				provider.showReview([files[index]], { taskId: `task-${index}`, cardId: `review-${index}` }),
			),
		)
		const siblings = host.tabs.slice(1)
		await providers[0].reset()
		assert.deepStrictEqual(host.tabs, siblings)
		host.focus(host.addFile("/b.ts", "proposal").editor)
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), false, "Ordinary files never select an approval")
		host.focus(host.preview(1).editor)
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), true)
		host.focus(host.addFile("/a.ts", "proposal").editor)
		assert.strictEqual(host.contexts.get("dirac.isFileUnderReview"), false)
	})

	it("attempts remaining owned text/review closes after one rejects, without closing sibling tabs", async () => {
		for (const [index, path] of ["/a.ts", "/b.ts", "/c.ts"].entries()) {
			host.addFile(path, path)
			await providers[index].initialize(path)
		}
		await providers[0].showReview([{ absolutePath: "/a.ts", displayPath: "a.ts", content: "a" }])
		const [own, ...rest] = host.tabs
		const siblings = rest.slice(0, 2)
		const close = host.host.window.tabGroups.close
		host.host.window.tabGroups.close = sinon.spy(async (tab: (typeof host.tabs)[number]) => {
			if (tab === own) throw new Error("close failed")
			return close(tab)
		})
		await providers[0].reset()
		assert.deepStrictEqual(host.tabs, [own, ...siblings], "owned review still closed after the diff close failed")
		host.host.window.tabGroups.close = close
		await providers[0].reset()
		assert.deepStrictEqual(host.tabs, siblings)
	})

	it("retains refused notebook views without failing reset or touching siblings", async () => {
		host.addFile("/a.ipynb", '{"cells":[]}')
		await providers[0].initialize("/a.ipynb")
		await providers[0].specialize()
		for (const [index, path] of ["/b.ts", "/c.ts"].entries()) {
			host.addFile(path, path)
			await providers[index + 1].initialize(path)
		}
		const notebookTab = host.tabs.find((tab) => tab.input instanceof TabInputNotebookDiff)!
		const duplicate = { ...notebookTab, label: "second owned notebook tab" }
		host.tabs.push(duplicate)
		const siblings = host.tabs.filter((tab) => tab.label.startsWith("b.ts:") || tab.label.startsWith("c.ts:"))
		const close = host.host.window.tabGroups.close
		host.host.window.tabGroups.close = sinon.spy(async (tab: (typeof host.tabs)[number]) => {
			if (tab === notebookTab) return false
			return close(tab)
		})
		await providers[0].reset()
		await new Promise((resolve) => setImmediate(resolve))
		assert.strictEqual(host.host.workspace.fs.delete.callCount, 0)
		assert.ok(host.tempFiles.has((notebookTab.input as TabInputNotebookDiff).modified.toString()))
		assert.strictEqual(host.watchers[0].dispose.callCount, 1)
		assert.deepStrictEqual(host.tabs, [notebookTab, ...siblings])
	})

	it("rejects a failed diff open and releases its listeners without touching sibling views", async () => {
		host.addFile("/a.ts", "a")
		await providers[0].initialize("/a.ts")
		const sibling = host.tabs[0]
		const executeCommand = host.host.commands.executeCommand
		host.host.commands.executeCommand = sinon.spy(async (_command: string, ..._args: any[]): Promise<void> => {
			throw new Error("host refused diff")
		})
		await assert.rejects(providers[1].initialize("/b.ts"), /host refused diff/)
		assert.deepStrictEqual(host.tabs, [sibling])
		assert.strictEqual(host.visible.listeners.size, 0)
		host.host.commands.executeCommand = executeCommand
	})
})
