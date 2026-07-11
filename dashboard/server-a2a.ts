import type { Express, NextFunction, Request, Response } from 'express';
import {
  AgentCard,
  TaskState,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type StreamResponse,
  type Task,
  type TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import {
  A2ARequestHandler,
  JsonRpcTransportHandler,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  VersionNotSupportedError,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import {
  A2AStoreError,
  a2aTaskStateIsTerminal,
  getA2ATask,
  listA2AArtifacts,
  listA2AMessages,
  listA2ATasks,
  transitionA2ATask,
  type A2ATaskRecord,
  type A2ATaskScope,
} from './server-a2a-store.ts';
import {
  authenticateToken,
  findUniquePublishedA2AAgentTemplate,
  getPublishedA2AAgentTemplate,
  type AuthIdentity,
} from './server-store.ts';

const A2A_VERSION = '1.0';
const A2A_API_KEY_SCHEME = 'agentmaApiKey';

function withoutControlCharacters(value: string, replacement: string) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? replacement : character;
  }).join('');
}

function cleanPublicText(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === 'string' ? withoutControlCharacters(value, ' ').trim() : '';
  return (text || fallback).slice(0, maxLength);
}

function publicLabels(value: unknown, maxItems: number) {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const label = withoutControlCharacters(item, '').trim();
    if (!label || label.length > 80 || label.includes('/') || label.includes('\\')) continue;
    const key = label.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= maxItems) break;
  }
  return labels;
}

function skillId(label: string, index: number) {
  const slug = label.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `skill-${slug.slice(0, 44)}-${index + 1}` : `skill-${index + 1}`;
}

function requestBaseUrl(req: Request) {
  const configured = String(process.env.AGENTMA_PUBLIC_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString().replace(/\/$/, '');
    } catch {
      // Fall back to the request origin when the configured public URL is invalid.
    }
  }
  return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
}

function buildAgentCard(template: Record<string, unknown>, req: Request): AgentCard {
  const templateId = cleanPublicText(template.id, 'agent', 160);
  const name = cleanPublicText(template.name, 'AgentMa Agent', 120);
  const description = cleanPublicText(template.description, `${name} published through AgentMa A2A.`, 1000);
  const labels = publicLabels(template.skills, 12);
  const tags = publicLabels(template.tools, 8);
  const securityRequirements = [{ schemes: { [A2A_API_KEY_SCHEME]: { list: [] } } }];
  const skills = (labels.length ? labels : [name]).map((label, index) => ({
    id: skillId(label, index),
    name: label,
    description: labels.length
      ? `${name} provides the ${label} capability.`
      : description,
    tags,
    examples: [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements,
  }));
  const rpcUrl = `${requestBaseUrl(req)}/a2a/agents/${encodeURIComponent(templateId)}/rpc`;

  return {
    name,
    description,
    supportedInterfaces: [{
      url: rpcUrl,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_VERSION,
    }],
    provider: { organization: 'AgentMa', url: requestBaseUrl(req) },
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      [A2A_API_KEY_SCHEME]: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'AgentMa tenant API Key. User-session JWTs are not accepted.',
            scheme: 'Bearer',
            bearerFormat: 'AgentMa API Key',
          },
        },
      },
    },
    securityRequirements,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    signatures: [],
  };
}

function boundedHistoryLength(value: number | undefined) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1000, Math.floor(value));
}

function taskToProtocol(
  scope: A2ATaskScope,
  record: A2ATaskRecord,
  historyLength?: number,
  includeArtifacts = true,
): Task {
  const limit = boundedHistoryLength(historyLength);
  const history = listA2AMessages(scope, record.id, limit).map((item) => item.message);
  const artifacts = includeArtifacts
    ? listA2AArtifacts(scope, record.id).map((item) => item.artifact)
    : [];
  return {
    id: record.id,
    contextId: record.contextId,
    status: {
      state: record.state,
      message: record.statusMessage || record.finalMessage || undefined,
      timestamp: new Date(record.updatedAt).toISOString(),
    },
    artifacts,
    history,
    metadata: undefined,
  };
}

function mapStoreError(error: unknown) {
  if (error instanceof A2AStoreError && (error.code === 'invalid_input' || error.code === 'invalid_cursor')) {
    return new RequestMalformedError(error.message);
  }
  return error;
}

class AgentMaA2ARequestHandler implements A2ARequestHandler {
  constructor(
    private readonly card: AgentCard,
    private readonly auth: AuthIdentity,
    private readonly templateId: string,
  ) {}

  private scope(): A2ATaskScope {
    return {
      tenantId: this.auth.tenantId,
      templateId: this.templateId,
      callerSub: this.auth.sub,
    };
  }

  async getAgentCard() {
    return this.card;
  }

  async getAuthenticatedExtendedAgentCard() {
    throw new UnsupportedOperationError('Extended Agent Cards are not supported.');
  }

  async sendMessage(): Promise<Message | Task> {
    throw new UnsupportedOperationError('Agent execution will be enabled by the next A2A runtime slice.');
  }

  sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> {
    return unsupportedStream('Streaming agent execution is not enabled yet.');
  }

