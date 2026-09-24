import * as fs from "fs"

/** Minimal VS Code `Event<T>` shape — a subscribable callback returning a disposable. */
export type Event<T> = (listener: (e: T) => any) => { dispose(): any }

export interface SecretStorageChangeEvent {
	key: string
}

/** File-backed secret store with the same shape VS Code's SecretStorage exposes. */
export class SecretStore {
	private data: JsonKeyValueStore<string>
	private readonly _onDidChange = new EventEmitter<SecretStorageChangeEvent>()

	constructor(filepath: string) {
		this.data = new JsonKeyValueStore(filepath)
	}

	readonly onDidChange: Event<SecretStorageChangeEvent> = this._onDidChange.event

	get(key: string): Thenable<string | undefined> {
		return Promise.resolve(this.data.get(key))
	}

	store(key: string, value: string): Thenable<void> {
		this.data.put(key, value)
		this._onDidChange.fire({ key })
		return Promise.resolve()
	}

	delete(key: string): Thenable<void> {
		this.data.delete(key)
		this._onDidChange.fire({ key })
		return Promise.resolve()
	}
}

// Create a class with the Memento surface (get/update/keys/setKeysForSync)
export class MementoStore {
	private data: JsonKeyValueStore<any>

	constructor(filepath: string) {
		this.data = new JsonKeyValueStore(filepath)
	}
	keys(): readonly string[] {
		return Array.from(this.data.keys())
	}
	get<T>(key: string): T | undefined {
		return this.data.get(key) as T
	}
	update(key: string, value: any): Thenable<void> {
		this.data.put(key, value)
		return Promise.resolve()
	}
	setKeysForSync(_keys: readonly string[]): void {
		throw new Error("Method not implemented.")
	}
}

// Simple implementation of VS Code's EventEmitter
type EventCallback<T> = (e: T) => any
export class EventEmitter<T> {
	private listeners: EventCallback<T>[] = []

	event: Event<T> = (listener: EventCallback<T>) => {
		this.listeners.push(listener)
		return {
			dispose: () => {
				const index = this.listeners.indexOf(listener)
				if (index !== -1) {
					this.listeners.splice(index, 1)
				}
			},
		}
	}

	fire(data: T): void {
		this.listeners.forEach((listener) => listener(data))
	}
}

/** A simple key-value store for secrets backed by a JSON file. This is not secure, and it is not thread-safe. */
export class JsonKeyValueStore<T> {
	private data = new Map<string, T>()
	private filePath: string

	constructor(filePath: string) {
		this.filePath = filePath
		this.load()
	}

	get(key: string): T | undefined {
		return this.data.get(key)
	}

	put(key: string, value: T): void {
		this.data.set(key, value)
		this.save()
	}

	delete(key: string): void {
		this.data.delete(key)
		this.save()
	}
	keys(): Iterable<string> | ArrayLike<string> {
		return this.data.keys()
	}
	private load(): void {
		if (fs.existsSync(this.filePath)) {
			const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"))
			Object.entries(data).forEach(([k, v]) => {
				this.data.set(k, v as T)
			})
		}
	}
	private save(): void {
		// Use mode 0o600 to restrict file permissions to owner read/write only (fixes #7778)
		fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.data), null, 2), { mode: 0o600 })
	}
}

/** This is not used in dirac, none of the methods are implemented. */
export class EnvironmentVariableCollection {
	persistent = false
	description: string | undefined = undefined
	replace(_variable: string, _value: string, _options?: unknown): void {
		throw new Error("Method not implemented.")
	}
	append(_variable: string, _value: string, _options?: unknown): void {
		throw new Error("Method not implemented.")
	}
	prepend(_variable: string, _value: string, _options?: unknown): void {
		throw new Error("Method not implemented.")
	}
	get(_variable: string): unknown {
		throw new Error("Method not implemented.")
	}
	forEach(_callback: (variable: string, mutator: unknown, collection: EnvironmentVariableCollection) => any): void {
		throw new Error("Method not implemented.")
	}
	delete(_variable: string): void {
		throw new Error("Method not implemented.")
	}
	clear(): void {
		throw new Error("Method not implemented.")
	}
	[Symbol.iterator](): Iterator<[variable: string, mutator: unknown], any, any> {
		throw new Error("Method not implemented.")
	}
	getScoped(_scope: unknown): EnvironmentVariableCollection {
		throw new Error("Method not implemented.")
	}
}

export function readJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf8"))
}
