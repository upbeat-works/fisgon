import { default as defaultConfig } from '@epic-web/config/eslint'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		files: ['**/*.ts'],
		rules: {
			'no-warning-comments': 'off',
		},
	},
	{
		ignores: ['dist/*', 'node_modules/*', '.wrangler/*', 'src/probes/scripts/*'],
	},
]