  async getTask(params: GetTaskRequest) {
    const scope = this.scope();
    let record: A2ATaskRecord | null;
    try {
      record = getA2ATask(scope, params.id);
    } catch (error) {
      throw mapStoreError(error);
    }
    if (!record) throw new TaskNotFoundError();
    return taskToProtocol(scope, record, params.historyLength);
  }

  async listTasks(params: ListTasksRequest): Promise<ListTasksResponse> {
    const updatedAfter = params.statusTimestampAfter
      ? Date.parse(params.statusTimestampAfter)
      : undefined;
    if (updatedAfter !== undefined && !Number.isFinite(updatedAfter)) {
      throw new RequestMalformedError('statusTimestampAfter must be a valid ISO 8601 timestamp.');
    }
    const scope = this.scope();
    let result: ReturnType<typeof listA2ATasks>;
    try {
      result = listA2ATasks(scope, {
        contextId: params.contextId || undefined,
        state: params.status === TaskState.TASK_STATE_UNSPECIFIED ? undefined : params.status,
        updatedAfter,
        pageSize: params.pageSize,
        cursor: params.pageToken || undefined,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    return {
      tasks: result.tasks.map((task) => taskToProtocol(
        scope,
        task,
        params.historyLength,
        params.includeArtifacts === true,
      )),
      nextPageToken: result.nextCursor || '',
      pageSize: Math.max(1, Math.min(100, Math.floor(params.pageSize || 50))),
      totalSize: result.totalSize,
    };
  }

  async cancelTask(params: CancelTaskRequest) {
    const scope = this.scope();
    let current: A2ATaskRecord | null;
    try {
      current = getA2ATask(scope, params.id);
    } catch (error) {
      throw mapStoreError(error);
    }
    if (!current) throw new TaskNotFoundError();
    if (a2aTaskStateIsTerminal(current.state)) throw new TaskNotCancelableError();
    try {
      const { task } = transitionA2ATask(scope, current.id, {
        state: TaskState.TASK_STATE_CANCELED,
      });
      return taskToProtocol(scope, task);
    } catch (error) {
      if (error instanceof A2AStoreError) {
        if (error.code === 'not_found') throw new TaskNotFoundError();
        if (error.code === 'terminal' || error.code === 'invalid_transition') throw new TaskNotCancelableError();
      }
      throw mapStoreError(error);
    }
  }

  async createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new UnsupportedOperationError('Push notifications are not supported.');
  }

  async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new UnsupportedOperationError('Push notifications are not supported.');
  }

  async listTaskPushNotificationConfigs(): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new UnsupportedOperationError('Push notifications are not supported.');
  }

  async deleteTaskPushNotificationConfig(): Promise<void> {
    throw new UnsupportedOperationError('Push notifications are not supported.');
  }

  resubscribe(): AsyncGenerator<StreamResponse, void, undefined> {
    return unsupportedStream('Task resubscription is not supported yet.');
  }
}

async function* unsupportedStream(message: string): AsyncGenerator<StreamResponse, void, undefined> {
  yield* [] as StreamResponse[];
  throw new UnsupportedOperationError(message);
}

function bearerToken(req: Request) {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function jsonRpcErrorBody(error: unknown) {
  return {
    jsonrpc: '2.0',
    id: null,
    error: JsonRpcTransportHandler.mapToJSONRPCError(error),
  };
}

function requireA2AVersion(req: Request, res: Response, next: NextFunction) {
  if (req.header('A2A-Version') === A2A_VERSION) {
    next();
    return;
  }
  res.status(400).json(jsonRpcErrorBody(
    new VersionNotSupportedError(`A2A-Version header must be ${A2A_VERSION}.`),
  ));
}

function rejectUnauthorized(res: Response) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="AgentMa A2A", error="invalid_token"');
  res.status(401).json({ error: 'A valid AgentMa API Key is required.' });
}

export function mountA2ARoutes(app: Express) {
  app.use('/a2a/agents/:templateId/.well-known/agent-card.json', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    const template = findUniquePublishedA2AAgentTemplate(req.params.templateId);
    if (!template) {
      res.status(404).json({ error: 'A2A agent not found' });
      return;
    }
    const card = buildAgentCard(template, req);
    const wireCard = AgentCard.toJSON(card) as AgentCard;
    agentCardHandler({ agentCardProvider: async () => wireCard, cache: { maxAge: 300 } })(req, res, next);
  });

  app.use('/a2a/agents/:templateId/rpc', requireA2AVersion, (req, res, next) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    const token = bearerToken(req);
    const auth = authenticateToken(token);
    if (!auth) {
      rejectUnauthorized(res);
      return;
    }
    if (auth.authType !== 'api_key') {
      res.status(403).json({ error: 'User-session JWTs are not accepted by A2A RPC.' });
      return;
    }
    const template = getPublishedA2AAgentTemplate(auth.tenantId, req.params.templateId);
    if (!template) {
      res.status(404).json({ error: 'A2A agent not found' });
      return;
    }
    const card = buildAgentCard(template, req);
    const requestHandler = new AgentMaA2ARequestHandler(card, auth, String(template.id));
    jsonRpcHandler({
      requestHandler,
      userBuilder: async () => ({ isAuthenticated: true, userName: auth.sub }),
    })(req, res, next);
  });
}
