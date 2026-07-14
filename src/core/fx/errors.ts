/**
 * Tagged error taxonomy for the Effect fx layer (design §4). This is the
 * COMPLETE set (including `IpcError` for the popup/background transport) —
 * later stages must not add more without need.
 */
import { Data } from 'effect'

export class FetchError extends Data.TaggedError('FetchError')<{
  url: string
  cause: unknown
}> {}

export class HttpStatusError extends Data.TaggedError('HttpStatusError')<{
  url: string
  status: number
}> {}

export class NotLoggedIn extends Data.TaggedError('NotLoggedIn')<{
  authuser: number
}> {}

export class ProtocolDrift extends Data.TaggedError('ProtocolDrift')<{
  rpcId: string
  snippet: string
}> {}

export class RpcRefused extends Data.TaggedError('RpcRefused')<{
  rpcId: string
  code: string
}> {}

export class DriveAuthError extends Data.TaggedError('DriveAuthError')<{
  reason: string
}> {}

export class DriveApiError extends Data.TaggedError('DriveApiError')<{
  step: string
  status: number
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
  key: string
  cause: unknown
}> {}

/** browser.alarms scheduling or clearing failure. */
export class AlarmError extends Data.TaggedError('AlarmError')<{
  operation: 'schedule' | 'clear'
  cause: unknown
}> {}

export class ExtractionError extends Data.TaggedError('ExtractionError')<{
  url: string
  reason: string
}> {}

/** runtime.sendMessage / tabs.sendMessage transport failure. */
export class IpcError extends Data.TaggedError('IpcError')<{
  reason: string
}> {}

export type PorterError =
  | FetchError
  | HttpStatusError
  | NotLoggedIn
  | ProtocolDrift
  | RpcRefused
  | DriveAuthError
  | DriveApiError
  | StorageError
  | ExtractionError
  | AlarmError
  | IpcError
