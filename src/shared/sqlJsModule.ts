import initSqlJs from "sql.js"
import * as path from "path"

export type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
export type SqlJsDatabase = InstanceType<SqlJsStatic["Database"]>

let sqlModule: SqlJsStatic | null = null

export async function ensureSqlModule(): Promise<SqlJsStatic> {
	if (!sqlModule) {
		sqlModule = await initSqlJs({
			locateFile: (file: string) => path.join(__dirname, file),
		})
	}
	return sqlModule
}
