// Fetch probe — injected into the browser by Fisgon.
// __FISGON_EMIT__ is defined by the WebSocket bootstrap (see ws-bootstrap.js).
;(function () {
	const patterns = __FISGON_FETCH_PATTERNS__

	function matchesAny(pathname, pats) {
		for (let i = 0; i < pats.length; i++) {
			if (matchGlob(pathname, pats[i])) return true
		}
		return false
	}

	function matchGlob(str, pattern) {
		const regex = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*/g, '__DOUBLESTAR__')
			.replace(/\*/g, '[^/]*')
			.replace(/__DOUBLESTAR__/g, '.*')
			.replace(/\?/g, '.')
		return new RegExp('^' + regex + '$').test(str)
	}

	const originalFetch = window.fetch
	window.fetch = async function (input, init) {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof Request
					? input.url
					: String(input),
			location.origin,
		)

		if (!matchesAny(url.pathname + url.search, patterns)) {
			return originalFetch.call(this, input, init)
		}

		const method =
			(init && init.method) ||
			(input instanceof Request ? input.method : 'GET')
		const timestamp = Date.now()

		__FISGON_EMIT__({
			source: 'fetch',
			type: 'request',
			timestamp: timestamp,
			data: { url: url.pathname + url.search, method: method },
		})

		const response = await originalFetch.call(this, input, init)

		__FISGON_EMIT__({
			source: 'fetch',
			type: 'response',
			timestamp: Date.now(),
			data: { url: url.pathname + url.search, status: response.status },
		})

		return response
	}
})()
