const assert = require('node:assert/strict')
const test = require('node:test')
const { matchingTriggers, followUp } = require('./co-author-follow-up.cjs')

test('only a substring in the value of a co-author field matches', () => {
	for (const term of ['Claude', 'Anthropic', 'Codex', 'ChatGPT', 'Copilot', 'Gemini', 'Cursor', 'Windsurf', 'Devin', 'Codeium']) {
		assert.deepEqual(matchingTriggers(`CO-AUTHORED-BY: 123+${term}[bot]@example.org`), [term.toLowerCase()])
	}
	assert.deepEqual(matchingTriggers('fix: Copilot\n\nGenerated with Claude Code\nCo-authored-by: Pat\nSigned-off-by: Codex'), [])
	assert.deepEqual(matchingTriggers('Document Co-authored-by: Claude'), [])
	assert.deepEqual(matchingTriggers('Co-authored-by: Claude <noreply@anthropic.com>\r\nCo-authored-by: Codex'), ['claude', 'anthropic', 'codex'])
})

test('stays silent on clean PRs, then creates, updates and resolves one bot comment', async () => {
	const repo = { owner: 'org', repo: 'repo' }
	const pr = { number: 1, base: { sha: 'base' }, head: { sha: 'head' }, title: 'Co-authored-by: Claude', body: 'Co-authored-by: Codex' }
	const comments = [], updates = []
	const clean = { sha: 'aaa', commit: { message: 'fix: normal' } }
	const last = { sha: 'abcdef', commit: { message: '' } }
	const github = {
		rest: {
			repos: { async compareCommitsWithBasehead({ basehead, page, per_page }) {
				assert.equal(basehead, 'base...head')
				assert.equal(per_page, 100)
				const commits = page <= 2 ? Array(100).fill(clean) : [...Array(50).fill(clean), last]
				return { data: { commits, total_commits: 251 } }
			} },
			issues: {
				async createComment({ body }) { comments.push({ id: 7, user: { login: 'github-actions[bot]' }, body }) },
				async updateComment({ comment_id, body }) { assert.equal(comment_id, 7); updates.push(body); comments[0].body = body },
			},
		},
		paginate: { async *iterator() { yield { data: comments } } },
	}
	const run = () => followUp(github, repo, pr)
	await run()
	assert.equal(comments.length, 0)
	last.commit.message = 'fix: example\n\nCo-authored-by: Copilot'
	await run()
	assert.match(comments[0].body, /`abcdef`: copilot/)
	await run()
	assert.equal(updates.length, 0)
	last.commit.message = 'Co-authored-by: Cursor'
	await run()
	assert.match(updates[0], /`abcdef`: cursor/)
	last.commit.message = 'fix: example'
	await run()
	assert.match(updates[1], /resolved/)
	assert.equal(comments.length, 1)
})
