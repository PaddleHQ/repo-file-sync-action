import * as core from '@actions/core'
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils.js'
import { throttling } from '@octokit/plugin-throttling'
import { retry } from '@octokit/plugin-retry'

export function throttleShouldRetry(retryCount, maxRetries) {
	return retryCount < maxRetries
}

export function createGithubClient({ token, baseUrl, maxRetries }) {
	const Octokit = GitHub.plugin(throttling, retry)

	const options = getOctokitOptions(token, {
		baseUrl: baseUrl || 'https://api.github.com',
		retry: {
			retries: maxRetries
		},
		throttle: {
			onRateLimit: (retryAfter, _options, _octokit, retryCount) => {
				core.debug(`Hit GitHub API rate limit, retrying after ${ retryAfter }s (attempt ${ retryCount })`)
				return throttleShouldRetry(retryCount, maxRetries)
			},
			onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) => {
				core.debug(`Hit secondary GitHub API rate limit, retrying after ${ retryAfter }s (attempt ${ retryCount })`)
				return throttleShouldRetry(retryCount, maxRetries)
			}
		}
	})

	const octokit = new Octokit(options)

	return {
		rest: octokit.rest,
		graphql: octokit.graphql
	}
}
