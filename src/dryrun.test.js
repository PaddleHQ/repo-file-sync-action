import { test } from 'node:test'
import assert from 'node:assert/strict'

import { realSyncBlocker } from './dryrun.js'

const onMain = { ref: 'refs/heads/main', defaultBranch: 'main' }

test('a push, scheduled or manual run on the default branch may sync', () => {
	for (const eventName of [ 'push', 'schedule', 'workflow_dispatch' ]) {
		assert.equal(realSyncBlocker({ ...onMain, eventName }), undefined, eventName)
	}
})

test('a default branch other than main is read from the event', () => {
	assert.equal(realSyncBlocker({ ref: 'refs/heads/master', defaultBranch: 'master', eventName: 'push' }), undefined)
})

test('a manual run from another branch stays a dry run', () => {
	assert.equal(
		realSyncBlocker({ ref: 'refs/heads/feature', defaultBranch: 'main', eventName: 'workflow_dispatch' }),
		'it runs on refs/heads/feature, not refs/heads/main'
	)
})

test('a run on a tag stays a dry run', () => {
	assert.match(realSyncBlocker({ ref: 'refs/tags/v1.0.0', defaultBranch: 'main', eventName: 'push' }), /refs\/tags\/v1\.0\.0/)
})

test('a pull request stays a dry run', () => {
	assert.match(realSyncBlocker({ ref: 'refs/pull/1/merge', defaultBranch: 'main', eventName: 'pull_request' }), /refs\/pull\/1\/merge/)
})

test('pull_request_target stays a dry run, though its ref is the default branch', () => {
	assert.equal(
		realSyncBlocker({ ...onMain, eventName: 'pull_request_target' }),
		'it was triggered by pull_request_target'
	)
})

test('a run with no ref stays a dry run', () => {
	assert.equal(realSyncBlocker({ ref: undefined, defaultBranch: 'main', eventName: 'push' }), 'it runs on no ref, not refs/heads/main')
})

test('an event without the default branch stays a dry run', () => {
	assert.equal(
		realSyncBlocker({ ref: 'refs/heads/main', defaultBranch: undefined, eventName: 'repository_dispatch' }),
		'the repository_dispatch event doesn\'t name the repository\'s default branch'
	)
})
