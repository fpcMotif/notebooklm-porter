import type { PorterSettings } from '../core/settings'

interface AccountPickerProps {
  settings: PorterSettings
  switchingAccount: boolean
  busy: boolean
  onSelectAccount: (authuser: number) => void
  onFindAccounts: () => void
}

export function AccountPicker({
  settings,
  switchingAccount,
  busy,
  onSelectAccount,
  onFindAccounts,
}: AccountPickerProps) {
  return (
    <div class="mb-3 flex items-center gap-2">
      {settings.accounts.length > 0 && (
        <select
          class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
          value={settings.nblmAuthuser}
          disabled={switchingAccount}
          onChange={(e) => onSelectAccount(Number(e.currentTarget.value))}
        >
          {settings.accounts.map((account) => (
            <option key={account.authuser} value={account.authuser}>
              {account.email}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        class={
          settings.accounts.length > 0
            ? 'text-gray-500 disabled:opacity-50'
            : 'text-blue-600 disabled:opacity-50'
        }
        disabled={busy || switchingAccount}
        onClick={onFindAccounts}
      >
        {busy ? 'Finding accounts…' : settings.accounts.length > 0 ? '↻' : '↻ find accounts'}
      </button>
    </div>
  )
}
