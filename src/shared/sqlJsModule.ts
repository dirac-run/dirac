import initSqlJs from "sql.js"
import * as fs from "fs"
import * as path from "path"

export type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
export type SqlJsDatabase = InstanceType<SqlJsStatic["Database"]>

let sqlModule: SqlJsStatic | null = null

export async function ensureSqlModule(): Promise<SqlJsStatic> {
    if (!sqlModule) {
        sqlModule = await initSqlJs({
            locateFile: (file: string) => {
                const primary = path.join(__dirname, file)
                if (fs.existsSync(primary)) return primary
                // Fallback: look in sql.js package (dev/test environment)
                return path.join(process.cwd(), "node_modules", "sql.js", "dist", file)
            },
        })
    }
    return sqlModule
}
