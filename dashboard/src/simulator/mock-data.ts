import type {
  SDKSessionInfo, SessionMessage, SDKMessage, McpServerStatus,
  SlashCommand, ModelInfo, AgentInfo, AgentDefinition,
  BuiltInTool, TodoItem, FileCheckpoint, RateLimitInfo,
  HookEvent, StreamEvent, SdkOptions,
  PermissionMode, ProviderConfig, SkillInfo, RegisteredTool,
} from './types';

// --- 内置工具列表 ---
export const BUILT_IN_TOOLS: BuiltInTool[] = [
  { name: 'Agent', description: '生成子代理执行复杂任务', category: 'agent', inputSchema: { description: 'string', prompt: 'string', subagent_type: 'string' } },
  { name: 'AskUserQuestion', description: '向用户提问', category: 'interaction', inputSchema: { questions: 'array' } },
  { name: 'Bash', description: '执行 shell 命令', category: 'execution', inputSchema: { command: 'string', timeout: 'number?', description: 'string?' } },
  { name: 'Read', description: '读取文件内容', category: 'file', inputSchema: { file_path: 'string', offset: 'number?', limit: 'number?' } },
  { name: 'Write', description: '写入文件', category: 'file', inputSchema: { file_path: 'string', content: 'string' } },
  { name: 'Edit', description: '编辑文件（精确替换）', category: 'file', inputSchema: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean?' } },
  { name: 'Glob', description: '按模式搜索文件', category: 'search', inputSchema: { pattern: 'string' } },
  { name: 'Grep', description: '搜索文件内容', category: 'search', inputSchema: { pattern: 'string', path: 'string?' } },
  { name: 'TaskCreate', description: '创建任务', category: 'task', inputSchema: { subject: 'string', description: 'string' } },
  { name: 'TaskUpdate', description: '更新任务状态', category: 'task', inputSchema: { taskId: 'string', status: 'string' } },
  { name: 'TaskGet', description: '获取任务详情', category: 'task', inputSchema: { taskId: 'string' } },
  { name: 'TaskList', description: '列出所有任务', category: 'task', inputSchema: {} },
  { name: 'TaskStop', description: '停止任务', category: 'task', inputSchema: { taskId: 'string' } },
  { name: 'TaskOutput', description: '获取后台任务输出', category: 'task', inputSchema: { taskId: 'string', block: 'boolean?', timeout: 'number?' } },
  { name: 'WebSearch', description: '搜索网页', category: 'search', inputSchema: { query: 'string' } },
  { name: 'WebFetch', description: '获取网页内容', category: 'search', inputSchema: { url: 'string', prompt: 'string' } },
  { name: 'NotebookEdit', description: '编辑 Jupyter notebook', category: 'notebook', inputSchema: { notebook_path: 'string', new_source: 'string' } },
  { name: 'ExitPlanMode', description: '退出规划模式', category: 'interaction', inputSchema: {} },
  { name: 'EnterWorktree', description: '进入 git worktree', category: 'execution', inputSchema: { name: 'string?' } },
  { name: 'Skill', description: '调用技能', category: 'interaction', inputSchema: { skill: 'string', args: 'string?' } },
  { name: 'ToolSearch', description: 'SDK 工具发现机制（非普通 MCP 工具）', category: 'search', inputSchema: { query: 'string' } },
  { name: 'ListMcpResources', description: '列出 MCP 资源', category: 'mcp', inputSchema: { server: 'string' } },
  { name: 'ReadMcpResource', description: '读取 MCP 资源', category: 'mcp', inputSchema: { server: 'string', uri: 'string' } },
];

// --- Hook 事件列表 ---
export const HOOK_EVENTS: { name: HookEvent; description: string; category: 'tool' | 'session' | 'agent' | 'notification' | 'config' }[] = [
  { name: 'PreToolUse', description: '工具调用前触发', category: 'tool' },
  { name: 'PostToolUse', description: '工具调用成功后触发', category: 'tool' },
  { name: 'PostToolUseFailure', description: '工具调用失败后触发', category: 'tool' },
  { name: 'PostToolBatch', description: '批量工具调用完成后触发', category: 'tool' },
  { name: 'Notification', description: '系统通知时触发', category: 'notification' },
  { name: 'UserPromptSubmit', description: '用户提交提示词时触发', category: 'session' },
  { name: 'SessionStart', description: '会话启动时触发', category: 'session' },
  { name: 'SessionEnd', description: '会话结束时触发', category: 'session' },
  { name: 'Stop', description: '代理停止时触发', category: 'agent' },
  { name: 'SubagentStart', description: '子代理启动时触发', category: 'agent' },
  { name: 'SubagentStop', description: '子代理停止时触发', category: 'agent' },
  { name: 'PreCompact', description: '上下文压缩前触发', category: 'session' },
  { name: 'PermissionRequest', description: '权限请求时触发', category: 'tool' },
  { name: 'Setup', description: '初始化或维护时触发', category: 'config' },
  { name: 'TeammateIdle', description: '队友空闲时触发', category: 'agent' },
  { name: 'TaskCompleted', description: '任务完成时触发', category: 'notification' },
  { name: 'ConfigChange', description: '配置变更时触发', category: 'config' },
  { name: 'WorktreeCreate', description: '创建 worktree 时触发', category: 'config' },
  { name: 'WorktreeRemove', description: '移除 worktree 时触发', category: 'config' },
];

// --- MCP 服务器模拟 ---
export const MOCK_MCP_SERVERS: McpServerStatus[] = [
  { name: 'filesystem', status: 'connected', serverInfo: { name: 'filesystem', version: '1.0.0' }, tools: [{ name: 'read_file', description: '读取文件' }, { name: 'write_file', description: '写入文件' }] },
  { name: 'github', status: 'connected', serverInfo: { name: 'github', version: '0.2.1' }, tools: [{ name: 'create_issue', description: '创建 Issue' }, { name: 'search_code', description: '搜索代码' }] },
  { name: 'postgres', status: 'failed', error: 'Connection refused', serverInfo: { name: 'postgres', version: '2.0.0' } },
  { name: 'slack', status: 'needs-auth', serverInfo: { name: 'slack', version: '1.5.0' } },
  { name: 'jira', status: 'disabled', serverInfo: { name: 'jira', version: '3.1.0' } },
];

// --- 斜杠命令 ---
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: '获取帮助', argumentHint: '' },
  { name: '/clear', description: '清除对话历史', argumentHint: '' },
  { name: '/compact', description: '压缩上下文', argumentHint: '' },
  { name: '/config', description: '修改配置', argumentHint: '<key> <value>' },
  { name: '/cost', description: '查看费用', argumentHint: '' },
  { name: '/doctor', description: '诊断环境问题', argumentHint: '' },
  { name: '/init', description: '初始化项目 CLAUDE.md', argumentHint: '' },
  { name: '/model', description: '切换模型', argumentHint: '[model-name]' },
  { name: '/permissions', description: '管理权限', argumentHint: '' },
  { name: '/pr-comments', description: '查看 PR 评论', argumentHint: '' },
  { name: '/release-notes', description: '查看发行说明', argumentHint: '' },
  { name: '/review', description: '代码审查', argumentHint: '' },
  { name: '/upgrade', description: '升级 CLI', argumentHint: '' },
  { name: '/vim', description: 'Vim 模式', argumentHint: '' },
];

