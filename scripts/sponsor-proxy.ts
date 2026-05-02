import http from 'node:http';

const LISTEN_HOST = process.env.SPONSOR_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.SPONSOR_PROXY_PORT || '18081');
const UPSTREAM_BASE = process.env.SPONSOR_UPSTREAM_BASE || 'https://compute-network-6.integratenetwork.work/v1/proxy';
const UPSTREAM_API_KEY = process.env.SPONSOR_UPSTREAM_API_KEY;
const DEFAULT_MODEL = process.env.SPONSOR_DEFAULT_MODEL || 'qwen2.5-7b-instruct';
const MAX_TOKENS_CAP = Number(process.env.SPONSOR_MAX_TOKENS_CAP || '8192');

if (!UPSTREAM_API_KEY) {
  console.error('Missing SPONSOR_UPSTREAM_API_KEY');
  process.exit(1);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function summarizeRequest(body: Record<string, unknown>): Record<string, unknown> {
  return {
    model: body.model,
    stream: body.stream,
    max_tokens: body.max_tokens,
    tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
    tool_choice: body.tool_choice,
    message_count: Array.isArray(body.messages) ? body.messages.length : 0,
  };
}

function rewriteBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body = { ...raw };
  const model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  body.model = model.replace(/^sponsor\//, '') || DEFAULT_MODEL;

  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  if (!maxTokens || !Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CAP) {
    body.max_tokens = Math.min(Math.max(maxTokens || 2048, 1), MAX_TOKENS_CAP);
  }

  return body;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: `sponsor/${DEFAULT_MODEL}`, object: 'model', owned_by: 'hackathon-sponsor' },
        ],
      });
    }

    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: 'Not found' });
    }

    const rawBody = await readJson(req);
    const body = rewriteBody(rawBody);
    console.error('[sponsor-proxy] request', JSON.stringify(summarizeRequest(body)));

    const upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[sponsor-proxy] error', message);
    sendJson(res, 500, { error: message });
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error(`[sponsor-proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT}/v1`);
});
