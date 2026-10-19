export const OWNER = 'ZHOUKAILIAN';
const EVENTS = new Set(['pull_request_target', 'workflow_dispatch']);
export function authorizeTrigger({ event, eventName, actor, triggeringActor, repository, inputPr }) {
  const dispatch = eventName === 'workflow_dispatch';
  const pr = event?.pull_request;
  const number = dispatch ? inputPr : String(pr?.number ?? '');
  const sameRepo = pr?.head?.repo?.full_name?.toLowerCase() === repository?.toLowerCase();
  const eligible = EVENTS.has(eventName) && /^\d+$/.test(number)
    && actor?.toUpperCase() === OWNER && triggeringActor?.toUpperCase() === OWNER
    && (dispatch
      ? event.ref === 'refs/heads/main' && event.repository?.full_name?.toLowerCase() === repository?.toLowerCase()
      : sameRepo && pr?.user?.login?.toUpperCase() === OWNER);
  return { eligible, dispatch, number };
}