// --- 模型列表 ---
export const MODELS: ModelInfo[] = [
  { value: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', description: '最强大的模型，适合复杂推理和代理任务' },
  { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', description: '平衡性能与速度' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', description: '最快模型，适合简单任务' },
];

// --- 权限模式列表 ---
export const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '每次操作都询问确认' },
  { value: 'acceptEdits', label: '接受编辑', description: '自动批准文件编辑操作' },
  { value: 'bypassPermissions', label: '绕过权限', description: '跳过所有权限检查（高风险）' },
  { value: 'plan', label: '规划模式', description: '只读模式，不执行修改' },
  { value: 'dontAsk', label: '不再询问', description: '记住用户选择' },
  { value: 'auto', label: '自动', description: '由 SDK 自动决定' },
];

// --- 效能等级 ---
export const EFFORT_LEVELS: { value: string; label: string; description: string }[] = [
  { value: 'low', label: '低', description: '快速响应' },
  { value: 'medium', label: '中', description: '适中推理' },
  { value: 'high', label: '高', description: '深入推理（默认）' },
  { value: 'xhigh', label: '极高', description: '最大推理深度' },
  { value: 'max', label: '极限', description: '启用 extended thinking' },
];

// --- 模拟会话 ---
export function generateMockSessions(): SDKSessionInfo[] {
  return [
    { sessionId: 'sess-001', summary: '修复登录页面响应式布局问题', lastModified: Date.now() - 120000, customTitle: '登录页修复', firstPrompt: '帮我修复登录页面的响应式布局', gitBranch: 'fix/login-responsive', cwd: '/projects/webapp', tag: 'bugfix', createdAt: Date.now() - 86400000 },
    { sessionId: 'sess-002', summary: '为用户 API 添加分页功能', lastModified: Date.now() - 3600000, customTitle: 'API 分页', firstPrompt: '请为用户列表 API 添加分页', gitBranch: 'feat/pagination', cwd: '/projects/api', createdAt: Date.now() - 172800000 },
    { sessionId: 'sess-003', summary: '优化数据库查询性能', lastModified: Date.now() - 7200000, customTitle: 'DB 性能优化', firstPrompt: '分析并优化慢查询', cwd: '/projects/api', tag: 'performance', createdAt: Date.now() - 259200000 },
    { sessionId: 'sess-004', summary: '实现暗色模式切换', lastModified: Date.now() - 14400000, customTitle: '暗色模式', firstPrompt: '给整个应用添加暗色模式', gitBranch: 'feat/dark-mode', cwd: '/projects/webapp', createdAt: Date.now() - 345600000 },
    { sessionId: 'sess-005', summary: '重构认证中间件', lastModified: Date.now() - 86400000, customTitle: '认证重构', firstPrompt: '重构认证中间件以支持 JWT', gitBranch: 'refactor/auth', cwd: '/projects/api', createdAt: Date.now() - 432000000 },
  ];
}

