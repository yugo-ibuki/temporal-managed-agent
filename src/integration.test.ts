import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { askModel } from './activities';
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

// Isolated queue and mocked activities: exercises the real Workflow without OpenAI.
test('AI routes, approval gating, and failures', { timeout: 60_000 }, async () => {
  const connection = await Connection.connect({ address: config.address });
  const nativeConnection = await NativeConnection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const taskQueue = `ai-test-${randomUUID()}`;
  const handles: ReturnType<typeof client.workflow.getHandle>[] = [];
  const calls: string[] = [];
  let releaseModel: (() => void) | undefined;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  try {
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace: config.namespace,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        askModel: async (task: string, observation?: Parameters<typeof askModel>[1]) => {
          calls.push(observation ? 'answer' : 'decide');
          if (task === 'invalid') throw ApplicationFailure.nonRetryable('Invalid model response');
          if (task === 'direct') return { kind: 'answer', text: 'Direct answer' };
          if (!observation) {
            await modelGate;
            return { kind: 'getUtcTime', callId: 'test-call' };
          }
          assert.deepEqual(observation, { callId: 'test-call', time: '2026-01-01T00:00:00Z' });
          return { kind: 'answer', text: 'Tool answer' };
        },
        getUtcTime: async () => { calls.push('clock'); return '2026-01-01T00:00:00Z'; },
      },
    });
    await worker.runUntil(async () => {
      async function start(task: string, mode = 'ai') {
        const handle = await client.workflow.start(WORKFLOW_TYPE, {
          workflowId: `ai-${randomUUID()}`, taskQueue, args: [task, mode],
          workflowExecutionTimeout: '30 seconds',
        });
        handles.push(handle);
        return handle;
      }
      const direct = await start('direct');
      assert.equal(await direct.result(), 'Direct answer');
      assert.deepEqual(calls.splice(0), ['decide']);

      const tool = await start('tool');
      await tool.signal(APPROVE_SIGNAL); // Too early: AI must not accept this approval.
      assert.equal((await tool.query<AgentState>(STATUS_QUERY)).phase, 'preparing');
      releaseModel!();
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await tool.query<AgentState>(STATUS_QUERY);
        if (state.phase === 'waiting_for_approval') { waiting = true; break; }
        await delay(50);
      }
      assert.ok(waiting, 'tool route should wait for a fresh approval');
      assert.deepEqual(calls, ['decide']);
      await tool.signal(APPROVE_SIGNAL);
      assert.equal(await tool.result(), 'Tool answer');
      assert.deepEqual(calls.splice(0), ['decide', 'clock', 'answer']);

      const invalid = await start('invalid');
      await assert.rejects(invalid.result(), WorkflowFailedError);
      assert.deepEqual(calls.splice(0), ['decide']);
      const badMode = await start('unused', 'unsupported');
      await assert.rejects(badMode.result(), WorkflowFailedError);
      assert.deepEqual(calls, []);
    });
  } finally {
    releaseModel?.();
    await Promise.allSettled(handles.map((handle) => handle.cancel()));
    await nativeConnection.close();
    await connection.close();
  }
});
