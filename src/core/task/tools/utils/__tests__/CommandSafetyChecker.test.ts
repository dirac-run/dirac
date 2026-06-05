import { describe, it } from "mocha"
import "should"
import { isSafeCommand } from "../CommandSafetyChecker"

describe("CommandSafetyChecker", () => {
	describe("isSafeCommand", () => {
		// Positive cases
		it("should allow simple safe commands", () => {
			isSafeCommand("ls").should.equal(true)
			isSafeCommand("pwd").should.equal(true)
			isSafeCommand("date").should.equal(true)
			isSafeCommand("whoami").should.equal(true)
		})

		it("should allow safe commands with arguments", () => {
			isSafeCommand("ls -la").should.equal(true)
			isSafeCommand("grep 'search term' file.txt").should.equal(true)
			isSafeCommand("cat README.md").should.equal(true)
			isSafeCommand("head -n 20 file.ts").should.equal(true)
		})

		it("should allow piped safe commands", () => {
			isSafeCommand("ls | grep ts").should.equal(true)
			isSafeCommand("cat file.txt | sort | uniq").should.equal(true)
		})

		it("should allow commands with 2>/dev/null", () => {
			isSafeCommand("ls 2>/dev/null").should.equal(true)
			isSafeCommand("find . -name '*.ts' 2>/dev/null").should.equal(true)
		})

		it("should allow safe git subcommands", () => {
			isSafeCommand("git status").should.equal(true)
			isSafeCommand("git log").should.equal(true)
			isSafeCommand("git diff").should.equal(true)
			isSafeCommand("git show").should.equal(true)
			isSafeCommand("git branch").should.equal(true)
			isSafeCommand("git branch -a").should.equal(true)
			isSafeCommand("git remote").should.equal(true)
			isSafeCommand("git remote -v").should.equal(true)
		})

		it("should allow newly added safe commands", () => {
			isSafeCommand("which node").should.equal(true)
			isSafeCommand("type ls").should.equal(true)
		})

		it("should allow safe sed commands (read-only)", () => {
			isSafeCommand("sed -n '1p' file.txt").should.equal(true)
			isSafeCommand("sed -n '1787,1790p' src/core/task/index.ts").should.equal(true)
			isSafeCommand("sed -e 's/foo/bar/' file.txt").should.equal(true)
			isSafeCommand("sed -n '1,5p' file.txt | head -20").should.equal(true)
		})

		it("should allow grep with BRE alternation (backslash-pipe) in patterns", () => {
			isSafeCommand("grep -n 'foo\\|bar' file.txt").should.equal(true)
			isSafeCommand("grep -rn 'partialMessage\\|partial_message' src/ --include='*.ts' | head -30").should.equal(true)
			isSafeCommand("grep -rn 'a\\|b\\|c' src/ --include='*.ts' --include='*.tsx' | head -30").should.equal(true)
		})


		// Negative cases
		it("should reject output redirection", () => {
			isSafeCommand("ls > files.txt").should.equal(false)
			isSafeCommand("ls >> files.txt").should.equal(false)
			isSafeCommand("echo 'hello' > greeting.txt").should.equal(false)
		})

		it("should reject input redirection", () => {
			isSafeCommand("cat < /etc/passwd").should.equal(false)
			isSafeCommand("grep foo < file.txt").should.equal(false)
		})

		it("should reject command substitution", () => {
			isSafeCommand("echo $(whoami)").should.equal(false)
			isSafeCommand("echo `whoami`").should.equal(false)
			isSafeCommand("ls $(pwd)").should.equal(false)
		})

		it("should reject process substitution", () => {
			isSafeCommand("diff <(ls folder1) <(ls folder2)").should.equal(false)
		})

		it("should reject dangerous find flags", () => {
			isSafeCommand("find . -delete").should.equal(false)
			isSafeCommand("find . -exec rm {} \\;").should.equal(false)
			isSafeCommand("find . -execdir touch {} \\;").should.equal(false)
			isSafeCommand("find . -ok rm {} \\;").should.equal(false)
		})

		it("should reject dangerous sort flags", () => {
			isSafeCommand("sort -o important.txt file.txt").should.equal(false)
			isSafeCommand("sort --output=important.txt file.txt").should.equal(false)
		})

		it("should reject sed with in-place edit flags", () => {
			isSafeCommand("sed -i 's/foo/bar/' file.txt").should.equal(false)
			isSafeCommand("sed -i.bak 's/foo/bar/' file.txt").should.equal(false)
			isSafeCommand("sed -i'' 's/foo/bar/' file.txt").should.equal(false)
			isSafeCommand("sed -in 's/foo/bar/' file.txt").should.equal(false)
			isSafeCommand("sed -ni '1p' file.txt").should.equal(false)
			isSafeCommand("sed --in-place 's/foo/bar/' file.txt").should.equal(false)
			isSafeCommand("sed --in-place=.bak 's/foo/bar/' file.txt").should.equal(false)
		})

		it("should reject dangerous git operations", () => {
			isSafeCommand("git checkout master").should.equal(false)
			isSafeCommand("git branch -D old-branch").should.equal(false)
			isSafeCommand("git remote add origin url").should.equal(false)
			isSafeCommand("git push").should.equal(false)
			isSafeCommand("git commit").should.equal(false)
		})

		it("should reject unsafe base commands", () => {
			isSafeCommand("rm -rf /").should.equal(false)
			isSafeCommand("mv file1 file2").should.equal(false)
			isSafeCommand("cp file1 file2").should.equal(false)
			isSafeCommand("mkdir new_folder").should.equal(false)
			isSafeCommand("touch new_file").should.equal(false)
			isSafeCommand("npm install").should.equal(false)
		})

		it("should reject chained unsafe commands", () => {
			isSafeCommand("ls ; rm -rf /").should.equal(false)
			isSafeCommand("ls && rm -rf /").should.equal(false)
			isSafeCommand("ls || rm -rf /").should.equal(false)
		})

		it("should reject environment variable prefixing", () => {
			isSafeCommand("NODE_ENV=production ls").should.equal(false)
		})
	})
})
