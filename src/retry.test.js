import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRetryableError, withRetry } from './retry.js'

const noSleep = () => Promise.resolve()

describe('isRetryableError', () => {
	it('retries 5xx octokit errors', () => {
		assert.equal(isRetryableError({ status: 500 }), true)
		assert.equal(isRetryableError({ status: 503 }), true)
	})
	it('does not retry 4xx or rate-limit statuses', () => {
		assert.equal(isRetryableError({ status: 404 }), false)
		assert.equal(isRetryableError({ status: 422 }), false)
		assert.equal(isRetryableError({ status: 403 }), false)
		assert.equal(isRetryableError({ status: 429 }), false)
	})
	it('retries transient network/exec errors', () => {
		assert.equal(isRetryableError({ code: 'ECONNRESET' }), true)
		assert.equal(isRetryableError({ killed: true, signal: 'SIGTERM' }), true)
		assert.equal(isRetryableError({ message: 'fatal: unable to access ... Could not resolve host: github.com' }), true)
		assert.equal(isRetryableError({ message: 'RPC failed; curl 56 Recv failure: Connection reset' }), true)
	})
	it('does not retry a plain non-transient error', () => {
		assert.equal(isRetryableError({ message: 'nothing to commit' }), false)
	})
})

describe('withRetry', () => {
	it('returns the value on first success', async () => {
		let calls = 0
		const fn = async () => { calls++; return 'ok' }
		assert.equal(await withRetry(fn, { retries: 3, sleep: noSleep }), 'ok')
		assert.equal(calls, 1)
	})
	it('retries transient failures then succeeds', async () => {
		let calls = 0
		const fn = async () => { calls++; if (calls === 1) throw { status: 500 }; return 'ok' }
		assert.equal(await withRetry(fn, { retries: 3, sleep: noSleep }), 'ok')
		assert.equal(calls, 2)
	})
	it('gives up after `retries` extra attempts and rethrows', async () => {
		let calls = 0
		const err = { status: 500 }
		const fn = async () => { calls++; throw err }
		await assert.rejects(withRetry(fn, { retries: 2, sleep: noSleep }), (e) => e === err)
		assert.equal(calls, 3)
	})
	it('does not retry non-retryable errors', async () => {
		let calls = 0
		const err = { status: 404 }
		const fn = async () => { calls++; throw err }
		await assert.rejects(withRetry(fn, { retries: 3, sleep: noSleep }), (e) => e === err)
		assert.equal(calls, 1)
	})
	it('caps backoff at maxDelayMs and applies jitter via injected random', async () => {
		const delays = []
		const sleep = (ms) => { delays.push(ms); return Promise.resolve() }
		const fn = async () => { throw { status: 500 } }
		await assert.rejects(withRetry(fn, { retries: 5, baseDelayMs: 1000, maxDelayMs: 4000, sleep, random: () => 1 }))
		assert.deepEqual(delays, [ 1000, 2000, 4000, 4000, 4000 ])
	})
})
