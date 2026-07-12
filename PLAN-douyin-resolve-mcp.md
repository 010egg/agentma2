# PLAN: 平台级抖音解析 + 转写 MCP 工具(受控浏览器服务 + 转写队列)

> 目标:让沙箱内的租户 agent 完成"抖音链接 → 视频元数据 + 评论列表 → 语音转写文本"全链路,
> 而**不给 agent 任何通用浏览器能力,也不要求 agent 沙箱内有任何重型依赖**(ffmpeg 除外)。
> 浏览器与转写(mlx-whisper)都只在宿主侧作为受控资源存在,agent 只能通过三个窄 MCP 工具调用:
> `mcp__media__douyin_resolve`、`mcp__media__douyin_comments`、`mcp__media__transcribe`。
> 窄接口的定义:每个工具 = 服务端写死的逻辑 + 白名单输出字段;扩展能力 = 加同模式的
> 新工具/新字段,**永不**放宽为通用导航/任意 JS/任意命令。
> 明确决策:转写**不走**"共享 HF_HOME + agent 沙箱内跑 mlx-whisper"的折中方案 ——
> 该方案 GPU 无治理、依赖宿主全局 pip、Seatbelt 下 HF 锁文件行为未知,多租户生产不可接受。

## 背景(执行前先读)

- 抖音 web 接口 `/aweme/v1/web/aweme/detail/` 必须带页面 JS 动态生成的反爬签名
  (`X-Bogus`/`a_bogus`/`msToken`)+ cookie,裸 HTTP 客户端(curl/httpx/yt-dlp)拿到的是空响应。
  唯一可靠路径是:真实浏览器加载页面 → 在**页面 JS 上下文内**执行同源 `fetch`。
- 沙箱 run 内自装 Playwright 不可行且不应该做:
  1. 运行时 `pip install playwright` 被出网代理 403;
  2. HOME 隔离在 `<cwd>/.agent-home`(`server-agent.ts:1178`),浏览器二进制每个新会话都会丢,重复下载数百 MB;
  3. Chromium 在 Seatbelt 沙箱内能否启动未验证;
  4. 安全上,给租户 agent 通用浏览器 = SSRF 大杀器,绕过将来的 `allowManagedDomainsOnly` 网络收紧。
- 项目已有内部 MCP 工具的成熟接入模式,本方案完全沿用:
  - 工具目录注册:`dashboard/server-internal-tools.ts:115` `listInternalTools()` / `INTERNAL_TOOL_CATALOG`(`:~40-113`);
  - MCP 工厂:同文件 `buildImageMcp`(`:945`)、`buildDatasourceMcp`(`:967`)、`buildModelRequestMcp`(`:843`);
  - 挂载点:`dashboard/server-agent.ts:1562-1570` 的 `mcpServers` 组装,及 `:1232`
    `internalToolRuntimeNames`(模板启用 → 运行时工具名映射)。

## 目标 / 非目标

**目标**
- 新增 in-process SDK MCP server `media`,含三个工具:
  - `douyin_resolve`:输入抖音 URL(短链或视频页),输出视频完整元数据
    (播放地址、标题、作者、互动统计、时长/封面、发布时间、话题标签、背景音乐,见改动 1 的字段表);
  - `douyin_comments`:输入抖音 URL + 可选 cursor,输出评论列表(分页,上限截断);
  - `transcribe`:输入媒体 URL(如 resolve 返回的 playUrl)或 cwd 内音频文件路径,
    宿主侧队列执行 ffmpeg + mlx-whisper,转写文本写入 run cwd 并返回(改动 1.5)。
- 浏览器(系统 Chrome,经 `playwright-core` 驱动)只在 dashboard Node 主进程侧运行,
  单实例、懒启动、空闲自动关闭;每次调用用独立 incognito context,租户间无 cookie 交叉。
- 域名白名单 + 并发/频率限制 + 超时,把 SSRF 面收敛到抖音域。

**非目标(本期不做)**
- 不做通用 `browser_fetch` / 任意 URL 渲染工具——窄接口是本方案的核心安全属性,不要泛化。
- 不做登录态/扫码(需要登录的视频直接返回明确错误;见"已知陷阱 4")。
- 不做 B 站/快手等其他平台(架构预留 serverName=`media`,将来加 `bilibili_resolve` 即可)。
- 不做"共享 HF_HOME + agent 沙箱内自跑 mlx-whisper"折中(决策见文首;转写只走 transcribe 工具)。
- 转写不做说话人分离/字幕时间轴输出(mlx-whisper 支持 srt,本期只出纯文本,后续按需加格式参数)。

