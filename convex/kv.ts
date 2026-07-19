/**
 * Cloud side of the mirrored Kv layer (src/core/fx/kv-mirror.ts). Rows are
 * namespaced by per-install id; `kvUpsert` takes the extension's debounced
 * batch and applies last-writer-wins per key by client `updatedAt`, so a
 * delayed retry can never clobber a newer mirror write. A mutation runs as
 * one transaction, so the per-row upserts below cannot race each other.
 */
import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server'
import { v, type GenericId } from 'convex/values'
import type { GenericDatabaseReader, GenericDataModel } from 'convex/server'

function rowFor(db: GenericDatabaseReader<GenericDataModel>, installId: string, key: string) {
  return db
    .query('kv')
    .withIndex('by_install_key', (q) => q.eq('installId', installId))
    .filter((q) => q.eq(q.field('key'), key))
    .unique()
}

export const kvGet = query({
  args: { installId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const row = await rowFor(ctx.db, args.installId, args.key)
    return row?.value ?? null
  },
})

export const kvUpsert = mutation({
  args: {
    installId: v.string(),
    rows: v.array(v.object({ key: v.string(), value: v.any(), updatedAt: v.number() })),
  },
  handler: async (ctx, args) => {
    await Promise.all(
      args.rows.map(async (row) => {
        const existing = await rowFor(ctx.db, args.installId, row.key)
        if (existing === null) {
          await ctx.db.insert('kv', { installId: args.installId, ...row })
          return
        }
        const id = existing._id
        const prev =
          typeof existing.updatedAt === 'number' ? existing.updatedAt : Number.NEGATIVE_INFINITY
        // Documented cast: the generic (pre-codegen) model types _id as Value.
        if (typeof id === 'string' && row.updatedAt >= prev) {
          await ctx.db.patch(id as GenericId<'kv'>, { value: row.value, updatedAt: row.updatedAt })
        }
      }),
    )
    return null
  },
})
