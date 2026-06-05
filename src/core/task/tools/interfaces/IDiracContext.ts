export interface IDiracContext {
    task: {
        get<T>(key: string): T | undefined
        set<T>(key: string, value: T): void
    }
    workspace: {
        get<T>(key: string): T | undefined
        set<T>(key: string, value: T): void
    }
    global: {
        get<T>(key: string): T | undefined
        set<T>(key: string, value: T): void
    }
    resetTaskContext(): Promise<void>
    load(): Promise<void>
    save(): Promise<void>

}
