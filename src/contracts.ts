export const WORKFLOW_TYPE = 'managedAgent';
export const APPROVE_SIGNAL = 'approve';
export const STATUS_QUERY = 'status';

export interface AgentState {
  phase: 'preparing' | 'waiting_for_approval' | 'executing' | 'completed';
  task: string;
  plan?: string;
  result?: string;
}
