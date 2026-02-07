// Navigation probe — injected into the browser by Fisgon.
// Listens to History API pushState/replaceState and popstate events.
// __FISGON_EMIT__ is defined by the WebSocket bootstrap (see ws-bootstrap.js).
;(function () {
	const originalPushState = history.pushState
	const originalReplaceState = history.replaceState

	history.pushState = function (...args) {
		const result = originalPushState.apply(this, args)
		__FISGON_EMIT__({
			source: 'nav',
			type: 'navigate',
			timestamp: Date.now(),
			data: {
				url: location.pathname + location.search,
				method: 'pushState',
			},
		})
		return result
	}

	history.replaceState = function (...args) {
		const result = originalReplaceState.apply(this, args)
		__FISGON_EMIT__({
			source: 'nav',
			type: 'navigate',
			timestamp: Date.now(),
			data: {
				url: location.pathname + location.search,
				method: 'replaceState',
			},
		})
		return result
	}

	window.addEventListener('popstate', function () {
		__FISGON_EMIT__({
			source: 'nav',
			type: 'navigate',
			timestamp: Date.now(),
			data: {
				url: location.pathname + location.search,
				method: 'popstate',
			},
		})
	})

	// Emit initial page load
	__FISGON_EMIT__({
		source: 'nav',
		type: 'load',
		timestamp: Date.now(),
		data: { url: location.pathname + location.search },
	})
})()