## 架构

```
┌─ 租户 agent run(Seatbelt 沙箱,cwd=/tmp/agentma-run-*)
│    ├─ mcp__media__douyin_resolve(url)              ← agent 能触达的入口只有这三个
│    ├─ mcp__media__douyin_comments(url, cursor?)
│    └─ mcp__media__transcribe(url | audioPath)      ← 转写结果落回本 run 的 cwd
│         │ (in-process SDK MCP,tool handler 在 Node 主进程执行,与 imageMcp 同机制)
├─ dashboard Node 主进程
│    └─ BrowserService(单例)
│         ├─ playwright-core → 系统 Chrome(channel:'chrome',无需下载二进制)
│         ├─ 懒启动;空闲 N 分钟自动 close;崩溃自动重启(下次调用时)
│         ├─ 每次调用:browser.newContext()(incognito,独立 cookie)→ 用完即销毁
│         ├─ 并发信号量(默认 2)+ 每租户频率限制
│         └─ resolveDouyin(url):
│              1. 校验输入 URL host ∈ 白名单
│              2. page.goto(url, waitUntil:'networkidle', timeout)
│              3. 校验落地 URL host ∈ 白名单(防重定向逃逸)
│              4. page.evaluate(同源 fetch aweme detail)→ 解析
│              5. 失败 fallback:读 DOM <video>.currentSrc
│    └─ TranscribeQueue(单例任务队列,改动 1.5)
│         ├─ 全局并发 1(GPU 串行)+ 每租户排队上限 + 任务超时
│         └─ 每任务 spawn 独立 worker 子进程(固定 venv 的 python):
│              ffmpeg(URL 域白名单 / cwd 内文件)→ wav → mlx-whisper(共享只读模型缓存,
│              HF_HUB_OFFLINE=1)→ 文本写回 run cwd → 返回
└─ 返回白名单字段 JSON 或结构化错误
```

关键安全边界:
- agent 拿不到 page/browser 句柄,只有一问一答的窄接口;
- URL 白名单在**服务侧**校验(不信任 agent 输入):
  `v.douyin.com` / `www.douyin.com` / `douyin.com` / `www.iesdouyin.com`;
- `page.evaluate` 的 JS 是**服务端写死的常量**,不接受 agent 传入任何脚本片段;
- 返回值只有四个白名单字段,不透传页面任意内容。

---

## 改动 1:新增 `dashboard/server-browser-service.ts`(BrowserService 单例)

