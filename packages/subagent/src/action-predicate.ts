/** Single shared definition of an action that is not durably settled. */
import type { ActionProjection, ActionStatus, InternalView } from "./delegation-types.ts";

export const UNRESOLVED_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set(["intent_acked", "unknown", "still_unknown"]);

export function isUnresolvedActionStatus(status: ActionStatus): boolean {
  return UNRESOLVED_ACTION_STATUSES.has(status);
}

/** Includes every logical action retained for the Delegation, regardless of reservation/scope. */
export function unresolvedActionsForDelegation(view: InternalView, delegationId: string): ActionProjection[] {
  return [...(view.actions?.values() ?? [])].filter((action) => action.delegationId === delegationId && isUnresolvedActionStatus(action.status));
}

export function hasUnresolvedActionForDelegation(view: InternalView, delegationId: string): boolean {
  return unresolvedActionsForDelegation(view, delegationId).length > 0;
}

/** A Call cannot become terminal while any of its Delegations has an unresolved action. */
export function hasUnresolvedActionForCall(view: InternalView): boolean {
  return [...view.delegations.keys()].some((delegationId) => hasUnresolvedActionForDelegation(view, delegationId));
}
