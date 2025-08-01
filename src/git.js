import { parse } from '@putout/git-status-porcelain'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils.js'
import { throttling } from '@octokit/plugin-throttling'
import * as path from 'path'

import config from './config.js'

const {
	GITHUB_TOKEN,
	GITHUB_SERVER_URL,
	IS_INSTALLATION_TOKEN,
	IS_FINE_GRAINED,
	GIT_USERNAME,
	GIT_EMAIL,
	TMP_DIR,
	COMMIT_BODY,
	COMMIT_PREFIX,
	GITHUB_REPOSITORY,
	OVERWRITE_EXISTING_PR,
	SKIP_PR,
	PR_BODY,
	BRANCH_PREFIX,
	FORK
} = config

import { dedent, execCmd } from './helpers.js'

export default class Git {
	constructor() {
		const Octokit = GitHub.plugin(throttling)

		const options = getOctokitOptions(GITHUB_TOKEN, {
			baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
			throttle: {
				onRateLimit: (retryAfter) => {
					core.debug(`Hit GitHub API rate limit, retrying after ${ retryAfter }s`)
					return true
				},
				onSecondaryRateLimit: (retryAfter) => {
					core.debug(`Hit secondary GitHub API rate limit, retrying after ${ retryAfter }s`)
					return true
				}
			}
		})

		const octokit = new Octokit(options)

		// We only need the rest client
		this.github = octokit.rest
	}

	async initRepo(repo) {
		// Reset repo specific values
		this.existingPr = undefined
		this.prBranch = undefined
		this.baseBranch = undefined

		// Set values to current repo
		this.repo = repo
		this.workingDir = path.join(TMP_DIR, repo.uniqueName)
		this.gitUrl = `https://${ IS_INSTALLATION_TOKEN ? 'x-access-token:' : '' }${ IS_FINE_GRAINED ? 'oauth:' : '' }${ GITHUB_TOKEN }@${ repo.fullName }.git`

		await this.clone()
		await this.setIdentity()
		await this.getBaseBranch()
		await this.getLastCommitSha()

		if (FORK) {
			const forkUrl = new URL(GITHUB_SERVER_URL)
			forkUrl.username = GITHUB_TOKEN
			forkUrl.pathname = `${ FORK }/${ this.repo.name }.git`
			await this.createFork()
			await this.createRemote(forkUrl.toString())

		}
	}

	async createFork() {
		core.debug(`Creating fork with OWNER: ${ this.repo.user } and REPO: ${ this.repo.name }`)
		await this.github.repos.createFork({
			owner: this.repo.user,
			repo: this.repo.name
		})
	}

	async createRemote(forkUrl) {
		return execCmd(
			`git remote add fork ${ forkUrl }`,
			this.workingDir
		)
	}

	async clone() {
		core.debug(`Cloning ${ this.repo.fullName } into ${ this.workingDir }`)

		return execCmd(
			`git clone --depth 1 ${ this.repo.branch !== 'default' ? '--branch "' + this.repo.branch + '"' : '' } ${ this.gitUrl } ${ this.workingDir }`
		)
	}

	async setIdentity() {
		let username = GIT_USERNAME
		let email = GIT_EMAIL

		if (email === undefined) {
			if (!IS_INSTALLATION_TOKEN) {
				const { data } = await this.github.users.getAuthenticated()
				email = data.email
				username = data.login
			}
		}

		core.debug(`Setting git user to email: ${ email }, username: ${ username }`)

		return execCmd(
			`git config --local user.name "${ username }" && git config --local user.email "${ email }"`,
			this.workingDir
		)
	}

	async getBaseBranch() {
		this.baseBranch = await execCmd(
			`git rev-parse --abbrev-ref HEAD`,
			this.workingDir
		)
	}

