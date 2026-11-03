import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { throttleShouldRetry } from './github-client.js'

describe('throttleShouldRetry', () => {
	it('retries while under the max', () => {
		assert.equal(throttleShouldRetry(0, 3), true)
		assert.equal(throttleShouldRetry(2, 3), true)
	})
	it('stops at the max so rate-limit retries are bounded', () => {
		assert.equal(throttleShouldRetry(3, 3), false)
		assert.equal(throttleShouldRetry(4, 3), false)
	})
})
