// ============================================================
// Claude Agent SDK — 完整类型定义
// 提取自 agent-sdk-docs-zh 文档
// ============================================================

import type { ChatMessageStatus, RunOutcome } from './run-state';

// --- 权限模式 ---
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

// --- 效能等级 ---
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// --- 思考配置 ---
export type ThinkingConfig =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' };

// --- 工具注解 ---
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// --- MCP 服务器配置 ---
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpSdkServerConfig {
  type: 'sdk';
  name: string;
  version?: string;
}

// --- 权限更新 ---
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

// --- 权限结果 ---
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

// --- CanUseTool 回调 ---
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; toolUseID?: string; agentID?: string }
) => Promise<PermissionResult>;

// --- Hook 事件 ---
export type HookEvent =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch'
  | 'Notification' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'
  | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'PreCompact'
  | 'PermissionRequest' | 'Setup' | 'TeammateIdle' | 'TaskCompleted'
  | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove';

// --- Hook JSON 输出 ---
export interface HookJSONOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  async?: boolean;
  asyncTimeout?: number;
  hookSpecificOutput?: Record<string, unknown>;
}

// --- Hook 回调 ---
export type HookCallback = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

// --- 代理定义 ---
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  mcpServers?: Array<{ name: string; server: McpServerConfig }>;
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  background?: boolean;
  memory?: 'user' | 'project' | 'local';
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

// --- 会话信息 ---
export interface SDKSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

// --- 会话消息 ---
export interface SessionMessage {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

// --- SDK 消息类型 ---
export type SDKMessageType =
  | 'assistant' | 'user' | 'result' | 'system'
  | 'stream_event' | 'status' | 'notification'
  | 'tool_progress' | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_started' | 'task_progress' | 'task_updated' | 'task_notification';

export interface SDKMessage {
  type: SDKMessageType;
  uuid?: string;
  session_id?: string;
  subtype?: string;
  message?: unknown;
  content?: unknown[];
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_tokens?: number; cache_read_tokens?: number };
  model?: string;
  stop_reason?: string;
  num_turns?: number;
  is_error?: boolean;
  errors?: string[];
  event?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
  task_id?: string;
  status?: string;
  permission_mode?: PermissionMode;
  mcp_servers?: McpServerStatus[];
  tools?: string[];
  slash_commands?: SlashCommand[];
  agents?: AgentInfo[];
  modelUsage?: Record<string, { input_tokens: number; output_tokens: number }>;
  permission_denials?: unknown[];
  structured_output?: unknown;
  parent_tool_use_id?: string;
}

// --- MCP 服务器状态 ---
export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  scope?: string;
  tools?: Array<{ name: string; description?: string }>;
}

// --- 斜杠命令 ---
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

// --- 模型信息 ---
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

// --- Agent 信息 ---
export interface AgentInfo {
  name: string;
  description: string;
}

// --- 设置源 ---
export type SettingSource = 'user' | 'project' | 'local';

// --- SDK Options（完整配置） ---
export interface SdkOptions {
  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, AgentDefinition>;
  agentProgressSummaries?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  betas?: string[];
  canUseTool?: CanUseTool;
  continue?: boolean;
  cwd?: string;
  debug?: boolean;
  debugFile?: string;
  disallowedTools?: string[];
  effort?: EffortLevel;
  enableFileCheckpointing?: boolean;
  env?: Record<string, string | undefined>;
  executable?: 'bun' | 'deno' | 'node';
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  fallbackModel?: string;
  forkSession?: boolean;
  forwardSubagentText?: boolean;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  loadTimeoutMs?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  onElicitation?: (message: unknown) => void;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  pathToClaudeCodeExecutable?: string;
  permissionMode?: PermissionMode;
  permissionPromptToolName?: string;
  persistSession?: boolean;
  planModeInstructions?: string;
  plugins?: Array<{ type: 'local'; path: string }>;
  promptSuggestions?: boolean;
  resume?: string;
  resumeSessionAt?: string;
  sandbox?: Record<string, unknown>;
  sessionId?: string;
  sessionStoreFlush?: 'batched' | 'eager';
  settings?: string;
  settingSources?: SettingSource[];
  skills?: string[] | 'all';
  strictMcpConfig?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean };
  taskBudget?: { total: number };
  thinking?: ThinkingConfig;
  title?: string;
  toolAliases?: Record<string, string>;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
}

// --- 内置工具信息 ---
export interface BuiltInTool {
  name: string;
  description: string;
  category: 'file' | 'execution' | 'task' | 'search' | 'interaction' | 'mcp' | 'notebook' | 'agent';
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

// --- 供应商/Provider 配置 (通过 options.env 传递) ---
export interface ProviderConfig {
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
}

export interface ProviderProfile {
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  id: string;
  name: string;
  availableModels: string[];
  modelContextWindows?: Record<string, number>;
  enabled: boolean;
  isDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
  /** Legacy fields kept only for localStorage migration. */
  ANTHROPIC_MODEL?: string;
  modelPatterns?: string;
}

// --- 速率限制 ---
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
}

