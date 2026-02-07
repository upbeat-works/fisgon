// Action scanner — runs on-demand in the browser when `fisgon actions` is called.
// Not a continuous probe — scans once, injects data-fisgon attrs, returns Action[].
;(function () {
	const actions = []
	let counter = 0

	// Clear previous data-fisgon attributes
	document
		.querySelectorAll('[data-fisgon]')
		.forEach((el) => el.removeAttribute('data-fisgon'))

	const elements = document.querySelectorAll(
		'form, a[href], button, input[type="submit"]',
	)

	for (const el of elements) {
		// Skip hidden elements (except forms which may be invisible wrappers)
		if (el.offsetParent === null && el.tagName !== 'FORM') continue

		const id = 'f' + (++counter).toString(36)
		el.setAttribute('data-fisgon', id)

		let elementType = el.tagName.toLowerCase()
		if (elementType === 'input') elementType = 'button'

		const textContent = (el.textContent || '')
			.trim()
			.replace(/\s+/g, ' ')
			.slice(0, 200)

		actions.push({ id, elementType, textContent })
	}

	return actions
})()
