export function createReviewBudget({ maxToolCalls = 80, deadline, abort = () => {} }) {
  let toolCalls = 0;
  const failures = [];
  return {
    recordToolCall() {
      toolCalls++;
      if (toolCalls > maxToolCalls) {
        this.fail(`hard tool-call budget exceeded (${maxToolCalls})`);
        throw new Error('Tool call budget exceeded');
      }
      return toolCalls;
    },
    fail(reason) {
      if (!failures.includes(reason)) failures.push(reason);
      abort();
    },
    check(now = Date.now()) {
      if (deadline !== undefined && now >= deadline) this.fail('hard review deadline exceeded');
      return [...failures];
    },
    get toolCalls() { return toolCalls; },
  };
}
