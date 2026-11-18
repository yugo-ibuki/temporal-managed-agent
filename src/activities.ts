// Deterministic mock activities: no LLM credentials or external side effects yet.
// Real tools must handle retries safely (e.g. using an idempotency key).
export async function createPlan(task: string): Promise<string> {
  return `「${task}」を実行する計画です。承認後にモック処理を実行します。`;
}

export async function executePlan(plan: string): Promise<string> {
  return `モック実行完了: ${plan}`;
}
