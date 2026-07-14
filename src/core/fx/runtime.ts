/**
 * Module-scope Effect runtime, built once. Entrypoints only — core/**
 * programs must stay runtime-agnostic and take services via `R`.
 */
import { ManagedRuntime } from 'effect'
import { PorterLive } from './layers'

export const porterRuntime = ManagedRuntime.make(PorterLive)
