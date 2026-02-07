import  { type ScopedProbe } from '../core/types.js'

type DrizzleDb = {
  insert(table: unknown): { values(...args: unknown[]): unknown }
  update(table: unknown): { set(...args: unknown[]): unknown }
  delete(table: unknown): { where(...args: unknown[]): unknown }
  select(...args: unknown[]): unknown
  [key: string]: unknown
}

// Extracts a table name from a Drizzle table object.
// Drizzle tables have a Symbol-keyed property or a `_.name` property.
function getTableName(table: unknown): string {
  if (table && typeof table === 'object') {
    const t = table as Record<string, unknown>
    // Drizzle v0.30+ uses _.name
    if (t._ && typeof t._ === 'object' && 'name' in (t._ as object)) {
      return String((t._ as { name: unknown }).name)
    }
    // Fallback: try Symbol.for('drizzle:Name')
    const sym = Symbol.for('drizzle:Name')
    if (sym in t) return String(t[sym])
  }
  return 'unknown'
}

export function drizzleAdapter<T extends DrizzleDb>(db: T, scoped: ScopedProbe): T {
  if (!scoped.active) return db

  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (prop === 'insert' && typeof value === 'function') {
        return (table: unknown) => {
          const tableName = getTableName(table)
          const result = value.call(target, table)
          return wrapChain(result, 'insert', tableName, scoped)
        }
      }

      if (prop === 'update' && typeof value === 'function') {
        return (table: unknown) => {
          const tableName = getTableName(table)
          const result = value.call(target, table)
          return wrapChain(result, 'update', tableName, scoped)
        }
      }

      if (prop === 'delete' && typeof value === 'function') {
        return (table: unknown) => {
          const tableName = getTableName(table)
          const result = value.call(target, table)
          return wrapChain(result, 'delete', tableName, scoped)
        }
      }

      if (prop === 'select' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = value.apply(target, args)
          return wrapChain(result, 'select', 'query', scoped)
        }
      }

      return value
    },
  })
}

function wrapChain(obj: unknown, operation: string, tableName: string, scoped: ScopedProbe): unknown {
  if (!obj || typeof obj !== 'object') return obj

  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = value.apply(target, args)

          // If the result is a thenable (query execution), emit the event
          if (result && typeof result === 'object' && 'then' in result) {
            scoped.emit({
              source: 'sql',
              type: operation,
              timestamp: Date.now(),
              data: { table: tableName },
            })
          }

          // Continue wrapping for chaining
          if (result && typeof result === 'object') {
            return wrapChain(result, operation, tableName, scoped)
          }

          return result
        }
      }

      return value
    },
  })
}