// --- 模拟会话消息 ---
export function generateMockMessages(sessionId: string): SessionMessage[] {
  return [
    { type: 'user', uuid: 'msg-001', session_id: sessionId, message: { role: 'user', content: '帮我分析这个项目的结构' }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'msg-002', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: '好的，让我先了解项目结构。' }] }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'msg-003', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'tool-001', input: { command: 'ls -la' } }] }, parent_tool_use_id: null },
    { type: 'user', uuid: 'msg-004', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-001', content: 'total 48\ndrwxr-xr-x ...' }] }, parent_tool_use_id: 'msg-003' },
    { type: 'assistant', uuid: 'msg-005', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: '项目结构分析完成：这是一个 React + TypeScript 项目，使用 Vite 构建。主要目录有 src/components、src/pages、src/hooks。' }] }, parent_tool_use_id: null },
  ];
}

// --- 代理列表 ---
export function generateMockAgents(): AgentInfo[] {
  return [
    { name: 'general-purpose', description: '通用代理，处理各种任务' },
    { name: 'claude-code-guide', description: 'Claude Code 使用指南专家' },
    { name: 'Explore', description: '代码探索搜索代理' },
    { name: 'Plan', description: '软件架构设计代理' },
    { name: 'code-reviewer', description: '代码审查代理' },
    { name: 'statusline-setup', description: '状态行配置助手' },
  ];
}

// --- 子代理定义 ---
export function generateMockSubagents(): AgentDefinition[] {
  return [
    { description: '代码审查专家', prompt: '你是一位资深代码审查专家。请审查代码变更，关注安全性、性能和代码质量。', tools: ['Read', 'Grep', 'Glob', 'Bash'], model: 'claude-sonnet-4-6', effort: 'high' },
    { description: '测试编写助手', prompt: '你是一位测试工程师。请为代码编写全面的单元测试和集成测试。', tools: ['Read', 'Write', 'Edit', 'Bash'], model: 'claude-haiku-4-5-20251001', effort: 'medium', background: true },
    { description: '文档生成器', prompt: '你是一位技术文档撰写者。请生成清晰、准确的 API 文档和注释。', tools: ['Read', 'Write', 'Edit', 'Glob'], model: 'claude-sonnet-4-6', memory: 'project' },
  ];
}

// --- 待办事项 ---
export function generateMockTodos(): TodoItem[] {
  return [
    { id: 'todo-1', subject: '分析项目结构', description: '使用 Explore agent 了解代码库结构', status: 'completed' },
    { id: 'todo-2', subject: '实现用户认证', description: '添加 JWT 认证中间件', status: 'in_progress', blockedBy: ['todo-1'] },
    { id: 'todo-3', subject: '编写单元测试', description: '为核心模块编写测试用例', status: 'pending', blockedBy: ['todo-2'] },
    { id: 'todo-4', subject: '优化查询性能', description: '分析并优化数据库慢查询', status: 'pending' },
    { id: 'todo-5', subject: '部署到生产环境', description: '执行生产环境部署流程', status: 'pending', blockedBy: ['todo-3'] },
  ];
}

// --- 文件检查点 ---
export function generateMockCheckpoints(): FileCheckpoint[] {
  return [
    { id: 'cp-001', filePath: 'src/auth/middleware.ts', timestamp: Date.now() - 3600000, size: 4096, backupPath: '.claude/checkpoints/cp-001' },
    { id: 'cp-002', filePath: 'src/api/users.ts', timestamp: Date.now() - 7200000, size: 8192, backupPath: '.claude/checkpoints/cp-002' },
    { id: 'cp-003', filePath: 'src/components/Login.tsx', timestamp: Date.now() - 14400000, size: 3072, backupPath: '.claude/checkpoints/cp-003' },
  ];
}

// --- 速率限制 ---
export function generateMockRateLimit(): RateLimitInfo {
  return {
    status: 'allowed',
    rateLimitType: 'five_hour',
    utilization: 0.35,
    resetsAt: Date.now() + 18000000,
  };
}

// --- 供应商默认配置 ---
export function getDefaultProviderConfig(): ProviderConfig {
  return {
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: '',
  };
}

// --- 根据 prompt 推断意图 ---
type Intent = 'greeting' | 'code_edit' | 'code_search' | 'search' | 'task' | 'meta' | 'general';

function detectIntent(prompt: string): Intent {
  const p = prompt.toLowerCase();
  if (/^(你好|hi|hello|hey|早上好|晚上好|下午好)[\s!！。.,，]*$/.test(p)) return 'greeting';
  if (/修改|修复|fix|改|refactor|重构|edit|write|写|创建|添加|实现/.test(p)) return 'code_edit';
  if (/查看|读取|分析项目|了解项目|解释|explain|review代码|检查代码|read/.test(p)) return 'code_search';
  if (/搜索|search|查询|查一下|找|什么是|怎么|如何|how|what|why/.test(p) && !/模型|model|你是谁|版本/.test(p)) return 'search';
  if (/任务|task|todo|计划|plan/.test(p)) return 'task';
  if (/模型|model|你是谁|你是什么|版本|version|你的|能力|能做什么|帮助/.test(p)) return 'meta';
  return 'general';
}

function rng(min: number, max: number) { return min + Math.floor(Math.random() * (max - min)); }

