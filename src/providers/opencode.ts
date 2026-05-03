/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). For OpenAI-compatible
 * backends we also pass through explicit base URL / API key overrides so a
 * group can talk directly to a `/v1/chat/completions` endpoint without
 * relying on Anthropic-shaped config names or Codex-specific auth flows.
 * NO_PROXY / no_proxy are merged with host values so the in-container
 * OpenCode client can talk to 127.0.0.1 even when HTTPS_PROXY is set.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  const opencodeConfigDir = path.join(ctx.sessionDir, 'opencode-config');
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.mkdirSync(opencodeConfigDir, { recursive: true });

  const dotenv = readEnvFile([
    'OPENCODE_PROVIDER',
    'OPENCODE_PROVIDER_NAME',
    'OPENCODE_PROVIDER_PACKAGE',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_BASE_URL',
    'OPENCODE_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
  ]);

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    XDG_CONFIG_HOME: '/opencode-config',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_PROVIDER_NAME',
    'OPENCODE_PROVIDER_PACKAGE',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_BASE_URL',
    'OPENCODE_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
  ] as const) {
    const value = ctx.hostEnv[key] || dotenv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [
      { hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false },
      { hostPath: opencodeConfigDir, containerPath: '/opencode-config', readonly: false },
    ],
    env,
  };
});
