import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_FILES = 5

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".dirac", "data", "logs")
const LOG_FILE_BASE = "dirac-ext.log"

let writeStream: fs.WriteStream | null = null
let logDir: string | null = null
let currentSize = 0

function ensureLogDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function getLogPath(dir: string, index?: number): string {
	if (index === undefined || index === 0) {
		return path.join(dir, LOG_FILE_BASE)
	}
	return path.join(dir, `dirac-ext.${index}.log`)
}

function rotateSync(dir: string): void {
	// Delete the oldest file if it exists
	const oldestPath = getLogPath(dir, MAX_FILES - 1)
	if (fs.existsSync(oldestPath)) {
		fs.unlinkSync(oldestPath)
	}

	// Shift files: dirac-ext.3.log → dirac-ext.4.log, dirac-ext.2.log → dirac-ext.3.log, ...
	for (let i = MAX_FILES - 2; i >= 1; i--) {
		const src = getLogPath(dir, i)
		const dst = getLogPath(dir, i + 1)
		if (fs.existsSync(src)) {
			fs.renameSync(src, dst)
		}
	}

	// dirac-ext.log → dirac-ext.1.log
	const currentPath = getLogPath(dir)
	if (fs.existsSync(currentPath)) {
		fs.renameSync(currentPath, getLogPath(dir, 1))
	}
}

function openStream(dir: string): fs.WriteStream {
	const filePath = getLogPath(dir)

	if (fs.existsSync(filePath)) {
		currentSize = fs.statSync(filePath).size
		if (currentSize >= MAX_SIZE_BYTES) {
			rotateSync(dir)
			currentSize = 0
		}
	} else {
		currentSize = 0
	}

	return fs.createWriteStream(filePath, { flags: "a" })
}

function writeToFile(msg: string): void {
	if (!writeStream || !logDir) {
		return
	}

	const line = msg + "\n"
	const bytes = Buffer.byteLength(line, "utf8")

	if (currentSize + bytes >= MAX_SIZE_BYTES) {
		writeStream.end()
		rotateSync(logDir)
		writeStream = openStream(logDir)
	}

	writeStream.write(line)
	currentSize += bytes
}

/**
 * Initialize file-based logging to the given directory.
 * Returns a callback suitable for `Logger.subscribe()`.
 *
 * @param dir Directory to write log files into. Defaults to `~/.dirac/data/logs/`.
 */
export function initFileLogger(dir: string = DEFAULT_LOG_DIR): (msg: string) => void {
	logDir = dir
	ensureLogDir(dir)
	writeStream = openStream(dir)
	return writeToFile
}