```ts
import { chromium, type Browser } from 'playwright-core';

const BROWSER_IDLE_SHUTDOWN_MS = clamp(process.env.AGENTMA_BROWSER_IDLE_MS, 5 * 60_000);
const RESOLVE_TIMEOUT_MS = clamp(process.env.AGENTMA_DOUYIN_RESOLVE_TIMEOUT_MS, 30_000);
const RESOLVE_CONCURRENCY = clamp(process.env.AGENTMA_BROWSER_CONCURRENCY, 2);
const DOUYIN_ALLOWED_HOSTS = new Set([
  'v.douyin.com', 'www.douyin.com', 'douyin.com', 'www.iesdouyin.com',
]);

// 服务端写死的提取脚本 —— 绝不拼接任何 agent 输入。
// 输出 = 下方白名单字段的显式映射,绝不透传整个 aweme_detail(那等于开放任意页面数据)。
const EXTRACT_JS = `async () => {
  const awemeId = location.pathname.match(/video\\/(\\d+)/)?.[1];
  if (!awemeId) return { error: 'not_video_page' };
  try {
    const resp = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + awemeId);
    const text = await resp.text();
    if (text) {
      const d = JSON.parse(text).aweme_detail;
      const video = d?.video;
      const addr = video?.play_addr_h264 || video?.play_addr;
      const playUrl = addr?.url_list?.slice(-1)[0];
      if (playUrl) return {
        awemeId,
        playUrl,
        title: d?.desc || '',
        createTime: d?.create_time || null,                       // 发布时间(unix 秒)
        hashtags: (d?.text_extra || [])
          .map((t) => t?.hashtag_name).filter(Boolean),           // 话题标签
        author: {
          nickname: d?.author?.nickname || '',
          uniqueId: d?.author?.unique_id || '',                   // 抖音号
          secUid: d?.author?.sec_uid || '',
          followerCount: d?.author?.follower_count ?? null,
          avatarUrl: d?.author?.avatar_thumb?.url_list?.[0] || '',
        },
        stats: {
          playCount: d?.statistics?.play_count ?? null,
          diggCount: d?.statistics?.digg_count ?? null,           // 点赞
          commentCount: d?.statistics?.comment_count ?? null,
          collectCount: d?.statistics?.collect_count ?? null,     // 收藏
          shareCount: d?.statistics?.share_count ?? null,
        },
        videoMeta: {
          durationMs: video?.duration ?? null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          ratio: video?.ratio || '',
          coverUrl: video?.cover?.url_list?.[0] || '',
        },
        music: {
          title: d?.music?.title || '',
          author: d?.music?.author || '',
        },
      };
    }
  } catch {}
  // fallback: 登录墙下 API 空响应,但页面 <video> 仍会加载(只有基础字段)
  const v = document.querySelector('video');
  const playUrl = v?.currentSrc || v?.src || '';
  if (!playUrl) return { error: 'login_required_or_no_video' };
  return {
    awemeId,
    playUrl,
    title: (document.title || '').replace(' - 抖音', ''),
    author: { nickname: document.querySelector('[data-e2e="user-info-nickname"]')?.textContent || '' },
    partial: true,   // 标记降级结果,统计/元数据字段缺失
  };
}`;

// 评论提取脚本 —— 同一页面上下文内调评论接口(同样依赖页面签名)。cursor 由服务端校验为
// 非负整数后才嵌入;count 服务端写死,不接受 agent 指定。
const COMMENTS_PAGE_SIZE = 20;          // 单次调用返回条数(抖音接口单页上限)
const COMMENT_TEXT_MAX = 500;           // 单条评论文本截断
const COMMENTS_JS = (cursor: number) => `async () => {
  const awemeId = location.pathname.match(/video\\/(\\d+)/)?.[1];
  if (!awemeId) return { error: 'not_video_page' };
  const resp = await fetch('/aweme/v1/web/comment/list/?aweme_id=' + awemeId +
    '&cursor=${cursor}&count=${COMMENTS_PAGE_SIZE}');
  const text = await resp.text();
  if (!text) return { error: 'login_required_or_empty' };
  const json = JSON.parse(text);
  return {
    awemeId,
    cursor: json.cursor ?? null,          // 传回下一页 cursor
    hasMore: Boolean(json.has_more),
    total: json.total ?? null,
    comments: (json.comments || []).map((c) => ({
      text: String(c?.text || '').slice(0, ${COMMENT_TEXT_MAX}),
      nickname: c?.user?.nickname || '',
      diggCount: c?.digg_count ?? null,
      replyCount: c?.reply_comment_total ?? null,
      createTime: c?.create_time || null,
      ipLabel: c?.ip_label || '',
    })),
  };
}`;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// + 简单信号量(RESOLVE_CONCURRENCY)

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ channel: 'chrome', headless: true })
      .catch((e) => { browserPromise = null; throw e; });  // 启动失败可重试
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) { browserPromise = null; return getBrowser(); }  // 崩溃自愈
  return browser;
}

export type DouyinResolveResult =
  | { ok: true; awemeId: string; playUrl: string; title: string; createTime: number | null;
      hashtags: string[]; author: {...}; stats: {...}; videoMeta: {...}; music: {...}; partial?: true }
  | { ok: false; error: string };

export type DouyinCommentsResult =
  | { ok: true; awemeId: string; cursor: number | null; hasMore: boolean; total: number | null;
      comments: { text: string; nickname: string; diggCount: number | null;
                  replyCount: number | null; createTime: number | null; ipLabel: string }[] }
  | { ok: false; error: string };

export async function resolveDouyinVideo(rawUrl: string): Promise<DouyinResolveResult> {
  // 1. 输入校验(https only + host 白名单)
  // 2. 取信号量;超时 RESOLVE_TIMEOUT_MS 包裹整个流程
  // 3. const context = await browser.newContext({ locale: 'zh-CN', userAgent: <桌面 Chrome UA> })
  //    try { page.goto → 校验落地 host → page.evaluate(EXTRACT_JS) } finally { context.close() }
  // 4. 重置 idleTimer:BROWSER_IDLE_SHUTDOWN_MS 无调用则 browser.close()
}

export async function fetchDouyinComments(rawUrl: string, cursor = 0): Promise<DouyinCommentsResult> {
  // 与 resolveDouyinVideo 同一套校验/信号量/超时/context 生命周期;
  // cursor 服务端校验:Number.isInteger && >= 0 && <= 10_000,否则拒绝(它会被嵌入脚本,必须先校验);
  // page.evaluate(COMMENTS_JS(cursor))。翻页由 agent 多次调用完成,每次都是独立的完整流程
  // (无状态,不在服务端持有 page;简单优先,翻页深度被 cursor 上限和租户限流双重约束)。
}
```

