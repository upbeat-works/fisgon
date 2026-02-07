import  { type ScopedProbe } from '../core/types.js'

type PrismaClient = {
  $use?(middleware: (params: PrismaMiddlewareParams, next: (params: PrismaMiddlewareParams) => Promise<unknown>) => Promise<unknown>): void
  $extends?(extension: unknown): unknown
  [key: string]: unknown
}

type PrismaMiddlewareParams = {
  model?: string
  action: string
  args: unknown
  dataPath: string[]
  runInTransaction: boolean
}

export function prismaAdapter<T extends PrismaClient>(client: T, scoped: ScopedProbe): T {
  if (!scoped.active) return client

  // Use Prisma middleware ($use) if available
  if (typeof client.$use === 'function') {
    client.$use(async (params, next) => {
      const timestamp = Date.now()

      scoped.emit({
        source: 'sql',
        type: mapPrismaAction(params.action),
        timestamp,
        data: {
          table: params.model ?? 'unknown',
          action: params.action,
        },
      })

      return next(params)
    })

    return client
  }

  // Fallback: use $extends (Prisma 5+)
  if (typeof client.$extends === 'function') {
    return client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }: {
            model: string
            operation: string
            args: unknown
            query: (args: unknown) => Promise<unknown>
          }) {
            scoped.emit({
              source: 'sql',
              type: mapPrismaAction(operation),
              timestamp: Date.now(),
              data: {
                table: model,
                action: operation,
              },
            })

            return query(args)
          },
        },
      },
    }) as T
  }

  return client
}

function mapPrismaAction(action: string): string {
  switch (action) {
    case 'create':
    case 'createMany':
      return 'insert'
    case 'update':
    case 'updateMany':
    case 'upsert':
      return 'update'
    case 'delete':
    case 'deleteMany':
      return 'delete'
    case 'findFirst':
    case 'findMany':
    case 'findUnique':
    case 'findFirstOrThrow':
    case 'findUniqueOrThrow':
    case 'count':
    case 'aggregate':
    case 'groupBy':
      return 'select'
    default:
      return action
  }
}
