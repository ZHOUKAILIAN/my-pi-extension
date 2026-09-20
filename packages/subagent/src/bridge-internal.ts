// Intentionally not reachable through packages/subagent/package.json exports.
// Tests use this source-relative seam; GC uses only its lock-scoped functions.
export {
  createPreservationPinInternal as createPreservationPin,
  inspectPreservationPinInternal as inspectPreservationPin,
  refreshPreservationPinInternal as refreshPreservationPin,
  releasePreservationPinInternal as releasePreservationPin,
  inspectPreservationPinAtLockInternal as inspectPreservationPinAtLock,
  removePreservationPinAtLockInternal as removePreservationPinAtLock,
} from "./bridge.ts";
export type { BridgeDependencies } from "./bridge.ts";