要点:
- **用 `playwright-core` + `channel:'chrome'`**:`playwright-core` 不自带浏览器下载逻辑,
  直接驱动宿主已装的 Chrome —— 部署零下载,也绕开出网代理 403 问题。
  依赖只加到 `dashboard/package.json`,不进任何租户环境。
- 浏览器进程属于 dashboard 主进程的子进程,**与租户 run 的 Seatbelt 沙箱无关**
  (与"已知陷阱 4:自定义 HTTP 工具网络不受 bash sandbox 约束"同一范畴,属平台可信侧)。
- `context.close()` 必须放 `finally`,防泄漏;goto/evaluate 全程受总超时约束。

## 改动 1.5:新增 `dashboard/server-transcribe-service.ts`(转写队列)

**决策:转写是平台受控能力,不在 agent 沙箱内跑。** 理由(也是否决折中方案的理由):
- 模型缓存在 `$HOME/.cache/huggingface`(~1.5GB),run 的 HOME 隔离在 `<cwd>/.agent-home`
  → 沙箱内自跑 = 每个新会话重下模型(还要过代理,大概率直接失败);
- mlx-whisper 吃 Apple Silicon GPU,一次 1-3 分钟,多租户并发无队列/配额 = 平台资源失控;
- 依赖宿主全局 pip 是脆弱的隐式契约;Seatbelt 下 HF 库写 `.locks` 行为未验证。

### 1.5a. 部署前提(宿主一次性,写进部署文档/脚本)
```bash
# 固定 venv,不依赖全局 pip;worker 只用这个解释器
python3 -m venv /opt/agentma/transcribe-venv
/opt/agentma/transcribe-venv/bin/pip install mlx-whisper
# 模型预下载到共享缓存(之后 worker 全程 HF_HUB_OFFLINE=1,零运行时下载)
HF_HOME=/opt/agentma/hf-cache /opt/agentma/transcribe-venv/bin/python -c \
  "import mlx_whisper; mlx_whisper.transcribe('/dev/null', path_or_hf_repo='mlx-community/whisper-large-v3-turbo')" || true
brew install ffmpeg   # ffmpeg 同时服务 agent 沙箱内使用与 worker
```
mlx-whisper 仅 Apple Silicon;将来 Linux 部署换 faster-whisper/whisper.cpp,worker 接口不变。

### 1.5b. TranscribeQueue
```ts
const TRANSCRIBE_CONCURRENCY = 1;                    // GPU 串行,不做成可调超过 2
const TRANSCRIBE_TIMEOUT_MS = clamp(env, 10 * 60_000);
const TRANSCRIBE_MAX_QUEUE_PER_TENANT = 2;           // 排队上限,超出直接 isError
const TRANSCRIBE_MAX_MEDIA_SECONDS = 60 * 60;        // ffprobe 先探时长,超 1h 拒绝
const TRANSCRIBE_URL_HOST_SUFFIXES = ['.amemv.com', '.douyinvod.com', '.bytecdn.com' /* 按实测补充 */];

export async function transcribeMedia(req: {
  tenantId: string;
  cwd: string;                        // 本次 run 的 cwd,输出写这里
  source: { url: string } | { audioPath: string };
  language?: string;                  // 可选,默认自动检测
}): Promise<{ ok: true; text: string; outputPath: string; durationSec: number } | { ok: false; error: string }>
```
实现要点:
1. **输入校验(信任边界在这里)**:
   - `url` 型:https + host 后缀 ∈ 白名单(视频 CDN 域,**不是**任意 URL —— transcribe 不能
     变成 SSRF 出口;抖音 CDN 域名会变,白名单可经 `AGENTMA_TRANSCRIBE_URL_HOSTS` 追加);
   - `audioPath` 型:`realpath` 后必须位于该 run 的 cwd 内(防 `../` 与符号链接逃逸),
     存在且 ≤ 500MB;
   - 两型都先 `ffprobe` 探时长,超上限拒绝(防超长媒体占死 GPU)。
2. **队列**:全局并发 1;每租户等待中任务数 > 上限即拒(isError 返回"稍后再试",不无限排队);
   任务级超时到点 SIGKILL worker 进程树。