// --- 生成流式消息序列（根据 prompt 内容动态生成） ---
export function generateStreamSequence(prompt: string, model = 'claude-sonnet-4-6'): SDKMessage[] {
  const intent = detectIntent(prompt);
  const msgs: SDKMessage[] = [];

  // 1. 系统初始化消息
  msgs.push({
    type: 'system', subtype: 'init', uuid: 'init-001', session_id: 'sess-live',
    model, permission_mode: 'default',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    mcp_servers: MOCK_MCP_SERVERS, slash_commands: SLASH_COMMANDS, agents: generateMockAgents(),
  });

  // 2. 根据意图生成对应的对话
  switch (intent) {
    case 'greeting': {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `你好！👋\n\n我是 Claude Agent SDK 的 AI 助手。我可以帮你：\n\n- 📝 编写和修改代码\n- 🔍 搜索和分析文件\n- 🧪 运行测试和命令\n- 🌐 搜索网络信息\n- 📊 管理任务和计划\n\n有什么我可以帮你的吗？` }] },
        model,
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(400, 900), duration_api_ms: rng(300, 700),
        is_error: false, num_turns: 1, result: '已响应问候',
        stop_reason: 'end_turn', total_cost_usd: +(rng(1, 3) / 1000).toFixed(4),
        usage: { input_tokens: rng(50, 150), output_tokens: rng(80, 200) },
        modelUsage: { [model]: { input_tokens: rng(50, 150), output_tokens: rng(80, 200) } },
        permission_denials: [],
      });
      break;
    }

    case 'code_edit': {
      const filePath = 'src/utils/helpers.ts';
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `好的，让我来处理你的请求："${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}"\n\n我先读取相关文件了解当前代码。` }] },
        model,
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-002', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', id: 'tool-001', input: { pattern: 'export function', path: 'src/' } }] },
        model,
      });
      msgs.push({
        type: 'user', uuid: 'msg-003', session_id: 'sess-live',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-001', content: 'src/utils/helpers.ts:3: export function formatDate(\nsrc/utils/helpers.ts:15: export function parseJSON(\nsrc/services/api.ts:22: export function fetchUsers(' }] },
        parent_tool_use_id: 'msg-002',
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-004', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'tool-002', input: { file_path: filePath } }] },
        model,
      });
      msgs.push({
        type: 'user', uuid: 'msg-005', session_id: 'sess-live',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-002', content: 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n\nexport function parseJSON<T>(raw: string): T | null {\n  try { return JSON.parse(raw); } catch { return null; }\n}' }] },
        parent_tool_use_id: 'msg-004',
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-006', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'tool-003', input: { file_path: filePath, old_string: 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}', new_string: 'export function formatDate(d: Date, locale = "zh-CN"): string {\n  return d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });\n}' } }] },
        model,
      });
      msgs.push({
        type: 'user', uuid: 'msg-007', session_id: 'sess-live',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-003', content: '文件已修改，1 处替换完成。' }] },
        parent_tool_use_id: 'msg-006',
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-008', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `已完成。修改了 \`${filePath}\`：\n\n1. **formatDate** — 添加了 locale 参数，支持本地化日期格式\n2. 默认使用中文本地化格式，向后兼容\n\n工具使用：Grep → Read → Edit，共 3 次工具调用。` }] },
        model, usage: { input_tokens: rng(800, 1500), output_tokens: rng(200, 500) },
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(1800, 4000), duration_api_ms: rng(1200, 3000),
        is_error: false, num_turns: rng(3, 5), result: '代码修改完成',
        stop_reason: 'end_turn', total_cost_usd: +(rng(10, 40) / 1000).toFixed(4),
        usage: { input_tokens: rng(800, 1500), output_tokens: rng(200, 500) },
        modelUsage: {  [model]: { input_tokens: rng(800, 1500), output_tokens: rng(200, 500) } },
        permission_denials: [],
      });
      break;
    }

    case 'code_search': {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `关于"${prompt.slice(0, 40)}"，让我来分析一下。` }] },
        model,
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-002', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Glob', id: 'tool-001', input: { pattern: 'src/**/*.ts' } }] },
        model,
      });
      msgs.push({
        type: 'user', uuid: 'msg-003', session_id: 'sess-live',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-001', content: 'src/index.ts\nsrc/App.tsx\nsrc/components/Header.tsx\nsrc/utils/helpers.ts\nsrc/services/api.ts\nsrc/hooks/useAuth.ts' }] },
        parent_tool_use_id: 'msg-002',
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-004', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `项目结构分析：\n\n这是一个 TypeScript + React 项目，包含以下模块：\n\n- **入口**: \`src/index.ts\`\n- **主组件**: \`src/App.tsx\`\n- **组件**: \`src/components/Header.tsx\`\n- **工具**: \`src/utils/helpers.ts\`\n- **服务**: \`src/services/api.ts\`\n- **Hooks**: \`src/hooks/useAuth.ts\`\n\n总计 6 个 TypeScript 文件。需要我深入分析哪个文件？` }] },
        model, usage: { input_tokens: rng(300, 800), output_tokens: rng(150, 400) },
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(1000, 3000), duration_api_ms: rng(800, 2000),
        is_error: false, num_turns: 2, result: '分析完成',
        stop_reason: 'end_turn', total_cost_usd: +(rng(5, 20) / 1000).toFixed(4),
        usage: { input_tokens: rng(300, 800), output_tokens: rng(150, 400) },
        modelUsage: {  [model]: { input_tokens: rng(300, 800), output_tokens: rng(150, 400) } },
        permission_denials: [],
      });
      break;
    }

    case 'search': {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `让我搜索一下："${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"` }] },
        model,
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-002', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'WebSearch', id: 'tool-001', input: { query: prompt } }] },
        model,
      });
      msgs.push({
        type: 'user', uuid: 'msg-003', session_id: 'sess-live',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-001', content: '[搜索结果]\n1. 相关文档链接...\n2. 社区讨论...\n3. 官方指南...\n\n共找到 3 条相关结果。' }] },
        parent_tool_use_id: 'msg-002',
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-004', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `根据搜索结果：\n\n关于"${prompt.slice(0, 30)}"，找到了以下相关信息。这涉及到几个关键方面需要进一步说明。你想深入了解哪个方向？` }] },
        model, usage: { input_tokens: rng(200, 600), output_tokens: rng(100, 300) },
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(2000, 5000), duration_api_ms: rng(1500, 3500),
        is_error: false, num_turns: 2, result: '搜索完成',
        stop_reason: 'end_turn', total_cost_usd: +(rng(10, 30) / 1000).toFixed(4),
        usage: { input_tokens: rng(200, 600), output_tokens: rng(100, 300) },
        modelUsage: {  [model]: { input_tokens: rng(200, 600), output_tokens: rng(100, 300) } },
        permission_denials: [],
      });
      break;
    }

    case 'task': {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `收到任务请求。让我先创建任务列表来跟踪进度。` }] },
        model,
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-002', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', id: 'task-001', input: { subject: '分析需求', description: '理解用户需求并制定计划' } }] },
        model,
      });
      msgs.push({
        type: 'assistant', uuid: 'msg-003', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `我创建了任务来跟踪这个请求。当前计划：\n\n1. 分析需求 — pending\n2. 实现方案 — pending\n3. 验证测试 — pending\n\n需要我开始执行吗？` }] },
        model,
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(800, 2000), duration_api_ms: rng(500, 1500),
        is_error: false, num_turns: 2, result: '任务已创建',
        stop_reason: 'end_turn', total_cost_usd: +(rng(3, 12) / 1000).toFixed(4),
        usage: { input_tokens: rng(200, 500), output_tokens: rng(100, 250) },
        modelUsage: {  [model]: { input_tokens: rng(200, 500), output_tokens: rng(100, 250) } },
        permission_denials: [],
      });
      break;
    }

    case 'meta': {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `我是通过 Claude Agent SDK 运行的 AI 助手。\n\n当前配置：\n- **模型**: \`${model}\`\n- **SDK 包**: \`@anthropic-ai/claude-agent-sdk\` (TypeScript) / \`claude-agent-sdk\` (Python)\n- **核心 API**: \`query(prompt, options?) → AsyncGenerator<SDKMessage>\`\n\n这个 Playground 本身是一个前端演示，消息流由 JS 模拟器生成，用于展示 SDK 的接口行为。实际使用时，\`query()\` 会真正启动 Claude CLI 子进程并通过消息流与之通信。\n\n关于你的问题："${prompt.slice(0, 40)}"——我作为模拟环境无法执行真实操作，但可以通过以下工具处理你的需求：\n\n- 📝 \`Read\` / \`Write\` / \`Edit\` — 文件操作\n- 💻 \`Bash\` — 执行命令\n- 🌐 \`WebSearch\` / \`WebFetch\` — 网络搜索\n- 📋 \`TaskCreate\` / \`TaskUpdate\` — 任务管理` }] },
        model,
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(400, 900), duration_api_ms: rng(300, 600),
        is_error: false, num_turns: 1, result: '已响应',
        stop_reason: 'end_turn', total_cost_usd: +(rng(1, 4) / 1000).toFixed(4),
        usage: { input_tokens: rng(60, 200), output_tokens: rng(100, 300) },
        modelUsage: { [model]: { input_tokens: rng(60, 200), output_tokens: rng(100, 300) } },
        permission_denials: [],
      });
      break;
    }

    default: {
      msgs.push({
        type: 'assistant', uuid: 'msg-001', session_id: 'sess-live',
        message: { role: 'assistant', content: [{ type: 'text', text: `关于 "${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}"——\n\n这个 Playground 是 SDK 接口的可视化演示。你的输入对应 SDK 中的：\n\n\`\`\`ts\nconst stream = query("${prompt.slice(0, 30)}...", options);\nfor await (const msg of stream) {\n  // msg 就是下方显示的每条消息\n}\n\`\`\`\n\n如果你是想要完成具体任务，可以试试这些关键词：修bug、分析代码、实现功能、网络搜索等，我会用不同的工具组合来展示 SDK 的完整消息流。\n\n当前模型: \`${model}\`` }] },
        model,
      });
      msgs.push({
        type: 'result', subtype: 'success', uuid: 'result-001', session_id: 'sess-live',
        duration_ms: rng(500, 1200), duration_api_ms: rng(300, 800),
        is_error: false, num_turns: 1, result: '已响应',
        stop_reason: 'end_turn', total_cost_usd: +(rng(1, 5) / 1000).toFixed(4),
        usage: { input_tokens: rng(80, 300), output_tokens: rng(80, 250) },
        modelUsage: { [model]: { input_tokens: rng(80, 300), output_tokens: rng(80, 250) } },
        permission_denials: [],
      });
    }
  }

  return msgs;
}

