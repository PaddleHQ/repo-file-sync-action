const TRANSIENT_MESSAGE_PATTERNS = [
	/could not resolve host/i,
	/connection reset/i,
	/connection timed out/i,
	/failed to connect/i,
	/rpc failed/i,
	/early eof/i,
	/the remote end hung up/i,
	/tls/i,
	/timed out/i,
	/etimedout/i,
	/econnreset/i,
	/eai_again/i
]

const TRANSIENT_CODES = new Set([ 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND' ])

// Rate limits (403/429) are owned by @octokit/plugin-throttling; 4xx are deterministic.
// Retry only server errors here, plus transient network/exec failures without an HTTP status.
export function isRetryableError(err) {
	if (err === undefined || err === null) return false

	if (typeof err.status === 'number') {
		return err.status >= 500 && err.status <= 599
	}

	if (err.killed === true) return true

	if (err.code !== undefined && TRANSIENT_CODES.has(err.code)) return true

	const message = typeof err.message === 'string' ? err.message : ''
	return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(message))
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry(fn, opts = {}) {
	const {
		retries = 3,
		isRetryable = isRetryableError,
		baseDelayMs = 500,
		maxDelayMs = 10000,
		sleep: sleepFn = sleep,
		random = Math.random
	} = opts

	let attempt = 0
	while (true) {
		try {
			return await fn()
		} catch (err) {
			if (attempt >= retries || !isRetryable(err)) throw err

			const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
			await sleepFn(capped * random())
			attempt++
		}
	}
}
