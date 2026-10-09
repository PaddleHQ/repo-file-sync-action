import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Octokit's HttpError.message appends the docs URL, so the "branch already exists"
// handling in createGithubVerifiedCommits() must use .includes(), not exact equality.

describe('createGithubVerifiedCommits - Reference already exists error handling', () => {
	const githubApiErrorResponse = {
		name: 'HttpError',
		status: 422,
		response: {
			url: 'https://api.github.com/repos/PaddleHQ/paddle-openapi-internal/git/refs',
			status: 422,
			headers: {},
			data: {
				message: 'Reference already exists',
				documentation_url: 'https://docs.github.com/rest/git/refs#create-a-reference',
				status: '422'
			}
		},
		request: {
			method: 'POST',
			url: 'https://api.github.com/repos/PaddleHQ/paddle-openapi-internal/git/refs'
		}
	}

	function createOctokitHttpError(response) {
		const error = new Error(
			`${ response.response.data.message } - ${ response.response.data.documentation_url }`
		)
		error.name = response.name
		error.status = response.status
		error.response = response.response
		error.request = response.request
		return error
	}

	it('exact-equality check throws on the real message', () => {
		const mockError = createOctokitHttpError(githubApiErrorResponse)
		const currentCheck = (error) => {
			if (error.message !== 'Reference already exists') throw error
		}
		assert.throws(() => currentCheck(mockError))
		assert.equal(mockError.message, 'Reference already exists - https://docs.github.com/rest/git/refs#create-a-reference')
		assert.notEqual(mockError.message, 'Reference already exists')
	})

	it('includes() check catches the error', () => {
		const mockError = createOctokitHttpError(githubApiErrorResponse)
		const fixedCheck = (error) => {
			if (!error.message.includes('Reference already exists')) throw error
		}
		assert.doesNotThrow(() => fixedCheck(mockError))
	})

	it('nested response.data.message is exact', () => {
		const mockError = createOctokitHttpError(githubApiErrorResponse)
		const alternativeCheck = (error) => {
			if (error.response?.data?.message !== 'Reference already exists') throw error
		}
		assert.doesNotThrow(() => alternativeCheck(mockError))
		assert.equal(mockError.response.data.message, 'Reference already exists')
	})

	it('status code is 422', () => {
		const mockError = createOctokitHttpError(githubApiErrorResponse)
		const statusCheck = (error) => {
			if (error.status !== 422) throw error
		}
		assert.doesNotThrow(() => statusCheck(mockError))
		assert.equal(mockError.status, 422)
	})

	it('still throws for genuinely different errors', () => {
		const differentError = new Error('Resource not accessible by integration')
		differentError.status = 403
		const fixedCheck = (error) => {
			if (!error.message.includes('Reference already exists')) throw error
		}
		assert.throws(() => fixedCheck(differentError), /Resource not accessible by integration/)
	})
})
