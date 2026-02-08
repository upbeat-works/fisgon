// WebSocket bootstrap — injected first, defines __FISGON_EMIT__.
;(function () {
	let ws = null
	const buffer = []
	let connected = false

	function connect() {
		ws = new WebSocket(__FISGON_WS_URL__)
		ws.onopen = function () {
			connected = true
			for (const event of buffer) {
				ws.send(JSON.stringify({ type: 'event', event: event }))
			}
			buffer.length = 0
		}
		ws.onclose = function () {
			connected = false
			setTimeout(connect, 1000)
		}
		ws.onerror = function () {
			connected = false
		}
	}

	window.__FISGON_EMIT__ = function (event) {
		event.sessionId = __FISGON_SESSION_ID__
		if (connected && ws && ws.readyState === 1) {
			ws.send(JSON.stringify({ type: 'event', event: event }))
		} else {
			buffer.push(event)
		}
	}

	connect()
})()
