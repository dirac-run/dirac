import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { isSupportedUserCommandPatternSyntax } from "../UserApprovedCommandSyntax"

// This guard protects legacy pattern matching only; it never classifies command capabilities.
describe("UserApprovedCommandSyntax", () => {
	afterEach(() => sinon.restore())

	it("preserves the literal POSIX subset used by legacy command patterns", () => {
		sinon.stub(process, "platform").value("linux")
		for (const command of ["npm test", "pwd && npm test 2>&1", "find . ! -name '*.ts'", "echo 'literal $OPTIONS'"]) {
			assert.equal(isSupportedUserCommandPatternSyntax(command), true, command)
		}
	})

	it("rejects normalization-sensitive syntax even when the classifier might know its capabilities", () => {
		sinon.stub(process, "platform").value("linux")
		for (const command of [
			"npm test $OPTIONS", 'npm test "$OPTIONS"', "npm test *.ts", "(npm test)",
			"npm test $(pwd)", "npm test `pwd`", "npm test > output.txt", "npm test\npwd",
			"'npm test'", "npm test 2>&10", "npm test 2>/dev/null.backup",
		]) {
			assert.equal(isSupportedUserCommandPatternSyntax(command), false, command)
		}
	})

	for (const platform of ["win32", "android", "unknown"]) {
		it(`does not widen legacy POSIX user patterns on ${platform}`, () => {
			sinon.stub(process, "platform").value(platform)
			assert.equal(isSupportedUserCommandPatternSyntax("npm test"), false)
		})
	}
})