	async createPrBranch(branchSuffix) {
		const prefix = BRANCH_PREFIX.replace('SOURCE_REPO_NAME', GITHUB_REPOSITORY.split('/')[1])

		let newBranch = path.join(prefix, this.repo.branch).replace(/\\/g, '/').replace(/\/\./g, '/')
		this.prBranch = newBranch

		newBranch += branchSuffix ? `-${ branchSuffix }` : ''

		if (OVERWRITE_EXISTING_PR === false) {
			newBranch += `-${ Math.round((new Date()).getTime() / 1000) }`
			this.prBranch = newBranch

			core.debug(`Creating PR Branch ${ newBranch }`)

			await execCmd(
				`git switch -b "${ newBranch }"`,
				this.workingDir
			)

			return
		}

		core.debug(`Switch/Create PR Branch ${ newBranch }`)

		await execCmd(
			`git remote set-branches origin '*'`,
			this.workingDir
		)

		await execCmd(
			`git fetch -v --depth=1`,
			this.workingDir
		)

		await execCmd(
			`git switch "${ newBranch }" 2>/dev/null || git switch -c "${ newBranch }"`,
			this.workingDir
		)

		await this.getLastCommitSha()

	}

	async add(file) {
		return execCmd(
			`git add -f "${ file }"`,
			this.workingDir
		)
	}

	async remove(file) {
		return execCmd(
			`git rm -f "${ file }"`,
			this.workingDir
		)
	}

	isOneCommitPush() {
		return github.context.eventName === 'push' && github.context.payload.commits.length === 1
	}

	originalCommitMessage() {
		return github.context.payload.commits[0].message
	}

	parseGitDiffOutput(string) { // parses git diff output and returns a dictionary mapping the file path to the diff output for this file
		// split diff into separate entries for separate files. \ndiff --git should be a reliable way to detect the separation, as content of files is always indented
		return `\n${ string }`.split('\ndiff --git').slice(1).reduce((resultDict, fileDiff) => {
			const lines = fileDiff.split('\n')
			const lastHeaderLineIndex = lines.findIndex((line) => line.startsWith('+++'))
			if (lastHeaderLineIndex === -1) return resultDict // ignore binary files

			const plainDiff = lines.slice(lastHeaderLineIndex + 1).join('\n').trim()
			let filePath = ''
			if (lines[lastHeaderLineIndex].startsWith('+++ b/')) { // every file except removed files
				filePath = lines[lastHeaderLineIndex].slice(6) // remove '+++ b/'
			} else { // for removed file need to use header line with filename before deletion
				filePath = lines[lastHeaderLineIndex - 1].slice(6) // remove '--- a/'
			}
			return { ...resultDict, [filePath]: plainDiff }
		}, {})
	}

	async getChangesFromLastCommit(source) { // gets array of git diffs for the source, which either can be a file or a dict
		if (this.lastCommitChanges === undefined) {
			const diff = await this.github.repos.compareCommits({
				mediaType: {
					format: 'diff'
				},
				owner: github.context.payload.repository.owner.name,
				repo: github.context.payload.repository.name,
				base: github.context.payload.before,
				head: github.context.payload.after
			})
			this.lastCommitChanges = this.parseGitDiffOutput(diff.data)
		}
		if (source.endsWith('/')) {
			return Object.keys(this.lastCommitChanges).filter((filePath) => filePath.startsWith(source)).reduce((result, key) => [ ...result, this.lastCommitChanges[key] ], [])
		} else {
			return this.lastCommitChanges[source] === undefined ? [] : [ this.lastCommitChanges[source] ]
		}
	}

	async getLastCommitSha() {
		this.lastCommitSha = await execCmd(
			`git rev-parse HEAD`,
			this.workingDir
		)
	}

	async changes(destination) { // gets array of git diffs for the destination, which either can be a file or a dict
		const output = await execCmd(
			`git diff HEAD ${ destination }`,
			this.workingDir
		)
		return Object.values(this.parseGitDiffOutput(output))
	}

	async hasChanges() {
		const statusOutput = await execCmd(
			`git status --porcelain`,
			this.workingDir
		)

		return parse(statusOutput).length !== 0
	}

	async commit(msg) {
		let message = msg !== undefined ? msg : `${ COMMIT_PREFIX } synced file(s) with ${ GITHUB_REPOSITORY }`
		if (COMMIT_BODY) {
			message += `\n\n${ COMMIT_BODY }`
		}
		return execCmd(
			`git commit -m '${ message.replace(/'/g, '\'\\\'\'') }'`,
			this.workingDir
		)
	}

