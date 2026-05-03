import { describe, it, expect } from 'bun:test';

import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

describe('mcpServersToOpenCodeConfig', () => {
  it('maps nanoclaw + extra server like v2 index.ts merge', () => {
    const servers = {
      nanoclaw: {
        command: 'node',
        args: ['/app/src/mcp-tools/index.js'],
        env: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        },
      },
      extra: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { FOO: 'bar' },
      },
    };

    const mcp = mcpServersToOpenCodeConfig(servers, {
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: '/tmp/proxy-ca.pem',
      OPENAI_API_KEY: 'not-inherited',
    });

    expect(mcp.nanoclaw).toEqual({
      type: 'local',
      command: ['node', '/app/src/mcp-tools/index.js'],
      environment: {
        SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        HTTPS_PROXY: 'http://proxy.example',
        NODE_EXTRA_CA_CERTS: '/tmp/proxy-ca.pem',
        SSL_CERT_FILE: '/tmp/proxy-ca.pem',
        REQUESTS_CA_BUNDLE: '/tmp/proxy-ca.pem',
        CURL_CA_BUNDLE: '/tmp/proxy-ca.pem',
      },
      enabled: true,
    });

    expect(mcp.extra).toEqual({
      type: 'local',
      command: ['npx', '-y', 'some-mcp'],
      environment: {
        FOO: 'bar',
        HTTPS_PROXY: 'http://proxy.example',
        NODE_EXTRA_CA_CERTS: '/tmp/proxy-ca.pem',
        SSL_CERT_FILE: '/tmp/proxy-ca.pem',
        REQUESTS_CA_BUNDLE: '/tmp/proxy-ca.pem',
        CURL_CA_BUNDLE: '/tmp/proxy-ca.pem',
      },
      enabled: true,
    });
  });

  it('omits environment when env is empty', () => {
    const mcp = mcpServersToOpenCodeConfig(
      {
        x: { command: 'true', args: [], env: {} },
      },
      {},
    );
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });
});
