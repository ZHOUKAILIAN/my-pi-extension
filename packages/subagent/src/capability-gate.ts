import { isBridgeProductionProof, type BridgeProductionProof } from "./bridge.ts";

export const CAPABILITY_GATE_NAMES = [
  "bridge",
  "adoption",
  "sideEffectFenceDeployment",
  "darwinProcessProof",
  "deliveryHost",
  "controlAdapters",
  "providerOsE2E",
] as const;
export type CapabilityGateName = typeof CAPABILITY_GATE_NAMES[number];

export interface CapabilityGate {
  version: 1;
  enabled: false;
  publicV2: false;
  rootWiring: 0;
  gates: Readonly<Record<CapabilityGateName, boolean>>;
  missing: readonly CapabilityGateName[];
}

/**
 * The aggregator deliberately accepts unknown values. Every production proof
 * type owns an unforgeable brand in its producing module; a JSON-shaped object
 * is never evidence merely because it says `verified: true`.
 */
export interface CapabilityGateInput {
  bridge?: unknown;
  adoption?: unknown;
  sideEffectFenceDeployment?: unknown;
  darwinProcessProof?: unknown;
  deliveryHost?: unknown;
  controlAdapters?: unknown;
  providerOsE2E?: unknown;
}

function gateValue(name: CapabilityGateName, value: unknown): boolean {
  if (name === "bridge" || name === "adoption") return isBridgeProductionProof(value);
  // The remaining deployment/process/E2E proofs have no producer in slice7.
  // Ordinary objects are never accepted as a substitute for those proofs.
  return false;
}

export function aggregateCapabilityGateInternal(input: CapabilityGateInput = {}): CapabilityGate {
  const gates = Object.freeze(Object.fromEntries(CAPABILITY_GATE_NAMES.map((name) => [name, gateValue(name, input[name])])) as Record<CapabilityGateName, boolean>);
  const missing = CAPABILITY_GATE_NAMES.filter((name) => !gates[name]);
  // Root wiring is intentionally a literal zero for slice7. Even a complete
  // evidence set cannot turn on v2 from this foundation slice.
  return Object.freeze({ version: 1, enabled: false, publicV2: false, rootWiring: 0, gates, missing });
}

export function capabilityGateAllowsPublicV2Internal(input: CapabilityGateInput = {}): false {
  aggregateCapabilityGateInternal(input);
  return false;
}

export type { BridgeProductionProof };
