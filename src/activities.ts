import { ApplicationFailure } from '@temporalio/common';

// Mock activities for the offline `start` command.
// Real tools must handle retries safely (e.g. using an idempotency key).
export async function createPlan(task: string): Promise<string> {
  return `「${task}」を実行する計画です。承認後にモック処理を実行します。`;
}

export async function executePlan(plan: string): Promise<string> {
  return `モック実行完了: ${plan}`;
}

export async function getUtcTime(): Promise<string> {
  return new Date().toISOString();
}

type Decision = { kind: 'answer'; text: string } | { kind: 'getUtcTime'; callId: string };

export async function askModel(task: string, observation?: { callId: string; time: string }): Promise<Decision> {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) throw ApplicationFailure.nonRetryable('start-ai requires OPENAI_API_KEY on the Worker');

  const tool = { name: 'getUtcTime', description: 'Get the current UTC date and time.', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
  const messages = [
    { role: 'user', content: task },
    ...(observation ? [
      { role: 'assistant', tool_calls: [{ id: observation.callId, type: 'function', function: { name: tool.name, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: observation.callId, content: observation.time },
    ] : []),
  ];
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', messages, max_completion_tokens: 512,
      tools: [{ type: 'function', function: tool }],
      tool_choice: observation ? 'none' : 'auto', parallel_tool_calls: false,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    // Keep diagnostics bounded and redact the credential before storing them in history.
    const body = await response.text();
    let detail = body;
    try {
      const message: unknown = JSON.parse(body)?.error?.message;
      if (typeof message === 'string') detail = message;
    } catch { /* Non-JSON error bodies are also useful for diagnostics. */ }
    detail = detail.split(key).join('[REDACTED]').slice(0, 500);
    const message = `OpenAI request failed (HTTP ${response.status}): ${detail}`;
    // Timeouts and rate limiting may recover; other client errors need intervention.
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      throw ApplicationFailure.nonRetryable(message);
    }
    throw new Error(message);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw ApplicationFailure.nonRetryable('OpenAI returned invalid JSON');
  }
  const choice = payload?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (!observation && choice?.finish_reason === 'tool_calls' && calls?.length === 1 &&
      Array.isArray(calls) && calls[0]?.type === 'function' &&
      calls[0].function?.name === tool.name && typeof calls[0].id === 'string' && calls[0].id.trim()) {
    // The next turn reconstructs arguments as '{}', so only accept an empty object.
    try {
      const args: unknown = JSON.parse(calls[0].function.arguments);
      if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0) {
        return { kind: 'getUtcTime', callId: calls[0].id };
      }
    } catch { /* Fall through to the invalid-response error. */ }
  }
  if (choice?.finish_reason === 'stop' && typeof choice.message?.content === 'string' && choice.message.content.trim()) {
    return { kind: 'answer', text: choice.message.content };
  }
  throw ApplicationFailure.nonRetryable(`Unexpected or incomplete model response (finish_reason: ${String(choice?.finish_reason)})`);
}
