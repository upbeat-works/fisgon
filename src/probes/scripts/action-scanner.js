// Action scanner — runs on-demand in the browser when `fisgon actions` is called.
// Not a continuous probe — scans once, injects data-fisgon attrs, returns Action[].
;(function () {
	const actions = []
	let counter = 0

	// Clear previous data-fisgon attributes
	document
		.querySelectorAll('[data-fisgon]')
		.forEach((el) => el.removeAttribute('data-fisgon'))

	const elements = document.querySelectorAll([
		// Standard interactive elements
		'form', 'a[href]', 'button', 'select', 'textarea', 'summary',
		'input:not([type="hidden"])',
		// Non-standard but common
		'[type="button"]', '[contenteditable]:not([contenteditable="false"])',
		// ARIA roles
		'[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
		'[role="option"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
		'[role="combobox"]', '[role="slider"]', '[role="spinbutton"]', '[role="treeitem"]',
		'[role="textbox"]', '[role="listbox"]', '[role="searchbox"]',
		// ARIA state attributes (imply interactivity)
		'[aria-haspopup]', '[aria-expanded]', '[aria-pressed]', '[aria-checked]', '[aria-selected]',
		// Keyboard-focusable
		'[tabindex]:not([tabindex="-1"])',
	].join(', '))

	const seen = new Set()

	for (const el of elements) {
		// Deduplicate — an element might match multiple selectors
		if (seen.has(el)) continue
		seen.add(el)

		// Skip truly hidden elements (except forms which may be invisible wrappers).
		// offsetParent is null for display:none BUT ALSO for position:fixed/sticky
		// ancestors (navbars, modals, headers), so check computed style instead.
		if (el.tagName !== 'FORM') {
			const style = getComputedStyle(el)
			if (style.display === 'none' || style.visibility === 'hidden') continue
		}

		const id = 'f' + (++counter).toString(36)
		el.setAttribute('data-fisgon', id)

		const tag = el.tagName.toLowerCase()
		let elementType = tag
		if (tag === 'input') elementType = 'button'
		const role = el.getAttribute('role')
		if (role) elementType = role

		const textContent = (el.textContent || '')
			.trim()
			.replace(/\s+/g, ' ')
			.slice(0, 200)

		actions.push({ id, elementType, textContent })
	}

	return actions
})()
