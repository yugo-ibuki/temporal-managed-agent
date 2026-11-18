import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { config } from './config';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address: config.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
