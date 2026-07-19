/**
 * Remote profile feed. `getLatestProfile` is what the extension polls;
 * `publishProfile` is invoked from the Convex dashboard to push a fixed
 * selector/RPC profile without a Web Store release.
 *
 * Generic function builders (not ./_generated) so this typechecks before the
 * first `bunx convex dev|deploy` writes codegen output.
 */
import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server'
import { v } from 'convex/values'

const selectorsValidator = v.object({
  id: v.string(),
  addSourceTriggers: v.array(v.string()),
  copiedTextChoices: v.array(v.string()),
  titleInputs: v.array(v.string()),
  textInputs: v.array(v.string()),
  submitButtons: v.array(v.string()),
  sourceListSignals: v.array(v.string()),
})

export const getLatestProfile = query({
  args: {},
  handler: async (ctx) => {
    const latest = await ctx.db
      .query('profiles')
      .withIndex('by_publishedAt')
      .order('desc')
      .first()
    if (latest === null) return null
    const { _id, _creationTime, ...profile } = latest
    return profile
  },
})

export const publishProfile = mutation({
  args: {
    schemaVersion: v.number(),
    publishedAt: v.string(),
    minExtensionVersion: v.string(),
    selectors: v.optional(selectorsValidator),
    rpcOverrides: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => ctx.db.insert('profiles', args),
})
