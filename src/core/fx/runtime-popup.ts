/**
 * Popup-side Effect runtime. Separate module from runtime.ts so the popup
 * bundle doesn't pull the SW layer set (and vice versa).
 */
import { ManagedRuntime } from 'effect'
import { PopupLive } from './layers'

export const popupRuntime = ManagedRuntime.make(PopupLive)
