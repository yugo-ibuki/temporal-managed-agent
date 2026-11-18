import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './activities';
import { APPROVE_SIGNAL, STATUS_QUERY, type AgentState } from './contracts';

const { createPlan, executePlan } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds', maximumAttempts: 3 },
});

export const approveSignal = defineSignal(APPROVE_SIGNAL);
export const statusQuery = defineQuery<AgentState>(STATUS_QUERY);

export async function managedAgent(task: string): Promise<string> {
  const state: AgentState = { phase: 'preparing', task };
  let approved = false;
  setHandler(approveSignal, () => { approved = true; });
  setHandler(statusQuery, () => ({ ...state }));

  state.plan = await createPlan(task);
  state.phase = 'waiting_for_approval';
  // Approval is recorded in history, so it survives Worker restarts.
  await condition(() => approved);

  state.phase = 'executing';
  state.result = await executePlan(state.plan);
  state.phase = 'completed';
  return state.result;
}