	// Returns a git tree parsed for the specified commit sha
	async getTreeId(commitSha) {
		core.debug(`Getting treeId for commit ${ commitSha }`)
		const output = (await execCmd(
			`git cat-file -p ${ commitSha }`,
			this.workingDir
		)).split('\n')

		const commitHeaders = output.slice(0, output.findIndex((e) => e === ''))
		const tree = commitHeaders.find((e) => e.startsWith('tree')).replace('tree ', '')

		return tree
	}

	async getTreeDiff(referenceTreeId, differenceTreeId) {
		const output = await execCmd(
			`git diff-tree ${ referenceTreeId } ${ differenceTreeId } -r`,
			this.workingDir
		)

		const diff = []
		for (const line of output.split('\n')) {
			const splitted = line
				.replace(/^:/, '')
				.replace('\t', ' ')
				.split(' ')

			const [
				newMode,
				previousMode,
				newBlob,
				previousBlob,
				change,
				path
			] = splitted

			diff.push({
				newMode,
				previousMode,
				newBlob,
				previousBlob,
				change,
				path
			})
		}

		return diff
	}

	// Creates the blob objects in GitHub for the files that are not in the previous commit only
	async uploadGitHubBlob(blob) {
		core.debug(`Uploading GitHub Blob for blob ${ blob }`)
		const fileContent = await execCmd(
			`git cat-file -p ${ blob }`,
			this.workingDir,
			false
		)

		// Creates the blob. We don't need to store the response because the local sha is the same and we can use it to reference the blob
		return this.github.git.createBlob({
			owner: this.repo.user,
			repo: this.repo.name,
			content: Buffer.from(fileContent).toString('base64'),
			encoding: 'base64'
		})
	}

	// Gets the commit list in chronological order
	async getCommitsToPush() {
		const output = await execCmd(
			`git log --format=%H --reverse ${ this.lastCommitSha }..HEAD`,
			this.workingDir
		)

		const commits = output.split('\n')
		return commits
	}

	async getCommitMessage(commitSha) {
		return await execCmd(
			`git log -1 --format=%B ${ commitSha }`,
			this.workingDir
		)
	}

	// A wrapper for running all the flow to generate all the pending commits using the GitHub API
	async createGithubVerifiedCommits() {
		core.debug(`Creating commits using GitHub API`)
		const commits = await this.getCommitsToPush()

		if (SKIP_PR === false) {
			// Creates the PR branch if doesn't exists
			try {
				await this.github.git.createRef({
					owner: this.repo.user,
					repo: this.repo.name,
					sha: this.lastCommitSha,
					ref: 'refs/heads/' + this.prBranch
				})

				core.debug(`Created new branch ${ this.prBranch }`)
			} catch (error) {
				// If the branch exists ignores the error
				if (error.message !== 'Reference already exists') throw error

				core.debug(`Branch ${ this.prBranch } already exists`)
			}
		}

		for (const commit of commits) {
			await this.createGithubCommit(commit)
		}

		core.debug(`Updating branch ${ SKIP_PR === false ? this.prBranch : this.baseBranch } ref`)
		await this.github.git.updateRef({
			owner: this.repo.user,
			repo: this.repo.name,
			ref: `heads/${ SKIP_PR === false ? this.prBranch : this.baseBranch }`,
			sha: this.lastCommitSha,
			force: true
		})
		core.debug(`Commit using GitHub API completed`)
	}

	async status() {
		return execCmd(
			`git status`,
			this.workingDir
		)
	}

	async push() {
		if (FORK) {
			return execCmd(
				`git push -u fork ${ this.prBranch } --force-with-lease`,
				this.workingDir
			)
		}
		if (IS_INSTALLATION_TOKEN) {
			return await this.createGithubVerifiedCommits()
		}
		return execCmd(
			`git push ${ this.gitUrl } --force-with-lease`,
			this.workingDir
		)
	}

