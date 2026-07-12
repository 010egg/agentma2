import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const DEFAULT_BROWSER_IDLE_SHUTDOWN_MS = 5 * 60_000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 30_000;
const DEFAULT_RESOLVE_CONCURRENCY = 2;
const MAX_INPUT_URL_LENGTH = 2_048;
const COMMENTS_PAGE_SIZE = 20;
const COMMENT_TEXT_MAX = 500;
const COMMENTS_CURSOR_MAX = 10_000;

const DOUYIN_ALLOWED_HOSTS = new Set([
  'v.douyin.com',
  'www.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
]);

// Server-owned extraction programs. Tenant text is never interpolated into
// executable JavaScript. COMMENTS_JS only receives a validated integer cursor.
const EXTRACT_JS = `async () => {
  const awemeId = location.pathname.match(/video\\/(\\d+)/)?.[1];
  if (!awemeId) return { error: 'not_video_page' };
  const project = (d) => {
    const video = d?.video;
    const addr = video?.play_addr_h264 || video?.play_addr;
    const rawPlayUrl = addr?.url_list?.slice(-1)[0] || '';
    const playUrl = rawPlayUrl.replace('/playwm/', '/play/');
    if (!playUrl) return null;
    return {
      awemeId,
      playUrl,
      title: d?.desc || '',
      createTime: d?.create_time ?? null,
      hashtags: (d?.text_extra || []).map((item) => item?.hashtag_name).filter(Boolean),
      author: {
        nickname: d?.author?.nickname || '',
        uniqueId: d?.author?.unique_id || '',
        secUid: d?.author?.sec_uid || '',
        followerCount: d?.author?.follower_count ?? d?.author?.mplatform_followers_count ?? null,
        avatarUrl: d?.author?.avatar_thumb?.url_list?.[0] || '',
      },
      stats: {
        playCount: d?.statistics?.play_count ?? null,
        diggCount: d?.statistics?.digg_count ?? null,
        commentCount: d?.statistics?.comment_count ?? null,
        collectCount: d?.statistics?.collect_count ?? null,
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
  };
  const ssrItem = window._ROUTER_DATA?.loaderData?.['video_(id)/page']
    ?.videoInfoRes?.item_list?.[0];
  const ssrResult = project(ssrItem);
  if (ssrResult) return ssrResult;
  try {
    const resp = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + awemeId);
    const text = await resp.text();
    if (text) {
      const d = JSON.parse(text).aweme_detail;
      const apiResult = project(d);
      if (apiResult) return apiResult;
    }
  } catch {}
  const video = document.querySelector('video');
  const playUrl = video?.currentSrc || video?.src || '';
  if (!playUrl) return { error: 'login_required_or_no_video' };
  return {
    awemeId,
    playUrl,
    title: (document.title || '').replace(' - 抖音', ''),
    author: {
      nickname: document.querySelector('[data-e2e="user-info-nickname"]')?.textContent || '',
    },
    partial: true,
  };
}`;

function commentsJs(cursor: number) {
  return `async () => {
    const awemeId = location.pathname.match(/video\\/(\\d+)/)?.[1];
    if (!awemeId) return { error: 'not_video_page' };
    try {
      const resp = await fetch('/aweme/v1/web/comment/list/?aweme_id=' + awemeId +
        '&cursor=${cursor}&count=${COMMENTS_PAGE_SIZE}');
      const text = await resp.text();
      if (!text) throw new Error('empty');
      const json = JSON.parse(text);
      return {
        awemeId,
        cursor: json.cursor ?? null,
        hasMore: Boolean(json.has_more),
        total: json.total ?? null,
        comments: (json.comments || []).map((comment) => ({
          text: String(comment?.text || '').slice(0, ${COMMENT_TEXT_MAX}),
          nickname: comment?.user?.nickname || '',
          diggCount: comment?.digg_count ?? null,
          replyCount: comment?.reply_comment_total ?? null,
          createTime: comment?.create_time ?? null,
          ipLabel: comment?.ip_label || '',
        })),
      };
    } catch {
      if (${cursor} === 0) {
        const item = window._ROUTER_DATA?.loaderData?.['video_(id)/page']
          ?.videoInfoRes?.item_list?.[0];
        const comments = item?.comment_list || [];
        if (comments.length) return {
          awemeId,
          cursor: comments.length,
          hasMore: Number(item?.statistics?.comment_count || 0) > comments.length,
          total: item?.statistics?.comment_count ?? null,
          comments: comments.map((comment) => ({
            text: String(comment?.text || '').slice(0, ${COMMENT_TEXT_MAX}),
            nickname: comment?.user?.nickname || '',
            diggCount: comment?.digg_count ?? null,
            replyCount: comment?.reply_comment_total ?? null,
            createTime: comment?.create_time ?? null,
            ipLabel: comment?.ip_label || '',
          })),
        };
      }
      return { error: 'login_required_or_empty' };
    }
  }`;
}

