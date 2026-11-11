import assert from 'node:assert/strict'
import test from 'node:test'
import { requestSession, startSession } from './client.mjs'

// Runs the real built CLI in the harness's isolated home; never invokes a live model.
test('sandbox settings: disabled view, flat capability editing, and save without assignment', { timeout: 60000 }, async () => {
	const { session } = await startSession({ cols: 60, rows: 30 })
	const key = (key, count) => requestSession(session, { operation: 'key', key, ...(count ? { count } : {}) })
	try {
		await requestSession(session, { operation: 'wait', text: '@ files' })
		await requestSession(session, { operation: 'write', text: '/settings' })
		await key('Enter')
		await requestSession(session, { operation: 'write', text: '8' })
		const disabled = await requestSession(session, { operation: 'wait', text: 'Sandbox is disabled.' })
		assert.doesNotMatch(disabled.screen, /Main agent:|Subagents:|Advanced|Customize Workspace/)
		await key('Enter')
		const enabled = await requestSession(session, { operation: 'wait', text: 'Customize Workspace' })
		assert.match(enabled.screen, /Default \(unrestricted\)/)
		// Includes the inspectable Default row; section headings are not selectable.
		await key('Down', 7)
		await key('Enter')
		const editor = await requestSession(session, { operation: 'wait', text: 'Create profile' })
		assert.match(editor.screen, /Workspace/)
		assert.match(editor.screen, /Read & write/)
		assert.match(editor.screen, /Other host files/)
		assert.doesNotMatch(editor.screen, /Space Toggle/)
		await key('Enter')
		await requestSession(session, { operation: 'write', text: 'Offline tests' })
		await key('Enter')
		await key('Down', 3)
		await key('Left')
		const offline = await requestSession(session, { operation: 'screen' })
		assert.match(offline.screen, /Network\s+◉ Blocked\s+○ Allowed/)
		await key('Down', 4)
		await key('Enter')
		const saved = await requestSession(session, { operation: 'wait', text: 'Edit Offline tests' })
		assert.match(saved.screen, /Main agent: Default \(unrestricted\)/)
		assert.match(saved.screen, /Subagents: Default \(unrestricted\)/)
	} finally {
		await requestSession(session, { operation: 'stop' })
	}
})