// --- 生成实时流事件 ---
export function generateStreamEvents(): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的，' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '让我来' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '分析这个问题。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_001', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"src/index.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop', usage: { input_tokens: 450, output_tokens: 120 } },
  ];
}

// --- Hook 模拟输出 ---
export function generateHookLog(hookEvent: HookEvent, toolName?: string): { event: HookEvent; input: Record<string, unknown>; output: Record<string, unknown>; timestamp: number } {
  return {
    event: hookEvent,
    timestamp: Date.now(),
    input: {
      hook_event_name: hookEvent,
      session_id: 'sess-live',
      cwd: '/projects/app',
      tool_name: toolName,
      tool_input: toolName ? { file_path: '/path/to/file.ts' } : undefined,
      tool_use_id: toolName ? 'tool-001' : undefined,
    },
    output: {
      continue: true,
      decision: 'approve' as const,
      hookSpecificOutput: hookEvent === 'PreToolUse'
        ? { permissionDecision: 'allow', permissionDecisionReason: '安全的读取操作' }
        : undefined,
    },
  };
}

// --- 默认 SDK Options ---
export function getDefaultOptions(): SdkOptions {
  return {
    model: 'claude-sonnet-4-6',
    permissionMode: 'default',
    effort: 'high',
    maxTurns: 50,
    maxBudgetUsd: 10,
    persistSession: true,
    includePartialMessages: true,
    includeHookEvents: false,
    enableFileCheckpointing: true,
    sessionStoreFlush: 'batched',
    thinking: { type: 'adaptive' },
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    betas: [],
    strictMcpConfig: false,
    agentProgressSummaries: false,
  };
}