type RawExtractResult = {
  awemeId?: unknown;
  playUrl?: unknown;
  title?: unknown;
  createTime?: unknown;
  hashtags?: unknown;
  author?: unknown;
  stats?: unknown;
  videoMeta?: unknown;
  music?: unknown;
  partial?: unknown;
  error?: unknown;
};

type RawCommentsResult = {
  awemeId?: unknown;
  cursor?: unknown;
  hasMore?: unknown;
  total?: unknown;
  comments?: unknown;
  error?: unknown;
};

type SemaphoreWaiter = {
  grant: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

class DouyinResolveError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DouyinResolveError';
    this.code = code;
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function assertAllowedDouyinUrl(rawUrl: string, redirect = false) {
  const errorPrefix = redirect ? 'redirect_' : '';
  const normalized = String(rawUrl || '').trim();
  if (!normalized || normalized.length > MAX_INPUT_URL_LENGTH) {
    throw new DouyinResolveError(`${errorPrefix}invalid_url`);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new DouyinResolveError(`${errorPrefix}invalid_url`);
  }
  if (parsed.protocol !== 'https:') {
    throw new DouyinResolveError(`${errorPrefix}https_required`);
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new DouyinResolveError(`${errorPrefix}invalid_url`);
  }
  if (!DOUYIN_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new DouyinResolveError(`${errorPrefix}host_not_allowed`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeHttpUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.toString().slice(0, 4_096);
  } catch {
    return '';
  }
}

function normalizeNullableInteger(value: unknown, min = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) return null;
  return parsed;
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function remainingMs(deadline: number) {
  return Math.max(1, deadline - Date.now());
}

function douyinMobileUserAgent() {
  return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
}

export type DouyinResolveResult =
  | {
      ok: true;
      awemeId: string;
      playUrl: string;
      title: string;
      createTime: number | null;
      hashtags: string[];
      author: {
        nickname: string;
        uniqueId: string;
        secUid: string;
        followerCount: number | null;
        avatarUrl: string;
      };
      stats: {
        playCount: number | null;
        diggCount: number | null;
        commentCount: number | null;
        collectCount: number | null;
        shareCount: number | null;
      };
      videoMeta: {
        durationMs: number | null;
        width: number | null;
        height: number | null;
        ratio: string;
        coverUrl: string;
      };
      music: { title: string; author: string };
      partial?: true;
    }
  | { ok: false; error: string };

export type DouyinCommentsResult =
  | {
      ok: true;
      awemeId: string;
      cursor: number | null;
      hasMore: boolean;
      total: number | null;
      comments: Array<{
        text: string;
        nickname: string;
        diggCount: number | null;
        replyCount: number | null;
        createTime: number | null;
        ipLabel: string;
      }>;
    }
  | { ok: false; error: string };

export type BrowserServiceOptions = {
  launchBrowser?: () => Promise<Browser>;
  idleShutdownMs?: number;
  resolveTimeoutMs?: number;
  concurrency?: number;
};

type PageExecutionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class BrowserService {
  private readonly launchBrowser: () => Promise<Browser>;
  private readonly idleShutdownMs: number;
  private readonly resolveTimeoutMs: number;
  private readonly concurrency: number;
  private browserPromise: Promise<Browser> | null = null;
  private browserInstance: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeResolves = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(options: BrowserServiceOptions = {}) {
    this.launchBrowser = options.launchBrowser || (() => chromium.launch({ channel: 'chrome', headless: true }));
    this.idleShutdownMs = clampInteger(options.idleShutdownMs, DEFAULT_BROWSER_IDLE_SHUTDOWN_MS, 1, 60 * 60_000);
    this.resolveTimeoutMs = clampInteger(options.resolveTimeoutMs, DEFAULT_RESOLVE_TIMEOUT_MS, 100, 5 * 60_000);
    this.concurrency = clampInteger(options.concurrency, DEFAULT_RESOLVE_CONCURRENCY, 1, 16);
  }

  getDiagnostics() {
    return {
      browserStarted: Boolean(this.browserPromise),
      browserConnected: Boolean(this.browserInstance?.isConnected()),
      activeResolves: this.activeResolves,
      queuedResolves: this.waiters.length,
    };
  }

  private clearIdleTimer() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleShutdown() {
    this.clearIdleTimer();
    if (!this.browserPromise || this.activeResolves || this.waiters.length) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.closeBrowser();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const launchPromise = this.launchBrowser();
      this.browserPromise = launchPromise;
      launchPromise.then((browser) => {
        this.browserInstance = browser;
        browser.on('disconnected', () => {
          if (this.browserInstance !== browser) return;
          this.browserInstance = null;
          this.browserPromise = null;
          this.clearIdleTimer();
        });
      }).catch(() => {
        if (this.browserPromise === launchPromise) this.browserPromise = null;
      });
    }

    let browser: Browser;
    try {
      browser = await this.browserPromise;
    } catch {
      throw new DouyinResolveError('browser_launch_failed');
    }
    if (!browser.isConnected()) {
      if (this.browserInstance === browser) this.browserInstance = null;
      this.browserPromise = null;
      return this.getBrowser();
    }
    return browser;
  }

  private acquire(deadline: number) {
    if (this.activeResolves < this.concurrency) {
      this.activeResolves += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        grant: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.activeResolves += 1;
          resolve();
        },
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(new DouyinResolveError('resolve_timeout'));
      }, remainingMs(deadline));
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private release() {
    this.activeResolves = Math.max(0, this.activeResolves - 1);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.grant();
      return;
    }
    this.scheduleIdleShutdown();
  }

  private async runBrowserScript<T>(rawUrl: string, deadline: number, script: string): Promise<T> {
    const state: { context: BrowserContext | null } = { context: null };
    let timedOut = false;
    let blockedNavigationUrl = '';
    let timeoutTimer: NodeJS.Timeout | null = null;

    const operation: Promise<T> = (async (): Promise<T> => {
      const browser = await this.getBrowser();
      if (timedOut) throw new DouyinResolveError('resolve_timeout');
      const createdContext = await browser.newContext({
        locale: 'zh-CN',
        userAgent: douyinMobileUserAgent(),
      });
      if (timedOut) {
        await createdContext.close().catch(() => {});
        throw new DouyinResolveError('resolve_timeout');
      }
      state.context = createdContext;

      let page: Page | null = null;
      await createdContext.route('**/*', async (route) => {
        const request = route.request();
        if (page && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            assertAllowedDouyinUrl(request.url(), true);
          } catch {
            blockedNavigationUrl = request.url();
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      });
      page = await createdContext.newPage();

      try {
        await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: remainingMs(deadline) });
      } catch {
        if (blockedNavigationUrl) throw new DouyinResolveError('redirect_host_not_allowed');
        if (timedOut || Date.now() >= deadline) throw new DouyinResolveError('resolve_timeout');
        throw new DouyinResolveError('navigation_failed');
      }

      assertAllowedDouyinUrl(page.url(), true);
      try {
        return await page.evaluate<T>(`(${script})()`);
      } catch {
        if (timedOut || Date.now() >= deadline) throw new DouyinResolveError('resolve_timeout');
        throw new DouyinResolveError('extraction_failed');
      }
    })();

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        void state.context?.close().catch(() => {});
        reject(new DouyinResolveError('resolve_timeout'));
      }, remainingMs(deadline));
      timeoutTimer.unref?.();
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await state.context?.close().catch(() => {});
    }
  }

  private async executePage<T>(rawUrl: string, script: string): Promise<PageExecutionResult<T>> {
    let normalizedUrl: string;
    try {
      normalizedUrl = assertAllowedDouyinUrl(rawUrl).toString();
    } catch (error) {
      return { ok: false, error: error instanceof DouyinResolveError ? error.code : 'invalid_url' };
    }

    const deadline = Date.now() + this.resolveTimeoutMs;
    this.clearIdleTimer();
    try {
      await this.acquire(deadline);
    } catch (error) {
      return { ok: false, error: error instanceof DouyinResolveError ? error.code : 'resolve_timeout' };
    }

    try {
      return { ok: true, value: await this.runBrowserScript<T>(normalizedUrl, deadline, script) };
    } catch (error) {
      return { ok: false, error: error instanceof DouyinResolveError ? error.code : 'browser_error' };
    } finally {
      this.release();
    }
  }

  async resolveDouyin(rawUrl: string): Promise<DouyinResolveResult> {
    const result = await this.executePage<RawExtractResult>(rawUrl, EXTRACT_JS);
    if (!result.ok) return result;
    if (result.value?.error) {
      return { ok: false, error: normalizeText(result.value.error, 100) || 'resolve_failed' };
    }

    const awemeId = normalizeText(result.value?.awemeId, 64);
    const playUrl = normalizeHttpUrl(result.value?.playUrl);
    if (!awemeId) return { ok: false, error: 'not_video_page' };
    if (!playUrl) return { ok: false, error: 'login_required_or_no_video' };

    const author = asRecord(result.value.author);
    const stats = asRecord(result.value.stats);
    const videoMeta = asRecord(result.value.videoMeta);
    const music = asRecord(result.value.music);
    const partial = result.value.partial === true;
    return {
      ok: true,
      awemeId,
      playUrl,
      title: normalizeText(result.value.title, 500),
      createTime: normalizeNullableInteger(result.value.createTime),
      hashtags: normalizeStringArray(result.value.hashtags, 50, 100),
      author: {
        nickname: normalizeText(author.nickname, 200),
        uniqueId: normalizeText(author.uniqueId, 100),
        secUid: normalizeText(author.secUid, 200),
        followerCount: normalizeNullableInteger(author.followerCount),
        avatarUrl: normalizeHttpUrl(author.avatarUrl),
      },
      stats: {
        playCount: normalizeNullableInteger(stats.playCount),
        diggCount: normalizeNullableInteger(stats.diggCount),
        commentCount: normalizeNullableInteger(stats.commentCount),
        collectCount: normalizeNullableInteger(stats.collectCount),
        shareCount: normalizeNullableInteger(stats.shareCount),
      },
      videoMeta: {
        durationMs: normalizeNullableInteger(videoMeta.durationMs),
        width: normalizeNullableInteger(videoMeta.width),
        height: normalizeNullableInteger(videoMeta.height),
        ratio: normalizeText(videoMeta.ratio, 50),
        coverUrl: normalizeHttpUrl(videoMeta.coverUrl),
      },
      music: {
        title: normalizeText(music.title, 300),
        author: normalizeText(music.author, 200),
      },
      ...(partial ? { partial: true as const } : {}),
    };
  }

  async fetchDouyinComments(rawUrl: string, cursor = 0): Promise<DouyinCommentsResult> {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > COMMENTS_CURSOR_MAX) {
      return { ok: false, error: 'invalid_cursor' };
    }
    const result = await this.executePage<RawCommentsResult>(rawUrl, commentsJs(cursor));
    if (!result.ok) return result;
    if (result.value?.error) {
      return { ok: false, error: normalizeText(result.value.error, 100) || 'comments_fetch_failed' };
    }

    const awemeId = normalizeText(result.value?.awemeId, 64);
    if (!awemeId) return { ok: false, error: 'not_video_page' };
    const rawComments = Array.isArray(result.value.comments) ? result.value.comments : [];
    return {
      ok: true,
      awemeId,
      cursor: normalizeNullableInteger(result.value.cursor),
      hasMore: result.value.hasMore === true,
      total: normalizeNullableInteger(result.value.total),
      comments: rawComments.slice(0, COMMENTS_PAGE_SIZE).map((item) => {
        const comment = asRecord(item);
        return {
          text: normalizeText(comment.text, COMMENT_TEXT_MAX),
          nickname: normalizeText(comment.nickname, 200),
          diggCount: normalizeNullableInteger(comment.diggCount),
          replyCount: normalizeNullableInteger(comment.replyCount),
          createTime: normalizeNullableInteger(comment.createTime),
          ipLabel: normalizeText(comment.ipLabel, 100),
        };
      }),
    };
  }

  async closeBrowser() {
    this.clearIdleTimer();
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    this.browserInstance = null;
    if (!browserPromise) return;
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {
      // A failed launch or an already-dead browser is already fully released.
    }
  }
}

const browserService = new BrowserService({
  idleShutdownMs: clampInteger(process.env.AGENTMA_BROWSER_IDLE_MS, DEFAULT_BROWSER_IDLE_SHUTDOWN_MS, 1_000, 60 * 60_000),
  resolveTimeoutMs: clampInteger(process.env.AGENTMA_DOUYIN_RESOLVE_TIMEOUT_MS, DEFAULT_RESOLVE_TIMEOUT_MS, 1_000, 5 * 60_000),
  concurrency: clampInteger(process.env.AGENTMA_BROWSER_CONCURRENCY, DEFAULT_RESOLVE_CONCURRENCY, 1, 16),
});

export function resolveDouyinVideo(rawUrl: string) {
  return browserService.resolveDouyin(rawUrl);
}

export function fetchDouyinComments(rawUrl: string, cursor = 0) {
  return browserService.fetchDouyinComments(rawUrl, cursor);
}

export function closeBrowserService() {
  return browserService.closeBrowser();
}

export function getBrowserServiceDiagnostics() {
  return browserService.getDiagnostics();
}
