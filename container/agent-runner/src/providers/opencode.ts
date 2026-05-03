import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout|exceeds the available context size|context(?:\s|-)?window|maximum context/i;

const CLAUDE_IMPORT_RE = /^@(.+)$/;

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    });

    const id = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

export function expandClaudeMdImports(filePath: string, seen: Set<string> = new Set()): string {
  const resolvedPath = path.resolve(filePath);
  if (seen.has(resolvedPath)) {
    return `<!-- skipped recursive CLAUDE.md import: ${resolvedPath} -->`;
  }

  seen.add(resolvedPath);
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const baseDir = path.dirname(resolvedPath);

  return content
    .split('\n')
    .map((line) => {
      const match = line.match(CLAUDE_IMPORT_RE);
      if (!match) return line;

      const target = match[1].trim();
      const targetPath = path.isAbsolute(target) ? target : path.resolve(baseDir, target);
      if (!fs.existsSync(targetPath)) return line;

      return expandClaudeMdImports(targetPath, seen);
    })
    .join('\n');
}

function readClaudeMdForPrompt(): string | undefined {
  const groupPath = '/workspace/agent/CLAUDE.md';
  const globalPath = '/workspace/global/CLAUDE.md';
  let content = '';
  if (fs.existsSync(groupPath)) {
    content += expandClaudeMdImports(groupPath);
  }
  const isMain = process.env.NANOCLAW_IS_MAIN === '1';
  if (!isMain && fs.existsSync(globalPath)) {
    if (content) content += '\n\n---\n\n';
    content += expandClaudeMdImports(globalPath);
  }
  return content || undefined;
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  const claudeMd = readClaudeMdForPrompt();
  if (claudeMd) {
    out = `<system>\n${claudeMd}\n</system>\n\n${out}`;
  }
  return out;
}

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function shouldStripOpenAiPromptCacheKey(baseUrl: string | undefined): boolean {
  if (process.env.OPENCODE_STRIP_OPENAI_PROMPT_CACHE_KEY === '1') return true;
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function startOpenAiCompatProxy(targetBaseUrl: string): Promise<{ baseUrl: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const normalizedTarget = targetBaseUrl.replace(/\/$/, '');
    const server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        let body: Buffer | string | undefined = chunks.length ? Buffer.concat(chunks) : undefined;
        const contentType = req.headers['content-type'] || '';
        if (body && String(contentType).includes('application/json')) {
          const payload = JSON.parse(body.toString('utf8'));
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            delete payload.promptCacheKey;
          }
          body = JSON.stringify(payload);
        }

        const incoming = new URL(req.url || '/', 'http://127.0.0.1');
        const target = new URL(normalizedTarget);
        const targetPrefix = target.pathname.replace(/\/$/, '');
        const incomingPath = incoming.pathname.startsWith(`${targetPrefix}/`)
          ? incoming.pathname.slice(targetPrefix.length)
          : incoming.pathname;
        target.pathname = `${targetPrefix}${incomingPath}`;
        target.search = incoming.search;

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (!value || ['host', 'content-length'].includes(key.toLowerCase())) continue;
          if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          } else {
            headers.set(key, value);
          }
        }
        if (typeof body === 'string') {
          headers.set('content-type', 'application/json');
          headers.set('content-length', Buffer.byteLength(body).toString());
        }

        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });

        res.statusCode = upstream.status;
        upstream.headers.forEach((value, key) => {
          if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('OpenAI compatibility proxy did not get a TCP port'));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}/v1`, server });
    });
  });
}

function buildOpenCodeConfig(options: ProviderOptions, baseUrlOverride?: string): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const providerName = process.env.OPENCODE_PROVIDER_NAME || provider;
  const providerPackage =
    process.env.OPENCODE_PROVIDER_PACKAGE || (provider === 'anthropic' ? undefined : '@ai-sdk/openai-compatible');
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const baseUrl =
    baseUrlOverride || process.env.OPENCODE_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || 'placeholder';
  const outputLimit = positiveNumber(process.env.OPENCODE_MODEL_OUTPUT_LIMIT);
  const contextLimit = positiveNumber(process.env.OPENCODE_MODEL_CONTEXT_LIMIT) ?? 32768;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);
  const modelLimit = outputLimit ? { context: contextLimit, output: outputLimit } : undefined;

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            ...(providerPackage ? { npm: providerPackage } : {}),
            name: providerName,
            options: { apiKey, baseURL: baseUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [
                      mid,
                      { name: mid, tool_call: true, ...(modelLimit ? { limit: modelLimit } : {}) },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  return {
    $schema: 'https://opencode.ai/config.json',
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
  proxyServer?: http.Server;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
    providerName: process.env.OPENCODE_PROVIDER_NAME,
    providerPackage: process.env.OPENCODE_PROVIDER_PACKAGE,
    baseUrl: process.env.OPENCODE_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY ? 'set' : 'unset',
    contextLimit: process.env.OPENCODE_MODEL_CONTEXT_LIMIT,
    outputLimit: process.env.OPENCODE_MODEL_OUTPUT_LIMIT,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const upstreamBaseUrl = process.env.OPENCODE_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    const proxy = shouldStripOpenAiPromptCacheKey(upstreamBaseUrl)
      ? await startOpenAiCompatProxy(upstreamBaseUrl as string)
      : undefined;
    if (proxy) {
      log(`OpenAI compatibility proxy enabled at ${proxy.baseUrl}`);
    }
    const config = buildOpenCodeConfig(options, proxy?.baseUrl);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
      proxyServer: proxy?.server,
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    try {
      sharedRuntime.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      sharedRuntime.proxyServer?.close();
    } catch {
      /* ignore */
    }
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: Array<{ text: string; includeSessionContext: boolean }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push({
      text: input.prompt,
      includeSessionContext: !input.continuation,
    });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const pendingPrompt = pending.shift()!;
        const text = pendingPrompt.includeSessionContext
          ? wrapPromptWithContext(pendingPrompt.text, systemInstructions)
          : pendingPrompt.text;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push({ text: message, includeSessionContext: false });
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
