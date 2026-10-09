import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repoWorkingDir } from './helpers.js'

describe('repoWorkingDir', () => {
	const uniqueName = 'github.com/PaddleHQ/repo-file-sync-action@default'

	it('uses the plain unique name when there is no branch suffix', () => {
		assert.equal(repoWorkingDir('tmp', uniqueName, ''), `tmp/${ uniqueName }`)
		assert.equal(repoWorkingDir('tmp', uniqueName, undefined), `tmp/${ uniqueName }`)
	})

	it('appends a suffix so same-repo items get distinct dirs', () => {
		assert.equal(repoWorkingDir('tmp', uniqueName, 'a'), `tmp/${ uniqueName }~a`)
		assert.notEqual(repoWorkingDir('tmp', uniqueName, 'a'), repoWorkingDir('tmp', uniqueName, 'b'))
	})

	it('keeps suffixed dirs as siblings, never nested', () => {
		const plain = repoWorkingDir('tmp', uniqueName, '')
		const suffixed = repoWorkingDir('tmp', uniqueName, 'a')
		assert.equal(suffixed.startsWith(`${ plain }/`), false)
	})
})
