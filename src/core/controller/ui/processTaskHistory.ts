/** Filters/sorts/caps task history for the active workspace root. */
export function processTaskHistory(taskHistory: any, primaryRootPath: string | undefined): any[] {
	return (taskHistory || [])
		.filter((item: any) => {
			if (!item.ts || !item.task) return false
			if (!primaryRootPath) return true
			return !item.workspaceRootPath || item.workspaceRootPath === primaryRootPath
		})
		.sort((a: any, b: any) => b.ts - a.ts)
		.slice(0, 100)
}
