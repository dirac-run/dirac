import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const config = await mkdtemp(path.join(tmpdir(), "acp-config-"))
const cwd = await mkdtemp(path.join(tmpdir(), "acp-cwd-"))
const child = spawn(process.execPath, [path.resolve(process.cwd(), "dist/cli.mjs"), "--acp", "--config", config, "--cwd", cwd], {
	stdio: ["pipe", "pipe", "pipe"],
})
child.stdout.setEncoding("utf8")
child.stderr.setEncoding("utf8")
child.stdout.on("data", (data) => console.log("OUT", data))
child.stderr.on("data", (data) => console.log("ERR", data))
child.on("exit", (code, signal) => console.log("EXIT", code, signal))
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } } })}\n`)
setTimeout(() => {
	console.log("STATUS", child.exitCode)
	child.stdin.end()
}, 5_000)
