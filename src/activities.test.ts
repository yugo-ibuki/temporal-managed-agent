import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationFailure } from '@temporalio/common';
import { askModel } from './activities';

test('askModel validates requests, responses, and error diagnostics', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  process.env.OPENAI_API_KEY = 'test-secret';

  let response: Response;
  let request: any;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    request = JSON.parse(init!.body as string);
    return response;
  });
  const reply = (finish_reason: string, message: unknown) => {
    response = Response.json({ choices: [{ finish_reason, message }] });
  };
  const toolCall = (id = 'call-1', args = '{}') => ({
    id, type: 'function', function: { name: 'getUtcTime', arguments: args },
  });

  await t.test('direct answer and strict tool definition', async () => {
    reply('stop', { content: 'Hello' });
    assert.deepEqual(await askModel('task'), { kind: 'answer', text: 'Hello' });
    assert.equal(request.tools[0].function.strict, true);
    assert.deepEqual(request.tools[0].function.parameters.required, []);
  });

  await t.test('tool request and final answer with observation', async () => {
    reply('tool_calls', { tool_calls: [toolCall()] });
    assert.deepEqual(await askModel('task'), { kind: 'getUtcTime', callId: 'call-1' });
    reply('stop', { content: 'It is noon' });
    assert.deepEqual(await askModel('task', { callId: 'call-1', time: '12:00Z' }), {
      kind: 'answer', text: 'It is noon',
    });
    assert.equal(request.tool_choice, 'none');
    assert.equal(request.messages[1].tool_calls[0].function.arguments, '{}');
    assert.equal(request.messages[2].content, '12:00Z');
  });

  await t.test('rejects blank IDs, nonempty or malformed arguments, and repeated tool calls', async () => {
    for (const call of [toolCall('  '), toolCall('call-1', '{"unexpected":true}'),
      toolCall('call-1', '[]'), toolCall('call-1', 'null'), toolCall('call-1', 'invalid')]) {
      reply('tool_calls', { tool_calls: [call] });
      await assert.rejects(askModel('task'), /finish_reason: tool_calls/);
    }
    reply('tool_calls', { tool_calls: [toolCall()] });
    await assert.rejects(askModel('task', { callId: 'call-1', time: '12:00Z' }), /finish_reason: tool_calls/);
  });

  await t.test('reports truncation, filtering, empty answers, and invalid JSON', async () => {
    for (const reason of ['length', 'content_filter', 'stop']) {
      reply(reason, { content: '' });
      await assert.rejects(askModel('task'), new RegExp(`finish_reason: ${reason}`));
    }
    response = new Response('not json');
    await assert.rejects(askModel('task'), /invalid JSON/);
    response = Response.json(null);
    await assert.rejects(askModel('task'), /finish_reason: undefined/);
  });

  await t.test('classifies HTTP failures and bounds/redacts diagnostics', async () => {
    for (const status of [400, 401, 403, 408, 429, 500]) {
      response = Response.json({ error: { message: `test-secret: ${'x'.repeat(600)}` } }, { status });
      await assert.rejects(askModel('task'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes('test-secret'));
        assert.ok(error.message.length < 550);
        assert.equal(error instanceof ApplicationFailure && error.nonRetryable, ![408, 429, 500].includes(status));
        return true;
      });
    }
    response = new Response('upstream unavailable', { status: 502 });
    await assert.rejects(askModel('task'), /HTTP 502.*upstream unavailable/);
  });

  await t.test('missing credentials fail without a network request', async () => {
    process.env.OPENAI_API_KEY = '  ';
    const count = fetchMock.mock.callCount();
    await assert.rejects(askModel('task'), (error: unknown) => {
      assert.ok(error instanceof ApplicationFailure && error.nonRetryable);
      return true;
    });
    assert.equal(fetchMock.mock.callCount(), count);
  });
});
