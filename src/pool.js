export async function runPool(items, limit, worker) {
	const results = new Array(items.length)
	const width = Math.max(1, Math.min(limit || 1, items.length))
	let next = 0

	const runner = async () => {
		while (true) {
			const index = next++
			if (index >= items.length) return
			results[index] = await worker(items[index], index)
		}
	}

	await Promise.all(Array.from({ length: width }, runner))
	return results
}
