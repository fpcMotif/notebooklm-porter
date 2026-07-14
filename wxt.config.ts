import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { allHostPermissions } from './src/core/adapters/registry'

/**
 * NotebookLM's own origin — the ingest-assist content script runs there,
 * and it is a host permission even though it's not a capture adapter.
 */
const NOTEBOOKLM_HOST = 'https://notebooklm.google.com/*'

/** Drive backup (design §2) uploads via the SW — a host permission is what makes that fetch CORS-exempt. */
const DRIVE_HOST = 'https://www.googleapis.com/*'

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
  manifest: {
    name: 'NotebookLM Porter',
    description:
      'Port YouTube playlists and web threads (X, Hacker News, Reddit) into NotebookLM as clean, structured sources.',
    // `storage` holds the capture queue; `downloads` powers Markdown/JSONL
    // export; `unlimitedStorage` because a single long thread can exceed
    // the 10MB storage.local quota once a few captures accumulate;
    // `clipboardWrite` backs the copy-as-markdown fallback ingest path;
    // `identity` backs the Drive backup OAuth flow (design §2); `alarms`
    // wakes the MV3 worker to resume durable ingest work.
    permissions: [
      'storage',
      'downloads',
      'unlimitedStorage',
      'clipboardWrite',
      'identity',
      'alarms',
      'contextMenus',
      'activeTab',
      'scripting',
    ],
    host_permissions: [...allHostPermissions(), NOTEBOOKLM_HOST, DRIVE_HOST],
  },
})
