// Events whose GITHUB_REF is the branch the run checked out. On others, such as pull_request_target or workflow_run,
// GITHUB_REF is the default branch while the files can come from elsewhere, so they never sync for real.
const REAL_SYNC_EVENTS = [ 'push', 'schedule', 'workflow_dispatch' ]

// Why a run that asked to sync for real must stay a dry run, or undefined when it may push. Only a push, scheduled
// or manual run on the repository's default branch may, so a run from an unreviewed branch can't change the targets.
export function realSyncBlocker({ ref, eventName, defaultBranch }) {
	if (!defaultBranch) {
		return `the ${ eventName } event doesn't name the repository's default branch`
	}

	if (ref !== `refs/heads/${ defaultBranch }`) {
		return `it runs on ${ ref || 'no ref' }, not refs/heads/${ defaultBranch }`
	}

	if (!REAL_SYNC_EVENTS.includes(eventName)) {
		return `it was triggered by ${ eventName }`
	}

	return undefined
}
