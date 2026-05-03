import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('asks for a final acknowledgement when a provider returns empty text after an action', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Schedule this' }, { platformId: 'chan-1', channelType: 'discord' });

    let calls = 0;
    const provider = new MockProvider({}, (prompt) => {
      calls++;
      if (calls === 1) {
        writeMessageOut({
          id: 'task-test',
          kind: 'system',
          platform_id: 'chan-1',
          channel_type: 'discord',
          content: JSON.stringify({
            action: 'schedule_task',
            taskId: 'task-test',
            prompt: 'check something',
            processAfter: '2026-05-02T13:00:00.000Z',
            recurrence: '0 */6 * * *',
          }),
        });
        return '';
      }
      expect(prompt).toContain('You completed one or more actions');
      return 'Done — I scheduled the monitor.';
    });

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.some((row) => row.kind === 'system')).toBe(true);
    const chat = out.find((row) => row.kind === 'chat');
    expect(chat).toBeDefined();
    expect(JSON.parse(chat!.content).text).toBe('Done — I scheduled the monitor.');

    await loopPromise.catch(() => {});
  });

  it('clears an invalid continuation and retries the current prompt once', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Fresh answer please' }, { platformId: 'chan-1', channelType: 'discord' });
    setContinuation('mock', 'old-session');

    let calls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: (err) => err instanceof Error && err.message.includes('exceeds the available context size'),
      query(input: QueryInput): AgentQuery {
        calls++;
        if (calls === 1) {
          expect(input.continuation).toBe('old-session');
          return throwingQuery('request exceeds the available context size');
        }

        expect(input.continuation).toBeUndefined();
        return resultQuery('new-session', '<message to="discord-test">Recovered</message>');
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Recovered');
    expect(calls).toBe(2);

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

function throwingQuery(message: string): AgentQuery {
  return {
    events: (async function* (): AsyncIterableIterator<ProviderEvent> {
      throw new Error(message);
    })(),
    push() {},
    end() {},
    abort() {},
  };
}

function resultQuery(continuation: string, text: string): AgentQuery {
  return {
    events: (async function* (): AsyncIterableIterator<ProviderEvent> {
      yield { type: 'init', continuation };
      yield { type: 'result', text };
    })(),
    push() {},
    end() {},
    abort() {},
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
