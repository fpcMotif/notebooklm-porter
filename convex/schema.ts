/**
 * Convex schema for NotebookLM Porter's optional cloud tier. Deployed with
 * `bunx convex deploy` against the deployment whose URL goes into the
 * extension's Convex settings field. Two independent tables:
 *
 * - profiles: dashboard-published Tier-B selector / RPC-id profiles the
 *   extension polls (src/core/ingest/remote-profile-loader.ts).
 * - kv: the mirrored extension Kv store, namespaced by per-install id
 *   (src/core/fx/kv-mirror.ts) — no accounts/auth in this iteration.
 */
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  profiles: defineTable({
    schemaVersion: v.number(),
    publishedAt: v.string(),
    minExtensionVersion: v.string(),
    selectors: v.optional(
      v.object({
        id: v.string(),
        addSourceTriggers: v.array(v.string()),
        copiedTextChoices: v.array(v.string()),
        titleInputs: v.array(v.string()),
        textInputs: v.array(v.string()),
        submitButtons: v.array(v.string()),
        sourceListSignals: v.array(v.string()),
      }),
    ),
    rpcOverrides: v.optional(v.record(v.string(), v.string())),
  }).index('by_publishedAt', ['publishedAt']),

  kv: defineTable({
    installId: v.string(),
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index('by_install_key', ['installId', 'key']),
})
