// Parses raw SQL strings to extract the operation type and table name.
// Handles quoted identifiers, common ORM patterns, and parameterized queries.

export type ParsedSQL = {
	operation: string // 'insert' | 'update' | 'delete' | 'select' | 'unknown'
	table: string
}

// Regex to match the first keyword and table name from common SQL patterns.
// Handles double-quoted, backtick-quoted, and unquoted identifiers.
const TABLE_NAME = /(?:"([^"]+)"|`([^`]+)`|(\w+))/

const PATTERNS: Array<{ re: RegExp; operation: string; tableGroup: number }> = [
	{
		re: new RegExp(
			`^\\s*INSERT\\s+INTO\\s+${TABLE_NAME.source}`,
			'i',
		),
		operation: 'insert',
		tableGroup: 1,
	},
	{
		re: new RegExp(
			`^\\s*UPDATE\\s+${TABLE_NAME.source}`,
			'i',
		),
		operation: 'update',
		tableGroup: 1,
	},
	{
		re: new RegExp(
			`^\\s*DELETE\\s+FROM\\s+${TABLE_NAME.source}`,
			'i',
		),
		operation: 'delete',
		tableGroup: 1,
	},
	{
		re: new RegExp(
			`^\\s*SELECT\\s+.+?\\s+FROM\\s+${TABLE_NAME.source}`,
			'is',
		),
		operation: 'select',
		tableGroup: 1,
	},
]

export function parseSQL(query: string): ParsedSQL {
	for (const { re, operation, tableGroup } of PATTERNS) {
		const match = query.match(re)
		if (match) {
			// The TABLE_NAME regex has 3 capture groups (double-quoted, backtick, unquoted).
			// They start at offset `tableGroup` within the overall match groups.
			const table =
				match[tableGroup] ?? match[tableGroup + 1] ?? match[tableGroup + 2] ?? 'unknown'
			return { operation, table }
		}
	}

	return { operation: 'unknown', table: 'unknown' }
}
