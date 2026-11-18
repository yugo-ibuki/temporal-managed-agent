import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { config } from './config';
import { APPROVE_SIGNAL, STATUS_QUERY, WORKFLOW_TYPE, type AgentState } from './contracts';

// Requires a running Temporal server AND Worker (docker compose up --build -d).
test('approval completes the Workflow; cancellation closes a waiting Workflow', { timeout: 60_000 }, async () => {
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handles: ReturnType<typeof client.workflow.getHandle>[] = [];
  try {
    async function startWaiting() {
      const handle = await client.workflow.start(WORKFLOW_TYPE, {
        workflowId: `integration-${randomUUID()}`,
        taskQueue: config.taskQueue,
        args: ['integration test'],
        workflowExecutionTimeout: '1 minute',
      });
      handles.push(handle);
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await handle.query<AgentState>(STATUS_QUERY);
        if (state.phase === 'waiting_for_approval') {
          assert.match(state.plan!, /integration test/);
          return handle;
        }
        await delay(100);
      }
      throw new Error('Workflow did not reach approval wait');
    }

    const approved = await startWaiting();
    await approved.signal(APPROVE_SIGNAL);
    assert.match(await approved.result(), /モック実行完了/);
    assert.equal((await approved.describe()).status.name, 'COMPLETED');

    const cancelled = await startWaiting();
    await cancelled.cancel();
    await assert.rejects(cancelled.result(), WorkflowFailedError);
    assert.equal((await cancelled.describe()).status.name, 'CANCELLED');
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.cancel()));
    await connection.close();
  }
});
