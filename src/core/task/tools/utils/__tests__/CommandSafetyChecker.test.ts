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

		it("allows numbered file reads without approving unsafe shell combinations", () => {
			isSafeCommand("nl -ba src/index.ts").should.equal(true)
			isSafeCommand("nl -ba src/index.ts | head -220").should.equal(true)
			isSafeCommand("nl -ba src/index.ts | sed -n '115,250p'").should.equal(true)
			isSafeCommand("nl -ba src/index.ts > numbered.txt").should.equal(false)
			isSafeCommand("nl -ba $(touch marker)").should.equal(false)
			isSafeCommand("nl -ba src/index.ts; rm marker").should.equal(false)
		})

		it("should allow safe sed commands (read-only)", () => {
			isSafeCommand("sed -n '1p' file.txt").should.equal(true)
			isSafeCommand("sed -n '1787,1790p' src/core/task/index.ts").should.equal(true)
			isSafeCommand("sed -e '1,5p' file.txt").should.equal(true)
			isSafeCommand("sed -n '1,5p' file.txt | head -20").should.equal(true)
		})

		it("should allow grep with BRE alternation (backslash-pipe) in patterns", () => {
			isSafeCommand("grep -n 'foo\\|bar' file.txt").should.equal(true)
			isSafeCommand("grep -rn 'partialMessage\\|partial_message' src/ --include='*.ts' | head -30").should.equal(true)
			isSafeCommand("grep -rn 'a\\|b\\|c' src/ --include='*.ts' --include='*.tsx' | head -30").should.equal(true)
		})

		it("should allow stderr redirection mid-pipe (2>/dev/null)", () => {
			isSafeCommand("grep -n 'foo' file.zig 2>/dev/null | head -40").should.equal(true)
			isSafeCommand("grep -rn 'TODO' src/ 2>/dev/null | tail -20").should.equal(true)
			isSafeCommand("grep -c 'import' src/ 2>/dev/null | wc -l").should.equal(true)
			isSafeCommand("grep -rn 'foo' src/ 2>/dev/null | sort | uniq -c 2>/dev/null | head -10").should.equal(true)
		})

		it("should allow stderr redirection to stdout (2>&1)", () => {
			isSafeCommand("ls 2>&1").should.equal(true)
			isSafeCommand("ls 2>&1 | head -5").should.equal(true)
		})

		it("should allow grep with comparison operators inside quotes", () => {
			isSafeCommand("grep -E 'version >= 2' README.md").should.equal(true)
			isSafeCommand("grep -E 'value > 100' data.csv").should.equal(true)
			isSafeCommand("grep -E '<div|<span' template.html").should.equal(true)
		})

		it("should allow backslash-escaped pipe in grep patterns", () => {
			isSafeCommand("grep -E foo\\|bar src/file.ts").should.equal(true)
		})

		it("requires approval for awk rather than parsing a programming language", () => {
			isSafeCommand("awk '{print $1}' file.txt").should.equal(false)
			isSafeCommand("awk -F: '{print $1}' /etc/passwd").should.equal(false)
		})

		it("should still block stderr strip followed by real redirection", () => {
			isSafeCommand("cat file 2>/dev/null > output.txt").should.equal(false)
			isSafeCommand("echo test 2>/dev/null > malicious.txt").should.equal(false)
		})

		it("should reject commands with unmatched quotes", () => {
			isSafeCommand("echo 'unterminated > redirect").should.equal(false)
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
		const unsafeCommands = [
			// These are classifier inputs only. Never execute candidate commands.
			"awk 'BEGIN { system(\"touch /tmp/file\") }'",
			'awk \'BEGIN { print "x" > "/tmp/file" }\'',
			"awk -f program.awk file.txt",
			"sed 'w /tmp/file' input.txt",
			"sed '1e touch /tmp/file' input.txt",
			"sed 's/x/touch \/tmp\/file/e' input.txt",
			"sed 's/x/y/w /tmp/file' input.txt",
			"sed -f program.sed input.txt",
			"sed -n '1p;w /tmp/file' input.txt",
			"sed -n 1p input.txt -e 'w /tmp/file'",
			"sed -e 's/foo/bar/' input.txt",
			"git diff --output=/tmp/file",
			"git log --output /tmp/file",
			"git show --output=/tmp/file",
			"git diff '--output=/tmp/file'",
			"git diff --out=/tmp/file",
			"git diff --ext-diff",
			"git show --textconv HEAD:file",
			"git -c diff.external=program diff",
			"git diff --no-index --output=/tmp/file a b",
			"git diff --word-diff --output=/tmp/file",
			"git diff --rotate-to=path --output=/tmp/file",
			"find . -fprint /tmp/file",
			"find . -fprint0 /tmp/file",
			"find . -fprintf /tmp/file '%p'",
			"find . -fls /tmp/file",
			"find . '-exec' touch /tmp/file ';'",
			"find . -okdir touch /tmp/file ';'",
			"rg --pre 'touch /tmp/file' pattern",
			"rg --pre=program pattern",
			"rg --hostname-bin=program pattern",
			"rg --search-zip pattern",
			"rg -z pattern",
			"sort --compress-program=program input.txt",
			"sort --comp=program input.txt",
			"sort -ro/tmp/file input.txt",
			"uniq input.txt /tmp/file",
			"uniq input.txt -c",
			"uniq - -c",
			"uniq -c input.txt /tmp/file",
			"uniq -- input.txt /tmp/file",
			"file -C -m magic",
			"file --compile magic",
			"file -z archive.gz",
			"date --set='2020-01-01'",
			"date -s 2020-01-01",
			"hostname new-host",
			"hostname -F /tmp/hostname",
			"uname -S new-host",
			"ls & touch /tmp/file",
			"ls & pwd",
			"ls |& cat",
			"ls # comment ; touch /tmp/file",
			"echo $OPTIONS",
			'git diff "$OPTIONS"',
			"sort ${OPTIONS}",
			"sort *",
			"cat <(pwd)",
			"(ls)",
			"ls\npwd",
			"ls\\\npwd",
			"ls\\",
			"ls ||",
			"ls ;; pwd",
			"ls 2>/dev/null.backup",
			"ls 2>&10",
			"ls 2>/dev/null>/tmp/file",
			"ls 2>&1>/tmp/file",
			"ls 12>/tmp/file",
			"ls 2> /tmp/file",
			"ls 2>/dev/null 3>/tmp/file",
			"git diff --out\\put=/tmp/file",
			'git diff --out"put"=/tmp/file',
			"constructor",
			"toString",
			"__proto__",
			"LS",
			"'' ls",
			"",
			"   ",
		]
		for (const command of unsafeCommands) {
			it(`requires approval for ${JSON.stringify(command)}`, () => {
				isSafeCommand(command).should.equal(false)
			})
		}

		for (const command of [
			"find . -type f -name '*.ts' -print",
			"find . -maxdepth 2 -printf '%p\\n'",
			"rg -n --glob '*.ts' 'foo|bar' src/",
			"rg --no-config --hidden --files src/",
			"git diff --no-ext-diff --no-textconv --stat HEAD",
			"git log -5 --oneline --format='%h %s'",
			"git status --short --branch",
			"sort -nr input.txt",
			"sort -k1,1 --field-separator=: input.txt",
			"uniq -c input.txt",
			"file -b --mime-type input.txt",
			"uname -a",
			"hostname -f",
			"date -u '+%F %T'",
			"sed -n '1,$p' input.txt",
			"echo 'literal $(touch /tmp/file) & >'",
			'echo "literal \\$(touch /tmp/file) & >"',
			"grep '2>/dev/null.backup' file.txt",
			"echo '2>&10'",
			"ls 2>/dev/null&&pwd",
			"ls 2>&1|head -5",
			"ls && pwd || whoami; date",
			"'ls' -la",
		]) {
			it(`preserves literal read command ${JSON.stringify(command)}`, () => {
				isSafeCommand(command).should.equal(true)
			})
		}
	})
})