// --- 默认技能 ---
export const DEFAULT_SKILLS: SkillInfo[] = [
  { name: 'pdf', description: '处理和解析 PDF 文档', location: 'user', path: '~/.claude/skills/pdf/', enabled: true },
  { name: 'docx', description: '读写 Word 文档 (.docx)', location: 'user', path: '~/.claude/skills/docx/', enabled: true },
  { name: 'xlsx', description: '读写 Excel 电子表格', location: 'user', path: '~/.claude/skills/xlsx/', enabled: false },
  { name: 'pptx', description: '创建和编辑 PPT 演示文稿', location: 'user', path: '~/.claude/skills/pptx/', enabled: false },
  { name: 'agentma-visual', description: '把内容渲染成可预览和保存的 HTML/Markdown 可视化', location: 'user', path: '~/.claude/skills/agentma-visual/', enabled: true },
  { name: 'code-review', description: '自动化代码审查助手', location: 'project', path: '.claude/skills/code-review/', enabled: true },
  { name: 'i18n-helper', description: '国际化翻译辅助工具', location: 'project', path: '.claude/skills/i18n-helper/', enabled: false },
  { name: 'api-doc-gen', description: '从代码生成 API 文档', location: 'project', path: '.claude/skills/api-doc-gen/', enabled: true },
  { name: 'db-migration', description: '数据库迁移脚本生成器', location: 'project', path: '.claude/skills/db-migration/', enabled: false },
  { name: 'docker-helper', description: 'Docker 容器管理助手', location: 'plugin', path: '~/.claude/plugins/docker/skills/', enabled: true },
  { name: 'git-assistant', description: 'Git 工作流辅助', location: 'plugin', path: '~/.claude/plugins/git/skills/', enabled: true },
];

export function initSkills(): SkillInfo[] {
  const key = 'agentma_skills';
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
      const existingNames = new Set(parsed.map((skill: SkillInfo) => skill?.name).filter(Boolean));
      const missingDefaults = DEFAULT_SKILLS.filter((skill) => !existingNames.has(skill.name));
      const merged = missingDefaults.length ? [...parsed, ...missingDefaults] : parsed;
      if (missingDefaults.length) localStorage.setItem(key, JSON.stringify(merged));
      return merged;
    }
  } catch {}
  // 首次初始化：写入默认技能
  localStorage.setItem(key, JSON.stringify(DEFAULT_SKILLS));
  return DEFAULT_SKILLS;
}

export function saveSkills(skills: SkillInfo[]) {
  localStorage.setItem('agentma_skills', JSON.stringify(skills));
}

