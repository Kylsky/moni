import { env } from 'cloudflare:test';
import { runPersistenceConformance } from '@tanstack/ai-persistence/testkit';
import { describe, expect, it } from 'vitest';
import { chatPersistence } from '../../src/lib/chat-persistence';

runPersistenceConformance('Moni D1', () => chatPersistence(env.DB), {
  skip: ['activities', 'generationRuns', 'artifacts', 'blobs'],
  checks: ['messages.metadata', 'runs.listByThread.state'],
});

describe('D1 execution and atomicity boundaries', () => {
  it('retains more than 1000 messages and 1 MiB, writes only changed rows, and pages complete turns', async () => {
    const store = chatPersistence(env.DB).stores.messages;
    const id = crypto.randomUUID();
    const messages = Array.from({ length: 1300 }, (_, index) => ({
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: `Synthetic ${index} ${'x'.repeat(1000)}`,
    }));
    await store.saveThread(id, messages);
    expect(await store.loadThread(id)).toEqual(messages);
    await env.DB.exec(
      "CREATE TRIGGER protect_history_prefix BEFORE UPDATE ON chat_messages WHEN NEW.position<1300 BEGIN SELECT RAISE(ABORT,'Unchanged history rewritten'); END;"
    );
    try {
      await store.saveThread(id, [
        ...messages,
        { id: 'tail', role: 'user', content: 'Synthetic tail' },
      ]);
    } finally {
      await env.DB.exec('DROP TRIGGER protect_history_prefix');
    }
    let cursor: string | undefined;
    const restored: unknown[] = [];
    do {
      const page = await store.loadThread(id, { limit: 50, before: cursor });
      if (Array.isArray(page)) throw new Error('Expected history page');
      restored.unshift(...page.messages);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    expect(restored).toEqual([
      ...messages,
      { id: 'tail', role: 'user', content: 'Synthetic tail' },
    ]);
    const first = await store.loadThread(id, { limit: 2 });
    if (Array.isArray(first) || !first.truncated)
      throw new Error('Expected truncated page');
    await expect(
      store.loadThread(crypto.randomUUID(), { limit: 2, before: first.cursor })
    ).rejects.toThrow();
    await store.saveThread(id, [
      { id: 'question', role: 'user', content: 'Synthetic question' },
      {
        id: 'call',
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tool',
            type: 'function',
            function: { name: 'synthetic_tool', arguments: '{}' },
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        toolCallId: 'tool',
        content: 'Synthetic result',
      },
      { id: 'answer', role: 'assistant', content: 'Synthetic answer' },
    ]);
    const page = await store.loadThread(id, { limit: 2 });
    if (Array.isArray(page)) throw new Error('Expected history page');
    expect(page.messages).toHaveLength(4);
    expect(page.messages[0].role).toBe('user');
    expect(page.truncated).toBe(false);
  });

  it('rolls back a multi-chunk history save when a later chunk fails', async () => {
    const store = chatPersistence(env.DB).stores.messages;
    const id = crypto.randomUUID();
    const original = [
      {
        id: 'original',
        role: 'user' as const,
        content: 'Original synthetic history',
      },
    ];
    await store.saveThread(id, original);
    await env.DB.exec(
      "CREATE TRIGGER reject_history_chunk BEFORE INSERT ON chat_messages WHEN NEW.message_json LIKE '%broken-tail%' BEGIN SELECT RAISE(ABORT,'Synthetic late chunk failure'); END;"
    );
    try {
      await expect(
        store.saveThread(id, [
          ...Array.from({ length: 100 }, () => ({
            role: 'user' as const,
            content: 'x'.repeat(1000),
          })),
          { role: 'user', content: 'broken-tail' },
        ])
      ).rejects.toThrow();
      expect(await store.loadThread(id)).toEqual(original);
    } finally {
      await env.DB.exec('DROP TRIGGER reject_history_chunk');
    }
  });

  it('rolls back every statement when a later invariant fails', async () => {
    const id = crypto.randomUUID();
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO chat_metadata (dataset_id, namespace, key, value_json, revision)
           VALUES ('initial', 'atomic', ?, '1', 'one')`
        ).bind(id),
        env.DB.prepare('INSERT INTO invariant_assertions (valid) VALUES (0)'),
      ])
    ).rejects.toThrow();
    expect(
      await chatPersistence(env.DB).stores.metadata.get('atomic', id)
    ).toBeNull();
  });

  it('rejects stale or expired writes without replacing accepted history', async () => {
    const threadId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO chat_permits (dataset_id, thread_id, run_id, token, expires_at)
       VALUES ('initial', ?, ?, ?, ?)`
    )
      .bind(threadId, runId, token, Date.now() + 60_000)
      .run();
    const plain = chatPersistence(env.DB);
    const guarded = chatPersistence(env.DB, 'initial', {
      threadId,
      runId,
      token,
    });
    const accepted = [
      { role: 'user' as const, content: 'Accepted synthetic input' },
    ];
    await guarded.stores.messages.saveThread(threadId, accepted);
    await env.DB.prepare(
      "UPDATE chat_permits SET token = 'revoked' WHERE dataset_id = 'initial' AND thread_id = ?"
    )
      .bind(threadId)
      .run();
    await expect(
      guarded.stores.messages.saveThread(threadId, [])
    ).rejects.toThrow();
    expect(await plain.stores.messages.loadThread(threadId)).toEqual(accepted);

    await env.DB.prepare(
      "UPDATE chat_permits SET token = ?, expires_at = ? WHERE dataset_id = 'initial' AND thread_id = ?"
    )
      .bind(token, Date.now() - 60_000, threadId)
      .run();
    await expect(
      guarded.stores.metadata.set('expired', threadId, 1)
    ).rejects.toThrow();
    expect(await plain.stores.metadata.get('expired', threadId)).toBeNull();
  });

  it('allows only one writer to win a metadata revision', async () => {
    const metadata = chatPersistence(env.DB).stores.metadata;
    const key = crypto.randomUUID();
    await metadata.set('cas', key, 'before');
    const before = await metadata.getVersioned?.('cas', key);
    expect(before).not.toBeNull();
    if (!before || !metadata.setIf)
      throw new Error('Versioned metadata unavailable');
    const results = await Promise.all([
      metadata.setIf('cas', key, 'first', before.revision),
      metadata.setIf('cas', key, 'second', before.revision),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const after = await metadata.getVersioned?.('cas', key);
    expect(['first', 'second']).toContain(after?.value);
    expect(after?.revision).not.toBe(before.revision);
  });

  it('keeps another data set isolated and rejects a replaced active data set', async () => {
    const dataset = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const original = chatPersistence(env.DB);
    const other = chatPersistence(env.DB, dataset);
    await original.stores.messages.saveThread(threadId, [
      { role: 'user', content: 'Original' },
    ]);
    expect(await other.stores.messages.loadThread(threadId)).toEqual([]);
    await env.DB.prepare(
      `INSERT INTO chat_permits (dataset_id, thread_id, run_id, token, expires_at)
       VALUES ('initial', ?, 'run', 'token', ?)`
    )
      .bind(threadId, Date.now() + 60_000)
      .run();
    await env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    )
      .bind(dataset)
      .run();
    try {
      const stale = chatPersistence(env.DB, 'initial', {
        threadId,
        runId: 'run',
        token: 'token',
      });
      await expect(
        stale.stores.messages.saveThread(threadId, [])
      ).rejects.toThrow();
      expect(await original.stores.messages.loadThread(threadId)).toEqual([
        { role: 'user', content: 'Original' },
      ]);
    } finally {
      await env.DB.prepare(
        "UPDATE moni_state SET active_dataset = 'initial' WHERE singleton = 1"
      ).run();
    }
  });
});
