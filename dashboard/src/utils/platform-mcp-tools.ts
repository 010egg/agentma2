import type { A2ARemoteAgentConfig } from '../simulator/types';

export const MEMORY_RECALL_TOOL_ID = 'memory.recall';
export const MEMORY_REMEMBER_TOOL_ID = 'memory.remember';
export const MEMORY_PLATFORM_TOOL_IDS = [MEMORY_RECALL_TOOL_ID, MEMORY_REMEMBER_TOOL_ID] as const;
export const A2A_PLATFORM_TOOL_PREFIX = 'a2a.remote.';

export type PlatformMcpToolScope = 'global' | 'template';

export type PlatformMcpToolDescriptor = {
  id: string;
  serverName: 'memory' | 'a2a';
  toolName: string;
  sdkToolName: string;
  displayName: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  scope: PlatformMcpToolScope;
  templateId?: string;
  templateName?: string;
  remoteId?: string;
};

export const STATIC_PLATFORM_MCP_TOOLS: PlatformMcpToolDescriptor[] = [
  {
    id: MEMORY_RECALL_TOOL_ID,
    serverName: 'memory',
    toolName: 'recall',
    sdkToolName: 'mcp__memory__recall',
    displayName: '召回长期记忆',
    description: '按名称读取当前用户的长期记忆正文。记忆按租户和用户隔离。',
    category: '记忆',
    inputSchema: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: 'global',
  },
  {
    id: MEMORY_REMEMBER_TOOL_ID,
    serverName: 'memory',
    toolName: 'remember',
    sdkToolName: 'mcp__memory__remember',
    displayName: '写入长期记忆',
    description: '把以后跨会话可复用的事实写入当前用户的长期记忆。记忆按租户和用户隔离。',
    category: '记忆',
    inputSchema: {
      name: { type: 'string' },
      description: { type: 'string' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
      body: { type: 'string' },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: 'global',
  },
];

export function a2aPlatformToolId(remoteId: string) {
  return `${A2A_PLATFORM_TOOL_PREFIX}${remoteId}`;
}

export function remoteIdFromPlatformToolId(toolId: string) {
  return toolId.startsWith(A2A_PLATFORM_TOOL_PREFIX) ? toolId.slice(A2A_PLATFORM_TOOL_PREFIX.length) : '';
}

export function isMemoryPlatformToolId(toolId: string) {
  return (MEMORY_PLATFORM_TOOL_IDS as readonly string[]).includes(toolId);
}

export function isA2APlatformToolId(toolId: string) {
  return Boolean(remoteIdFromPlatformToolId(toolId));
}

export function mintA2ARemoteId() {
  return globalThis.crypto.randomUUID();
}

export function selectedPlatformToolIds(
  remotes: A2ARemoteAgentConfig[],
  platformMcpTools: string[] | undefined,
  disabledPlatformMcpTools: string[] | undefined,
  legacyUseMemory = true,
) {
  const selected = new Set(platformMcpTools === undefined
    ? legacyUseMemory ? MEMORY_PLATFORM_TOOL_IDS : []
    : platformMcpTools);
  const disabled = new Set(disabledPlatformMcpTools || []);
  for (const remote of remotes) {
    const toolId = a2aPlatformToolId(remote.id);
    if (disabled.has(toolId)) selected.delete(toolId);
    else selected.add(toolId);
  }
  return Array.from(selected);
}

export function buildA2APlatformToolDescriptor(
  template: { id: string; name: string },
  remote: A2ARemoteAgentConfig,
  sdkToolName = '',
): PlatformMcpToolDescriptor {
  const localName = remote.name.trim() || '远程 Agent';
  return {
    id: a2aPlatformToolId(remote.id),
    serverName: 'a2a',
    toolName: sdkToolName.replace(/^mcp__a2a__/, '') || `remote_${remote.id.replace(/[^A-Za-z0-9]+/g, '_')}`,
    sdkToolName: sdkToolName || `mcp__a2a__remote_${remote.id.replace(/[^A-Za-z0-9]+/g, '_')}`,
    displayName: `调用 ${localName}`,
    description: `通过 Agent Card 发现并调用远程 A2A Agent“${localName}”。A2A 传输使用 HTTP + JSON-RPC；MCP 仅作为本地 SDK 工具适配层。`,
    category: 'A2A Agent',
    inputSchema: {
      text: { type: 'string' },
      data: {},
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: 'template',
    templateId: template.id,
    templateName: template.name,
    remoteId: remote.id,
  };
}