	async findExistingPr() {
		const { data } = await this.github.pulls.list({
			owner: this.repo.user,
			repo: this.repo.name,
			state: 'open',
			head: `${ FORK ? FORK : this.repo.user }:${ this.prBranch }`
		})

		this.existingPr = data[0]

		return this.existingPr
	}

	async setPrWarning() {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			body: dedent(`
				⚠️ This PR is being automatically resynced ⚠️

				${ this.existingPr.body }
			`)
		})
	}

	async removePrWarning() {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			body: this.existingPr.body.replace('⚠️ This PR is being automatically resynced ⚠️', '')
		})
	}

	async createOrUpdatePr(changedFiles, title) {
		const body = dedent(`
			synced local file(s) with [${ GITHUB_REPOSITORY }](${ GITHUB_SERVER_URL }/${ GITHUB_REPOSITORY }).

			${ PR_BODY }

			${ changedFiles }

			---

			This PR was created automatically by the [repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action) workflow run [#${ process.env.GITHUB_RUN_ID || 0 }](${ GITHUB_SERVER_URL }/${ GITHUB_REPOSITORY }/actions/runs/${ process.env.GITHUB_RUN_ID || 0 })
		`)

		if (this.existingPr) {
			core.info(`Updating existing PR`)

			const { data } = await this.github.pulls.update({
				owner: this.repo.user,
				repo: this.repo.name,
				title: `${ COMMIT_PREFIX } synced file(s) with ${ GITHUB_REPOSITORY }`,
				pull_number: this.existingPr.number,
				body: body
			})

			return data
		}

		core.info(`Creating new PR`)

		const { data } = await this.github.pulls.create({
			owner: this.repo.user,
			repo: this.repo.name,
			title: title === undefined ? `${ COMMIT_PREFIX } synced file(s) with ${ GITHUB_REPOSITORY }` : title,
			body: body,
			head: `${ FORK ? FORK : this.repo.user }:${ this.prBranch }`,
			base: this.baseBranch
		})

		this.existingPr = data

		return data
	}

	async addPrLabels(labels) {
		await this.github.issues.addLabels({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			labels: labels
		})
	}

	async addPrAssignees(assignees) {
		await this.github.issues.addAssignees({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			assignees: assignees
		})
	}

	async addPrReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			reviewers: reviewers
		})
	}

	async addPrTeamReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			team_reviewers: reviewers
		})
	}

	async createGithubCommit(commitSha) {
		const [ treeId, parentTreeId, commitMessage ] = await Promise.all([
			this.getTreeId(`${ commitSha }`),
			this.getTreeId(`${ commitSha }~1`),
			this.getCommitMessage(commitSha)
		])

		const treeDiff = await this.getTreeDiff(treeId, parentTreeId)
		core.debug(`Uploading the blobs to GitHub`)
		const blobsToCreate = treeDiff
			.filter((e) => e.newMode !== '000000') // Do not upload the blob if it is being removed

		await Promise.all(blobsToCreate.map((e) => this.uploadGitHubBlob(e.newBlob)))
		core.debug(`Creating a GitHub tree`)
		const tree = treeDiff.map((e) => {
			if (e.newMode === '000000') { // Set the sha to null to remove the file
				e.newMode = e.previousMode
				e.newBlob = null
			}

			const entry = {
				path: e.path,
				mode: e.newMode,
				type: 'blob',
				sha: e.newBlob
			}

			return entry
		})

		let treeSha
		try {
			const request = await this.github.git.createTree({
				owner: this.repo.user,
				repo: this.repo.name,
				tree,
				base_tree: parentTreeId
			})
			treeSha = request.data.sha
		} catch (error) {
			error.message = `Cannot create a new GitHub Tree: ${ error.message }`
			throw error
		}

		core.debug(`Creating a commit for the GitHub tree`)
		const request = await this.github.git.createCommit({
			owner: this.repo.user,
			repo: this.repo.name,
			message: commitMessage,
			parents: [ this.lastCommitSha ],
			tree: treeSha
		})
		this.lastCommitSha = request.data.sha
	}
}