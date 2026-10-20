import { type Request, Response } from 'miniflare';

// These fixtures exercise bookkeeping, not intent recognition; never grant approval here.
export async function syntheticOtherIntent(request: Request) {
  const body = (await request.clone().json()) as {
    tools?: { function: { name: string } }[];
  };
  if (
    !body.tools?.some(
      (tool) => tool.function.name === 'classify_draft_confirmation'
    )
  )
    return null;
  return new Response(
    `data: ${JSON.stringify({ id: 'synthetic-intent', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name: 'classify_draft_confirmation', arguments: JSON.stringify({ intent: 'other' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
}
