import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runPool } from './pool.js'

const deferred = () => {
	let resolve
	const promise = new Promise((r) => { resolve = r })
	return { promise, resolve }
}

describe('runPool', () => {
	it('preserves input order in results', async () => {
		const results = await runPool([ 1, 2, 3, 4 ], 2, async (n) => n * 10)
		assert.deepEqual(results, [ 10, 20, 30, 40 ])
	})

	it('passes the index to the worker', async () => {
		const results = await runPool([ 'a', 'b' ], 1, async (item, i) => `${ i }:${ item }`)
		assert.deepEqual(results, [ '0:a', '1:b' ])
	})

	it('never exceeds the concurrency limit', async () => {
		let inFlight = 0
		let maxInFlight = 0
		const gates = [ deferred(), deferred(), deferred(), deferred() ]
		const worker = async (i) => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await gates[i].promise
			inFlight--
			return i
		}
		const run = runPool([ 0, 1, 2, 3 ], 2, worker)
		await new Promise((r) => setTimeout(r, 0))
		assert.equal(maxInFlight, 2)
		gates.forEach((g) => g.resolve())
		await run
		assert.equal(maxInFlight, 2)
	})

	it('treats limit < 1 as sequential', async () => {
		let inFlight = 0
		let maxInFlight = 0
		const worker = async (n) => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise((r) => setTimeout(r, 1))
			inFlight--
			return n
		}
		await runPool([ 1, 2, 3 ], 0, worker)
		assert.equal(maxInFlight, 1)
	})
})