3. **worker 子进程**:`spawn('/opt/agentma/transcribe-venv/bin/python', [WORKER_SCRIPT, ...])`,
   env 只给 `{ HF_HOME: '/opt/agentma/hf-cache', HF_HUB_OFFLINE: '1', PATH: 最小 }`;
   worker 脚本(随仓库交付的固定 .py):ffmpeg → 16kHz mono wav(临时目录)→ mlx_whisper
   (`condition_on_previous_text=False`,压制重复幻觉,来自实测教训)→ 输出纯文本。
4. **输出**:文本写 `cwd/transcripts/<awemeId|hash>.txt`(agent 可直接 Read),
   返回体内嵌文本但**截断上限 24_000 字符**(与 MODEL_REQUEST_MAX_OUTPUT_CHARS 对齐),
   超长时返回体说明"全文见 outputPath"。
5. 临时 wav 用后即删;worker stdout/stderr 截断收集,失败时进错误信息(过滤路径等敏感段)。

## 改动 2:`server-internal-tools.ts` 注册目录项 + MCP 工厂

### 2a. `INTERNAL_TOOL_CATALOG` 追加(`:113` 数组尾部)

```ts
{
  id: 'media.douyin_resolve',
  serverName: 'media',
  toolName: 'douyin_resolve',
  displayName: '解析抖音视频',
  description: '输入抖音分享链接或视频页 URL,通过平台受控浏览器解析出视频元数据:真实播放地址、标题、作者(昵称/抖音号/粉丝数)、互动统计(播放/点赞/评论/收藏/分享)、时长/分辨率/封面、发布时间、话题标签、背景音乐。播放地址有时效,拿到后应立即使用。',
  category: '媒体',
  inputSchema: { url: 'string' },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
},
{
  id: 'media.douyin_comments',
  serverName: 'media',
  toolName: 'douyin_comments',
  displayName: '抖音视频评论',
  description: '输入抖音分享链接或视频页 URL,返回一页评论(每页 20 条:文本、昵称、点赞数、回复数、发布时间、IP 属地)。响应含 cursor 与 hasMore,继续传 cursor 翻页。',
  category: '媒体',
  inputSchema: { url: 'string', cursor: 'number?' },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
},
{
  id: 'media.transcribe',
  serverName: 'media',
  toolName: 'transcribe',
  displayName: '语音转写',
  description: '把媒体转写为文字。传 url(推荐:douyin_resolve 返回的 playUrl,拿到后直接传入,无需自己下载)或 audioPath(工作目录内的音频文件)。任务串行排队,可能等待数分钟;完成后全文写入工作目录 transcripts/ 下并返回文本。',
  category: '媒体',
  inputSchema: { url: 'string?', audioPath: 'string?', language: 'string?' },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
},
```
三个工具在模板 UI 里独立勾选(有的场景只要元数据/评论,不要转写)。

### 2b. 新增 `buildMediaMcp()`(参考 `buildImageMcp` `:945` 的结构)

