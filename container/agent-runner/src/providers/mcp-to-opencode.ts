import type { McpServerConfig } from './types.js';

const MCP_NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

function inheritedNetworkEnv(env: Record<string, string | undefined>): Record<string, string> {
  const inherited = Object.fromEntries(
    MCP_NETWORK_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value ? [[key, value]] : [];
    }),
  );
  if (inherited.NODE_EXTRA_CA_CERTS) {
    inherited.SSL_CERT_FILE ||= inherited.NODE_EXTRA_CA_CERTS;
    inherited.REQUESTS_CA_BUNDLE ||= inherited.NODE_EXTRA_CA_CERTS;
    inherited.CURL_CA_BUNDLE ||= inherited.NODE_EXTRA_CA_CERTS;
  }
  return inherited;
}

/**
 * Map NanoClaw v2 MCP definitions (same shape as Claude Agent SDK) into
 * OpenCode config `mcp` field. Stdio-only until `McpServerConfig` gains remote.
 *
 * OpenCode treats `environment` as the subprocess env for local MCP servers.
 * Preserve proxy/CA variables so OneCLI-backed credential injection keeps
 * working for MCP tool calls inside the agent container.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  const networkEnv = inheritedNetworkEnv(env);
  for (const [name, cfg] of Object.entries(servers)) {
    const environment = { ...networkEnv, ...cfg.env };
    out[name] = {
      type: 'local',
      command: [cfg.command, ...cfg.args],
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      enabled: true,
    };
  }
  return out;
}
