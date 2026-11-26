const triggers = ['claude', 'anthropic', 'codex', 'chatgpt', 'copilot', 'gemini', 'cursor', 'windsurf', 'devin', 'codeium']
const commentMarker = '<!-- dirac:co-author-follow-up -->'

function matchingTriggers(message) {
	const matches = new Set()
	for (const line of message.split(/\r?\n/)) {
		const field = /^\s*co-authored-by\s*:(.*)$/i.exec(line)
		if (!field) continue
		const value = field[1].toLowerCase()
		for (const trigger of triggers) {
			if (value.includes(trigger)) matches.add(trigger)
		}
	}
	return [...matches]
}

async function findMatchingCommits(github, repo, pr) {
	const matches = []
	// Compare the PR's two SHAs: the list-PR-commits endpoint stops at 250.
	for (let page = 1; ; page++) {
		const { data } = await github.rest.repos.compareCommitsWithBasehead({
			...repo, basehead: `${pr.base.sha}...${pr.head.sha}`, page, per_page: 100,
		})
		for (const { sha, commit } of data.commits) {
			const terms = matchingTriggers(commit.message)
			if (terms.length) matches.push(`- \`${sha.slice(0, 12)}\`: ${terms.join(', ')}`)
		}
		if (page * 100 >= data.total_commits) return matches
	}
}

async function followUp(github, repo, pr) {
	const matches = await findMatchingCommits(github, repo, pr)
	const issue = { ...repo, issue_number: pr.number }
	const body = matches.length
		? `${commentMarker}\nPlease reword the following commits to remove the matching \`Co-authored-by:\` trailers, then push the updated branch.\n\n${matches.join('\n')}`
		: `${commentMarker}\nFollow-up resolved: no matching \`Co-authored-by:\` trailers remain.`

	const issues = github.rest.issues
	for await (const { data } of github.paginate.iterator(issues.listComments, { ...issue, per_page: 100 })) {
		const previous = data.find((c) => c.user.login === 'github-actions[bot]' && c.body?.startsWith(commentMarker))
		if (!previous) continue
		if (previous.body !== body) await issues.updateComment({ ...repo, comment_id: previous.id, body })
		return
	}
	if (matches.length) await issues.createComment({ ...issue, body })
}

module.exports = { followUp, matchingTriggers }