```ts
export function buildMediaMcp(tenantId: string, enabled: { resolve: boolean; comments: boolean }) {
  const tools = [];
  // 两个工具共用同一套每租户频率限制(如合计 10 次/分钟,内存 Map<tenantId, timestamps>)
  if (enabled.resolve) {
    tools.push(tool('douyin_resolve', /* description 同目录项 */, { url: z.string() }, async (args) => {
      const result = await resolveDouyinVideo(String(args.url || ''));
      if (!result.ok) return { content: [{ type: 'text', text: `解析失败: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }));
  }
  if (enabled.comments) {
    tools.push(tool('douyin_comments', /* description 同目录项 */,
      { url: z.string(), cursor: z.number().int().min(0).max(10_000).optional() }, async (args) => {
      const result = await fetchDouyinComments(String(args.url || ''), args.cursor ?? 0);
      if (!result.ok) return { content: [{ type: 'text', text: `获取评论失败: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }));
  }
  if (enabled.transcribe) {
    tools.push(tool('transcribe', /* description 同目录项 */,
      { url: z.string().optional(), audioPath: z.string().optional(), language: z.string().max(8).optional() },
      async (args) => {
        const source = args.url ? { url: String(args.url) }
          : args.audioPath ? { audioPath: String(args.audioPath) } : null;
        if (!source) return { content: [{ type: 'text', text: 'err: 需提供 url 或 audioPath 之一' }], isError: true };
        const result = await transcribeMedia({ tenantId, cwd, source, language: args.language });
        if (!result.ok) return { content: [{ type: 'text', text: `转写失败: ${result.error}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }));
  }
  return tools.length ? createSdkMcpServer({ name: 'media', version: '1.0.0', tools }) : null;
}
```
注意 `buildMediaMcp` 签名需增加 `cwd`(transcribe 输出定位),与 `buildImageMcp(tenantId, cwd, …)` 一致。

## 改动 3:`server-agent.ts` 挂载(与 imageMcp 同模式)

- `:22` import 处追加 `buildMediaMcp`;
- `:1250` 附近,按模板启用情况构建:
  ```ts
  const mediaMcp = buildMediaMcp(opts.tenantId, cwd, {
    resolve: /* 模板 internalTools 含 'media.douyin_resolve',复用 image.inspect 的判定方式 */,
    comments: /* 同上,'media.douyin_comments' */,
    transcribe: /* 同上,'media.transcribe' */,
  });  // 全部未启用时返回 null
  ```
- `:1562-1570` `mcpServers` 对象追加 `...(mediaMcp ? { media: mediaMcp } : {})`,
  外层条件同步加入 `|| mediaMcp`。
- `internalToolRuntimeNames`(`:1232`)基于 `listInternalTools()` 自动生成,目录项注册后
  模板勾选/工具名映射(`mcp__media__douyin_resolve`)无需额外改动 —— 验证时确认即可。

## 改动 4:douyin-transcriber skill 适配服务端环境

skill 的 SKILL.md 增加"Approach 0: 平台 MCP(服务端环境优先)":

```
若环境中存在 mcp__media__* 工具(AgentMa 服务端),流程是纯编排,agent 不跑任何重型命令:
1. 调 mcp__media__douyin_resolve(url) 拿 playUrl/title/author 及完整元数据
2. 立即调 mcp__media__transcribe({ url: playUrl }) —— 直接传 playUrl,不要自己 ffmpeg 下载;
   该工具串行排队,可能等数分钟,属正常;返回文本 + cwd 内 transcripts/ 路径
3. 读转写文本,总结中文标题(≤20 字),按 YYYY-MM-DD_标题.txt 落盘 —— 与现有流程一致;
   元数据(发布时间/互动统计)可按需写进输出文件头
4. 若用户要求评论分析且 mcp__media__douyin_comments 可用:循环传 cursor 翻页,
   注意 hasMore=false 或达到需求量即停,不要无脑翻到底(限流会拦)
本地环境(有 Claude_Browser / Playwright / 本机 mlx-whisper)仍走原 Approach 1/2。
```

## 改动 5:配置开关文档化

- `AGENTMA_BROWSER_CONCURRENCY`(默认 2)
- `AGENTMA_BROWSER_IDLE_MS`(默认 300000,空闲关浏览器)
- `AGENTMA_DOUYIN_RESOLVE_TIMEOUT_MS`(默认 30000)
- `AGENTMA_TRANSCRIBE_TIMEOUT_MS`(默认 600000)
- `AGENTMA_TRANSCRIBE_URL_HOSTS`(逗号分隔,追加转写允许的媒体 CDN host 后缀)
- `AGENTMA_TRANSCRIBE_VENV`(默认 `/opt/agentma/transcribe-venv`)、
  `AGENTMA_HF_CACHE`(默认 `/opt/agentma/hf-cache`)
- 依赖:`dashboard/package.json` 增加 `playwright-core`;部署机需有 Chrome + ffmpeg +
  转写 venv 与预下载模型(见改动 1.5a 部署脚本;macOS/Apple Silicon;
  将来 Linux 容器化时 Chrome/ffmpeg/whisper 全部进镜像,whisper 实现换 faster-whisper)。

---

## 已知陷阱(执行时注意)

1. **playUrl 有时效**:抖音播放地址带签名参数,数分钟内过期。主推路径(resolve →
   transcribe({url: playUrl}))下时序问题基本消失 —— 两次工具调用之间不再夹着 agent 的
   下载动作,宿主 worker 拿到 url 即刻开始拉流。仍要注意两点:工具 description 保留
   "拿到后应立即使用"(agent 不要在两次调用间插入长操作,如先翻十页评论);
   transcribe 若因排队延后启动导致 url 过期,错误信息应提示 agent 重新 resolve 一次。
2. **`headless:true` 可能触发抖音风控**:新版 Chrome headless(`--headless=new`)指纹接近真实浏览器,
   一般可过;若验证时发现 API 持续空响应而有头模式正常,降级方案是 `headless:false` + 宿主虚拟显示,
   或加 UA/`navigator.webdriver` 抹除。先按 headless 验证,不行再说,**不要**预先堆反反爬代码。
3. **主推路径下 agent 不再需要沙箱内 ffmpeg 拉流**(transcribe 直接吃 playUrl,下载发生在
   宿主 worker 内);agent 沙箱内的 ffmpeg 保留为可选能力(用户自带音频文件预处理等场景),
   当前 `SANDBOX_NETWORK_MANAGED_ONLY` 默认 OFF(`server-agent.ts:536`)时可用。
   将来开启网络收紧,主链路(resolve → transcribe)**不受影响** —— 这是转写收进平台工具的
   额外收益:租户 run 可以完全断网跑完转写全流程。
4. **登录墙视频**:无登录态的 incognito context 下,部分视频 API 返回空且 `<video>` 也不加载。
   fallback 已处理成明确错误 `login_required_or_no_video`,agent 应把该错误如实告知用户,
   **不要**在平台侧存任何用户登录态(那是完全不同的安全等级,超出本方案)。
5. **转写在宿主侧,但绝不在 Node 主进程内跑**:必须是 spawn 的 worker 子进程 + 队列 + 超时
   SIGKILL(改动 1.5b);Node 侧只做排队和 IO。违反这条 = 一次转写卡死整个平台事件循环。
   同理,worker 的 env 是显式最小集(HF_HOME/HF_HUB_OFFLINE/PATH),不继承主进程 env。
5b. **transcribe 的 URL 白名单与 audioPath 校验是 SSRF/逃逸防线**:url 只收媒体 CDN 域
   (它是宿主进程发起的下载!);audioPath 必须 realpath 后落在本 run cwd 内 ——
   否则租户 A 可以传 `/tmp/agentma-run-<B>/...` 读走租户 B 的音频。逐条测(验证 2c)。
5c. **排队等待与 MCP 调用超时的关系**:transcribe 串行,最坏等待 = 队列深度 × 单任务时长。
   排队上限(每租户 2)+ 时长上限(1h 媒体)把最坏情况控制在可预期范围;SDK 工具调用
   本身无硬超时,但要在返回体/description 里管理 agent 预期("可能等待数分钟"),
   防止 agent 以为挂了而重复调用(重复调用会被排队上限拒掉,这正是它的第二作用)。
   分钟级长任务型 MCP 工具在项目内**有先例**:`image.generate` 超时配到 10 分钟
   (`server-internal-tools.ts:125` IMAGE_GENERATE_TIMEOUT_MS,clamp 30s..30min)且已在
   run 开始时 emit 提示("可能需要几十秒到数分钟",`server-agent.ts:1588-1590`)——
   transcribe 的超时形态、clamp 边界、开始时的 run_log 提示都照它抄,不要发明新模式。
6. **频率限制是必须项不是可选项**:窄接口仍可能被 agent 循环滥用(拿平台 IP 刷抖音),
   每租户限流 + 全局并发信号量两层都要;超限返回 isError 文本,不排队。
   评论翻页天然放大调用量(一个视频几千条评论 = 上百次调用),限流对两个工具**合计**计数;
   cursor 上限(10000)同时是翻页深度的硬顶。
7. **输出白名单是逐字段显式映射,不是"整对象透传"**:aweme_detail / comment 响应里还有
   大量未映射字段(设备信息、风控字段、用户主页数据等),扩展字段时逐个评估加进映射,
   **绝不** `return json.aweme_detail` 图省事 —— 那等于把窄接口变成任意数据出口。
8. **cursor 是唯一嵌入脚本的 agent 输入**:必须先过 `Number.isInteger && 0..10000` 校验
   再字符串拼接(COMMENTS_JS 的实现约束);其它任何 agent 输入都不允许进 evaluate 脚本。
9. **评论内容是不可信文本 + 含个人信息**:昵称/IP 属地属于公开页面即可见的信息,按原样返回;
   但评论文本可能含提示注入,工具返回是 JSON 字符串,agent 侧把它当数据不当指令
   (与远程 MCP 工具描述注入同级风险,文档注明即可,本期不做内容过滤)。
7. **`buildCustomToolsMcp` 的教训**(`server-agent.ts:227-266`):自定义工具直接 `fetch` 任意配置 URL,
   本方案**不要**走那条"配置化 endpoint"路线接抖音——白名单与提取脚本必须是代码常量,不可租户配置。

## 验证清单

1. **编译**:`npm run build` / tsc 通过。
2. **正常解析**:启用工具的模板,发抖音短链 → agent 调 `mcp__media__douyin_resolve`
   → 返回含 playUrl + author/stats/videoMeta/hashtags 的完整 JSON;紧接 ffmpeg 拉流成功;
   互动数字与页面显示一致(抽查点赞/评论数)。
2b. **评论**:调 `mcp__media__douyin_comments(url)` → 返回 ≤20 条,字段齐全,单条文本 ≤500 字;
   传返回的 cursor 翻第二页 → 内容不重复;cursor=-1 / 1e9 / 非整数 → 服务侧拒绝;
   三个工具独立勾选生效(只勾 resolve 的模板调 comments/transcribe 被 canUseTool 拒)。
2c. **转写**:resolve → transcribe({url: playUrl}) → 文本落 `cwd/transcripts/` 且返回体含全文;
   校验拒绝项逐条测:非白名单域 url、`audioPath: '../../etc/hosts'`、指向其他 run cwd 的
   绝对路径、软链逃逸、>1h 媒体(ffprobe 探出)、>500MB 文件;
   队列:同租户并发发 4 个任务 → 2 个入队、2 个被拒;超时任务被 SIGKILL 且队列继续;
   worker 全程 `HF_HUB_OFFLINE=1` 无网络下载(断外网跑一次验证);
   转写质量抽查:游戏解说类音频无"复读机"幻觉(condition_on_previous_text=False 生效)。
3. **白名单**:传 `https://example.com` / `http://` 链接 → 服务侧拒绝,isError,浏览器未发起导航。
4. **落地校验**:构造一个重定向到非抖音域的短链(可用本地跳转页模拟)→ 拒绝。
5. **未启用不可见**:模板不勾选该工具的 run 里,`mcp__media__douyin_resolve` 不在工具列表
   (`internalToolRuntimeNames` / canUseTool 拦截,与 image.inspect 行为一致)。
6. **cookie 隔离**:租户 A、B 各调一次,确认每次 `newContext()`(可在 service 打日志断言 context 数)。
7. **懒启动/空闲回收**:服务启动后无 Chrome 进程;首次调用后出现;空闲超时后消失;再次调用自动拉起。
8. **崩溃自愈**:手动 kill Chrome 进程 → 下一次调用自动重启浏览器并成功。
9. **并发/限流**:并发 5 个请求 → 同时活跃 context ≤ 2;单租户 1 分钟内打满限额 → 第 N+1 次 isError。
10. **登录墙路径**:找一个需登录视频 → 返回 `login_required_or_no_video`,不挂起不超时堆积。
11. **端到端**:服务端环境完整跑一遍 douyin-transcriber skill(Approach 0)→ 产出转写 txt。

## 验收标准

- 服务端 agent 不装浏览器、不装 whisper、不下载模型,即可完成"链接 → 元数据/评论 → 转写文本"全链路;
- agent 可触达的能力 = `douyin_resolve` / `douyin_comments` / `transcribe` 三个白名单窄接口,
  无通用浏览器、无任意 URL 下载、无任意命令;
- 浏览器全平台单实例、懒启动、空闲回收、崩溃自愈;租户间 cookie 隔离;
- 转写全局串行队列 + 每租户排队上限 + 任务超时 SIGKILL;模型离线加载零运行时下载;
- 白名单/限流/超时三层防护齐备,提取脚本为代码常量不可注入,transcribe 输入两型校验齐备;
- 未启用这些工具的模板行为零回归。

## 交付物

- 新文件 `dashboard/server-browser-service.ts`(BrowserService + resolveDouyinVideo + fetchDouyinComments)。
- 新文件 `dashboard/server-transcribe-service.ts`(TranscribeQueue + transcribeMedia)
  + worker 脚本 `dashboard/scripts/transcribe-worker.py`(随仓库交付的固定脚本)。
- `dashboard/server-internal-tools.ts`:三个目录项 + `buildMediaMcp`(三工具,签名含 cwd)。
- `dashboard/server-agent.ts`:import + 构建 + `mcpServers` 挂载(3 处小改)。
- `dashboard/package.json`:`playwright-core` 依赖。
- 部署脚本/文档:venv 创建 + 模型预下载 + ffmpeg/Chrome 检查(改动 1.5a)。
- douyin-transcriber SKILL.md 增补 Approach 0(纯编排版)。
- smoke 脚本 `dashboard/scripts/smoke-douyin-resolve.mjs`(覆盖验证 3/4/7)与
  `dashboard/scripts/smoke-transcribe.mjs`(覆盖验证 2c 的校验拒绝项与队列行为,
  转写本体可用一段本地短音频跑通)。
