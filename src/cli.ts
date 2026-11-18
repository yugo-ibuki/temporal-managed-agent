import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { config } from './config';
import { APPROVE_SIGNAL, STATUS_QUERY, WORKFLOW_TYPE, type AgentState } from './contracts';

const usage = `Usage:
  npm run agent -- start "task" [workflow-id]
  npm run agent -- status <workflow-id>
  npm run agent -- approve <workflow-id>
  npm run agent -- result <workflow-id>
  npm run agent -- cancel <workflow-id>`;

async function main(): Promise<void> {
  const [command, value, id, ...extra] = process.argv.slice(2);
  if (!command || !value?.trim() || extra.length > 0 ||
      !['start', 'status', 'approve', 'result', 'cancel'].includes(command) ||
      (command !== 'start' && id !== undefined)) {
    throw new Error(usage);
  }

  const connection = await Connection.connect({ address: config.address });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    if (command === 'start') {
      const handle = await client.workflow.start(WORKFLOW_TYPE, {
        workflowId: id || `agent-${randomUUID()}`,
        taskQueue: config.taskQueue,
        args: [value],
        // Bound approval waits as well as execution in this prototype.
        workflowExecutionTimeout: '24 hours',
      });
      console.log(JSON.stringify({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId }, null, 2));
      return;
    }

    const handle = client.workflow.getHandle(value);
    switch (command) {
      case 'status': {
        const description = await handle.describe();
        // Closed executions are reported using server metadata, not a query
        // (queries require a running Worker even for completed executions).
        const state = description.status.name === 'RUNNING'
          ? await handle.query<AgentState>(STATUS_QUERY)
          : undefined;
        console.log(JSON.stringify({ workflowId: value, status: description.status.name, state }, null, 2));
        break;
      }
      case 'approve':
        await handle.signal(APPROVE_SIGNAL);
        console.log('Approval sent.');
        break;
      case 'result':
        console.log(await handle.result());
        break;
      case 'cancel':
        await handle.cancel();
        console.log('Cancellation requested.');
        break;
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