// --- 文件检查点 ---
export interface FileCheckpoint {
  id: string;
  filePath: string;
  timestamp: number;
  size: number;
  backupPath: string;
}

// --- 待办事项 ---
export interface TodoItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
}

// --- 流式事件 ---
export type StreamEventType =
  | 'content_block_start' | 'content_block_delta' | 'content_block_stop'
  | 'message_start' | 'message_delta' | 'message_stop'
  | 'ping';

export interface StreamEvent {
  type: StreamEventType;
  index?: number;
  content_block?: {
    type: 'text' | 'tool_use' | 'thinking';
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
  };
  usage?: { input_tokens: number; output_tokens: number };
}

// --- Agent 模板 ---
export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  subagents?: Record<string, AgentDefinition>;
  mcpServers: string[];
  eventSources: string[];
  skills: string[];
  effort: EffortLevel;
  maxTurns: number;
  permissionMode: PermissionMode;
  // Legacy: 旧模板可能仍带 Agent 级供应商覆盖；运行时优先使用账户页供应商规则。
  providerOverrides?: Partial<ProviderConfig>;
  // 结构化输出 JSON Schema (可选)
  outputSchema?: Record<string, unknown>;
  // 文件检查点：编辑前快照文件，支持 /rewind 回滚
  enableFileCheckpointing?: boolean;
  // 知识库：允许 agent 只读访问租户配置的本地笔记目录
  useKnowledge?: boolean;
  knowledgeSourceIds?: string[];
  // 视觉预处理：开启后图片先由独立视觉模型识别，再把结果交给 agent。
  visualPreprocessDefault?: boolean;
  visualPreprocessModel?: string;
  // 导入本地 Claude Code 项目时生成的模板级 seed 仓路径。
  seedDir?: string;
  createdBy?: string | null;
  publishedAt?: number | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

// --- 注册的自定义工具 ---
export interface ToolEndpoint {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  bodyTemplate?: string; // JSON 模板，支持 {{param}} 占位符
}

export interface RegisteredTool {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  source?: string; // 'local' | 'github' | 'internal'
  sourceUrl?: string;
  endpoint?: ToolEndpoint; // API 端点调用配置（handler 的实现方式之一）
  mcpServer?: string; // 所属 MCP 服务器名，SDK 调用格式: mcp__{server}__{name}
}

// --- Skill 信息 ---
export interface SkillInfo {
  name: string;
  description: string;
  location: 'project' | 'user' | 'plugin';
  path: string;
  enabled: boolean;
  sourcePath?: string;
  installedPath?: string;
  installed?: boolean;
  learnedFromPublicSkillId?: string;
  learnedFromPublicRevision?: number;
  learnedAt?: number;
}

export interface PublicSkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  authorSub: string;
  authorTenantId: string;
  revision: number;
  publishedAt: number;
  updatedAt: number;
}

// --- 聊天消息 ---
export type ChatImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ChatImageAttachment {
  id: string;
  type: 'image';
  mediaType: ChatImageMimeType;
  data: string;
  name?: string;
  size: number;
}

export interface ChatFileAttachment {
  id: string;
  type: 'file';
  mediaType: string;
  data: string;
  name: string;
  size: number;
}

export type ChatAttachment = ChatImageAttachment | ChatFileAttachment;

export type ChatRunStats = {
  costUsd?: number;
  durationMs?: number;
  inTok?: number;
  outTok?: number;
};

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  status?: ChatMessageStatus;
  outcome?: RunOutcome;
  outcomeDetail?: string;
  runId?: string;
  runStats?: ChatRunStats;
  attachments?: ChatAttachment[];
  timestamp: number;
}

// --- EventSource (事件源，和 MCP Server 同级抽象) ---
export interface EventSourceConfig {
  name: string;
  type: 'ws';  // 未来可扩展: sse, polling
  url: string;  // ws://host:port
  enabled: boolean;
}

// --- 聊天会话 ---
export interface ChatSession {
  id: string;
  ownerSub?: string;
  templateId: string;
  pinned?: boolean;
  title: string;
  messages: ChatMessage[];
  messageCount?: number;
  model: string;
  sdkSessionId?: string;
  sdkCwd?: string;
  visualPreprocessEnabled?: boolean;
  visualPreprocessModel?: string;
  forkedFromSessionId?: string;
  forkedFromTitle?: string;
  collaborationEnabled?: boolean;
  collaborationRole?: 'owner' | 'member';
  collaborationUpdatedAt?: number;
  /** 仅前端使用: 来自服务端响应的会话为 true,本地草稿没有。协作等需要服务端行存在的操作据此门控。 */
  persisted?: boolean;
  createdAt: number;
  updatedAt: number;
}