// --- 自定义工具持久化 ---
const DEFAULT_CUSTOM_TOOLS: RegisteredTool[] = [
  {
    name: 'mineflayer-chat',
    description: '向 Minecraft 机器人发送聊天消息并获取回复',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { message: 'string', bot_name: 'string?' },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/chat', method: 'POST', bodyTemplate: '{"message": "{{message}}", "bot": "{{bot_name}}"}' },
  },
  {
    name: 'mineflayer-move',
    description: '让机器人移动到指定坐标或跟随玩家',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { x: 'number', y: 'number?', z: 'number', follow: 'string?', bot_name: 'string?' },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/move', method: 'POST', bodyTemplate: '{"x": {{x}}, "y": {{y}}, "z": {{z}}, "follow": "{{follow}}", "bot": "{{bot_name}}"}' },
  },
  {
    name: 'mineflayer-inventory',
    description: '查看机器人背包物品列表',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { bot_name: 'string?' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/inventory', method: 'GET' },
  },
  {
    name: 'mineflayer-dig',
    description: '让机器人挖掘或放置方块',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { action: "'dig' | 'place'", x: 'number', y: 'number', z: 'number', block_type: 'string?', bot_name: 'string?' },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/block', method: 'POST', bodyTemplate: '{"action": "{{action}}", "x": {{x}}, "y": {{y}}, "z": {{z}}, "block": "{{block_type}}", "bot": "{{bot_name}}"}' },
  },
  {
    name: 'mineflayer-nearby',
    description: '查看机器人附近的玩家和实体',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { radius: 'number?', type: "'player' | 'mob' | 'all'?", bot_name: 'string?' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/nearby', method: 'GET' },
  },
  {
    name: 'mineflayer-status',
    description: '查看机器人健康值、饥饿度、位置、装备等状态',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { bot_name: 'string?' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/status', method: 'GET' },
  },
  {
    name: 'mineflayer-craft',
    description: '合成指定物品',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { item: 'string', count: 'number?', bot_name: 'string?' },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/craft', method: 'POST', bodyTemplate: '{"item": "{{item}}", "count": {{count}}, "bot": "{{bot_name}}"}' },
  },
  {
    name: 'mineflayer-attack',
    description: '让机器人攻击指定实体',
    category: 'Minecraft',
    mcpServer: 'minecraft',
    inputSchema: { target: 'string', type: "'player' | 'mob'?", bot_name: 'string?' },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    source: 'local',
    endpoint: { url: 'http://localhost:3005/api/attack', method: 'POST', bodyTemplate: '{"target": "{{target}}", "type": "{{type}}", "bot": "{{bot_name}}"}' },
  },
];

export function initCustomTools(): RegisteredTool[] {
  const key = 'agentma_custom_tools';
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const existing: RegisteredTool[] = JSON.parse(raw);
      let changed = false;
      for (const dt of DEFAULT_CUSTOM_TOOLS) {
        const found = existing.find(t => t.name === dt.name);
        if (!found) {
          existing.push(dt);
          changed = true;
        } else {
          // 补齐缺失字段 (如旧数据没有 mcpServer/endpoint)
          if (!found.mcpServer && dt.mcpServer) { found.mcpServer = dt.mcpServer; changed = true; }
          if (!found.endpoint && dt.endpoint) { found.endpoint = dt.endpoint; changed = true; }
          if (!found.category && dt.category) { found.category = dt.category; changed = true; }
        }
      }
      if (changed) localStorage.setItem(key, JSON.stringify(existing));
      return existing;
    }
  } catch {}
  localStorage.setItem(key, JSON.stringify(DEFAULT_CUSTOM_TOOLS));
  return DEFAULT_CUSTOM_TOOLS;
}

export function saveCustomTools(tools: RegisteredTool[]) {
  localStorage.setItem('agentma_custom_tools', JSON.stringify(tools));
}

// 生成 Minecraft MCP 服务端代码
export function genMinecraftServerCode(server: string, port: string, botName = 'LianLian') {
  return [
    `// MCP Server: ${server} — Minecraft Bot (${botName})`,
    `// 安装依赖: npm install mineflayer mineflayer-pathfinder`,
    `const mineflayer = require('mineflayer');`,
    `const pathfinder = require('mineflayer-pathfinder').pathfinder;`,
    `const http = require('http');`,
    ``,
    `const bot = mineflayer.createBot({`,
    `  host: process.env.MC_HOST || 'localhost',`,
    `  port: Number(process.env.MC_PORT) || 25565,`,
    `  username: process.env.MC_USERNAME || '${botName}',`,
    `  auth: 'offline',`,
    `});`,
    ``,
    `bot.loadPlugin(pathfinder);`,
    `bot.once('spawn', () => { console.log('[bot] spawned at', bot.entity.position); broadcast({ type: 'spawn', position: bot.entity.position }); });`,
    `bot.on('error', e => { console.log('[bot] error:', e.message); broadcast({ type: 'error', message: e.message }); });`,
    `bot.on('end', () => { console.log('[bot] disconnected'); broadcast({ type: 'disconnect' }); setTimeout(() => process.exit(1), 5000); });`,
    ``,
    `// ═══ 事件监听 — 实时推送 ═══`,
    `// 聊天消息`,
    `bot.on('chat', (username, message) => {`,
    `  if (username === bot.username) return;`,
    `  broadcast({ type: 'chat', username, message, timestamp: Date.now() });`,
    `});`,
    `// 玩家加入/离开`,
    `bot.on('playerJoined', (player) => {`,
    `  broadcast({ type: 'playerJoin', username: player.username });`,
    `});`,
    `bot.on('playerLeft', (player) => {`,
    `  broadcast({ type: 'playerLeave', username: player.username });`,
    `});`,
    `// 被攻击`,
    `bot.on('entityHurt', (entity) => {`,
    `  if (entity === bot.entity) return;`,
    `  broadcast({ type: 'entityHurt', name: entity.name || entity.username, health: entity.health });`,
    `});`,
    `bot.on('health', () => {`,
    `  broadcast({ type: 'health', health: bot.health, food: bot.food });`,
    `});`,
    ``,
    `// ═══ WebSocket 事件推送 (端口 ${Number(port)+1}) ═══`,
    `const { WebSocketServer } = require('ws');`,
    `const wss = new WebSocketServer({ port: ${Number(port)+1} });`,
    `const wsClients = new Set();`,
    `wss.on('connection', ws => { wsClients.add(ws); ws.on('close', () => wsClients.delete(ws)); });`,
    `function broadcast(data) { const m=JSON.stringify(data); for(const c of wsClients) try{c.send(m)}catch{} }`,
    ``,
    `function parseBody(req) {`,
    `  return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(JSON.parse(d||'{}'))); });`,
    `}`,
    `function json(res, data, code=200) {`,
    `  res.writeHead(code, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});`,
    `  res.end(JSON.stringify(data));`,
    `}`,
    ``,
    `const routes = [];`,
    ``,
    `routes.push({method:'POST',path:'/api/chat',handler:async(req,res,body)=>{`,
    `  bot.chat(body.message);`,
    `  const reply = await new Promise(r=>{`,
    `    const h=(u,m)=>{if(u!==bot.username){bot.removeListener('chat',h);r(m);}};`,
    `    bot.on('chat',h);setTimeout(()=>{bot.removeListener('chat',h);r(null);},10000);`,
    `  });`,
    `  json(res,{ok:true,message:body.message,reply:reply||'(无回复)'});`,
    `}});`,
    ``,
    `routes.push({method:'POST',path:'/api/move',handler:async(req,res,body)=>{`,
    `  const {x,y,z,follow}=body||{};`,
    `  const pf=require('mineflayer-pathfinder');`,
    `  if(follow){`,
    `    const t=Object.values(bot.players).find(p=>p.username===follow);`,
    `    if(t) bot.pathfinder.setGoal(new pf.goals.GoalFollow(t.entity,2));`,
    `  } else bot.pathfinder.setGoal(new pf.goals.GoalNear(x,y||bot.entity.position.y,z,1));`,
    `  json(res,{ok:true});`,
    `}});`,
    ``,
    `routes.push({method:'GET',path:'/api/inventory',handler:async(req,res)=>{`,
    `  const items=bot.inventory.items().map(i=>({name:i.name,count:i.count,displayName:i.displayName}));`,
    `  json(res,{ok:true,items,total:items.length});`,
    `}});`,
    ``,
    `routes.push({method:'POST',path:'/api/block',handler:async(req,res,body)=>{`,
    `  const {x,y,z}=body||{};`,
    `  const t=bot.blockAt({x:+x,y:+y,z:+z});`,
    `  if(!t) return json(res,{ok:false,error:'No block'});`,
    `  try{await bot.dig(t);json(res,{ok:true,dug:t.name});}catch(e){json(res,{ok:false,error:e.message});}`,
    `}});`,
    ``,
    `routes.push({method:'GET',path:'/api/nearby',handler:async(req,res)=>{`,
    `  const players=Object.values(bot.players).map(p=>({username:p.username,ping:p.ping}));`,
    `  const entities=Object.values(bot.entities).filter(e=>e.name&&e.name!=='player').slice(0,20).map(e=>({name:e.name,pos:e.position}));`,
    `  json(res,{ok:true,players,entities,pos:bot.entity.position});`,
    `}});`,
    ``,
    `routes.push({method:'GET',path:'/api/status',handler:async(req,res)=>{`,
    `  json(res,{ok:true,health:bot.health,food:bot.food,position:bot.entity.position,game:bot.game});`,
    `}});`,
    ``,
    `routes.push({method:'POST',path:'/api/craft',handler:async(req,res,body)=>{`,
    `  const {item,count}=body||{};`,
    `  const recipes=bot.recipesFor(+item||null);`,
    `  if(recipes.length){try{await bot.craft(recipes[0],count||1);json(res,{ok:true});}catch(e){json(res,{ok:false,error:e.message});}}`,
    `  else json(res,{ok:false,error:'No recipe'});`,
    `}});`,
    ``,
    `routes.push({method:'POST',path:'/api/attack',handler:async(req,res,body)=>{`,
    `  const {target}=body||{};`,
    `  const p=Object.values(bot.players).find(p=>p.username===target);`,
    `  const m=Object.values(bot.entities).find(e=>e.name===target||e.username===target);`,
    `  const entity=p?.entity||m;`,
    `  if(!entity) return json(res,{ok:false,error:'Target not found'});`,
    `  bot.attack(entity);`,
    `  json(res,{ok:true,attacking:target});`,
    `}});`,
    ``,
    `routes.push({method:'GET',path:'/api/health',handler:(req,res)=>json(res,{ok:true,server:'${server}'})});`,
    `routes.push({method:'OPTIONS',path:'/',handler:(req,res)=>{res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'*','Access-Control-Allow-Headers':'*'});res.end();}});`,
    ``,
    `http.createServer(async(req,res)=>{`,
    `  const url=new URL(req.url,'http://localhost');`,
    `  const r=routes.find(r=>r.method===req.method&&r.path===url.pathname);`,
    `  if(!r){res.writeHead(404);res.end('Not found');return;}`,
    `  await r.handler(req,res,req.method!=='GET'?await parseBody(req):null);`,
    `}).listen(${port},()=>console.log('[mcp-${server}] http://localhost:${port}'));`,
  ].join('\n');
}
