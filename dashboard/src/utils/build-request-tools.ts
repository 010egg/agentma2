import type { AgentTemplate, RegisteredTool } from '../simulator/types';
import { initCustomTools } from '../simulator/mock-data';

export type RequestToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const BUILT_IN_REQUEST_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  Read: { file_path: 'string', offset: 'number?', limit: 'number?' },
  Write: { file_path: 'string', content: 'string' },
  Edit: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean?' },
  Bash: { command: 'string', timeout: 'number?', description: 'string?' },
  Grep: { pattern: 'string', path: 'string?' },
  Glob: { pattern: 'string' },
  WebSearch: { query: 'string' },
  WebFetch: { url: 'string', prompt: 'string' },
  ToolSearch: { query: 'string' },
  TaskCreate: { subject: 'string', description: 'string' },
  TaskUpdate: { taskId: 'string', status: 'string' },
  TaskGet: { taskId: 'string' },
  TaskList: {},
  TaskStop: { taskId: 'string' },
  TaskOutput: { taskId: 'string', block: 'boolean?', timeout: 'number?' },
  Agent: { description: 'string', prompt: 'string', subagent_type: 'string?', run_in_background: 'boolean?' },
  AskUserQuestion: { questions: 'array' },
  'model.request': {
    model: 'string?',
    prompt: 'string',
    system: 'string?',
    imageUrl: 'string?',
    imageBase64: 'string?',
    imageMediaType: 'string?',
    maxTokens: 'number?',
    temperature: 'number?',
  },
  'image.inspect': {
    imagePath: 'string?',
    imagePaths: 'string[]?',
    path: 'string?',
    paths: 'string[]?',
    prompt: 'string?',
    model: 'string?',
    maxTokens: 'number?',
    temperature: 'number?',
  },
  'image.generate': {
    prompt: 'string',
    outputPath: 'string?',
    referenceImagePath: 'string?',
    referenceImagePaths: 'string[]?',
    size: 'string?',
    quality: 'string?',
    background: 'string?',
  },
};

export function buildRequestTools(
  toolNames: string[] | undefined,
  customTools: RegisteredTool[] = initCustomTools(),
): RequestToolDefinition[] | undefined {
  if (!toolNames?.length) return undefined;

  return toolNames.map((name) => {
    const custom = customTools.find((tool) => tool.name === name);
    if (custom) return { name, description: custom.description, input_schema: custom.inputSchema };
    return { name, description: name, input_schema: BUILT_IN_REQUEST_TOOL_SCHEMAS[name] || {} };
  });
}

export function buildRequestToolsForAgent(agent: Pick<AgentTemplate, 'tools'> | null | undefined) {
  return buildRequestTools(agent?.tools);
}
