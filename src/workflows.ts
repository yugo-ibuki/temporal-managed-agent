import { ApplicationFailure, condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './activities';
import { APPROVE_SIGNAL, STATUS_QUERY, type AgentState } from './contracts';

const { askModel } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 }, // Do not automatically repeat a billable request.
});
const { createPlan, executePlan, getUtcTime } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds', maximumAttempts: 3 },
});

export const approveSignal = defineSignal(APPROVE_SIGNAL);
export const statusQuery = defineQuery<AgentState>(STATUS_QUERY);

export async function managedAgent(task: string, mode: 'mock' | 'ai' = 'mock'): Promise<string> {
  if (mode !== 'mock' && mode !== 'ai') {
    throw ApplicationFailure.nonRetryable(`Unsupported agent mode: ${String(mode)}`);
  }
  const state: AgentState = { phase: 'preparing', task };
  let approved = false;
  setHandler(approveSignal, () => {
    // Preserve early approval for mock history replay; AI approval must follow the tool decision.
    if (mode === 'mock' || state.phase === 'waiting_for_approval') approved = true;
  });
  setHandler(statusQuery, () => ({ ...state }));

  const decision = mode === 'ai' ? await askModel(task) : undefined;
  if (decision?.kind === 'answer') {
    state.phase = 'completed';
    state.result = decision.text;
    return state.result;
  }
  state.plan = decision ? '現在時刻（UTC）を取得する' : await createPlan(task);
  state.phase = 'waiting_for_approval';
  // Approval is recorded in history, so it survives Worker restarts.
  await condition(() => approved);

  state.phase = 'executing';
  if (decision) {
    const time = await getUtcTime();
    const answer = await askModel(task, { callId: decision.callId, time });
    // With an observation, askModel disables tool calls and validates the response.
    if (answer.kind !== 'answer') throw ApplicationFailure.nonRetryable('Expected a final answer');
    state.result = answer.text;
  } else {
    state.result = await executePlan(state.plan);
  }
  state.phase = 'completed';
  return state.result;
}
