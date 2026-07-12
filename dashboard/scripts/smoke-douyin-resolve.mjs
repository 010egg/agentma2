import assert from 'node:assert/strict';
import {
  BrowserService,
  closeBrowserService,
  resolveDouyinVideo,
} from '../server-browser-service.ts';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const stats = {
  launches: 0,
  closes: 0,
  crashes: 0,
  contextsCreated: 0,
  contextsClosed: 0,
  activeContexts: 0,
  maxActiveContexts: 0,
};

class FakePage {
  constructor(context) {
    this.context = context;
    this.currentUrl = 'about:blank';
    this.frame = {};
  }

  mainFrame() {
    return this.frame;
  }

  async goto(url) {
    if (url.includes('redirect=1')) {
      let aborted = false;
      await this.context.routeHandler({
        request: () => ({
          url: () => 'https://example.com/escaped',
          isNavigationRequest: () => true,
          frame: () => this.frame,
        }),
        abort: async () => { aborted = true; },
        continue: async () => {},
      });
      assert.equal(aborted, true, 'foreign redirect should be aborted before navigation');
      throw new Error('blocked redirect');
    }
    this.currentUrl = url;
  }

  url() {
    return this.currentUrl;
  }

  async evaluate(script) {
    assert.equal(script.startsWith('(async () =>'), true, 'server extraction function must be invoked');
    assert.equal(script.endsWith(')()'), true, 'server extraction function must be invoked');
    await delay(this.currentUrl.includes('hang=1') ? 250 : 20);
    const awemeId = this.currentUrl.match(/video\/(\d+)/)?.[1] || 'unknown';
    if (script.includes('/comment/list/')) {
      return {
        awemeId,
        cursor: 20,
        hasMore: true,
        total: 42,
        comments: [{
          text: 'x'.repeat(600),
          nickname: 'comment author',
          diggCount: 12,
          replyCount: 3,
          createTime: 1_700_000_001,
          ipLabel: '北京',
        }],
      };
    }
    return {
      playUrl: `https://video.amemv.com/${awemeId}.mp4`,
      title: 'smoke title',
      awemeId,
      createTime: 1_700_000_000,
      hashtags: ['smoke', 'test'],
      author: {
        nickname: 'smoke author',
        uniqueId: 'smoke-id',
        secUid: 'smoke-sec-uid',
        followerCount: 1234,
        avatarUrl: 'https://example-cdn.test/avatar.jpg',
      },
      stats: { playCount: 10, diggCount: 9, commentCount: 8, collectCount: 7, shareCount: 6 },
      videoMeta: {
        durationMs: 5000,
        width: 1080,
        height: 1920,
        ratio: '1080p',
        coverUrl: 'https://example-cdn.test/cover.jpg',
      },
      music: { title: 'music title', author: 'music author' },
    };
  }
}

class FakeContext {
  constructor() {
    this.routeHandler = async (route) => route.continue();
    this.closed = false;
    stats.contextsCreated += 1;
    stats.activeContexts += 1;
    stats.maxActiveContexts = Math.max(stats.maxActiveContexts, stats.activeContexts);
  }

  async route(_pattern, handler) {
    this.routeHandler = handler;
  }

  async newPage() {
    return new FakePage(this);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    stats.contextsClosed += 1;
    stats.activeContexts -= 1;
  }
}

class FakeBrowser {
  constructor() {
    this.connected = true;
    this.listeners = [];
  }

  isConnected() {
    return this.connected;
  }

  version() {
    return '150.0.7871.114';
  }

  on(event, listener) {
    if (event === 'disconnected') this.listeners.push(listener);
    return this;
  }

  async newContext(options) {
    assert.equal(options.locale, 'zh-CN');
    assert.match(options.userAgent, /iPhone/);
    return new FakeContext();
  }

  async close() {
    if (!this.connected) return;
    this.connected = false;
    stats.closes += 1;
    for (const listener of this.listeners) listener();
  }

  crash() {
    if (!this.connected) return;
    this.connected = false;
    stats.crashes += 1;
    for (const listener of this.listeners) listener();
  }
}

async function main() {
  if (process.env.AGENTMA_SMOKE_DOUYIN_URL) {
    const live = await resolveDouyinVideo(process.env.AGENTMA_SMOKE_DOUYIN_URL);
    console.log('live resolve:', JSON.stringify(live, null, 2));
    assert.equal(live.ok, true, `live resolve failed: ${live.ok ? '' : live.error}`);
    await closeBrowserService();
  }

  let currentBrowser = null;
  const service = new BrowserService({
    launchBrowser: async () => {
      stats.launches += 1;
      currentBrowser = new FakeBrowser();
      return currentBrowser;
    },
    idleShutdownMs: 30,
    resolveTimeoutMs: 1_000,
    concurrency: 2,
  });

  assert.deepEqual(await service.resolveDouyin('https://example.com/video/1'), { ok: false, error: 'host_not_allowed' });
  assert.deepEqual(await service.resolveDouyin('http://www.douyin.com/video/1'), { ok: false, error: 'https_required' });
  assert.equal(stats.launches, 0, 'invalid inputs must not launch a browser');

  const redirect = await service.resolveDouyin('https://v.douyin.com/test?redirect=1');
  assert.deepEqual(redirect, { ok: false, error: 'redirect_host_not_allowed' });
  assert.equal(stats.launches, 1);

  const success = await service.resolveDouyin('https://www.douyin.com/video/123');
  assert.deepEqual(success, {
    ok: true,
    awemeId: '123',
    playUrl: 'https://video.amemv.com/123.mp4',
    title: 'smoke title',
    createTime: 1_700_000_000,
    hashtags: ['smoke', 'test'],
    author: {
      nickname: 'smoke author',
      uniqueId: 'smoke-id',
      secUid: 'smoke-sec-uid',
      followerCount: 1234,
      avatarUrl: 'https://example-cdn.test/avatar.jpg',
    },
    stats: { playCount: 10, diggCount: 9, commentCount: 8, collectCount: 7, shareCount: 6 },
    videoMeta: {
      durationMs: 5000,
      width: 1080,
      height: 1920,
      ratio: '1080p',
      coverUrl: 'https://example-cdn.test/cover.jpg',
    },
    music: { title: 'music title', author: 'music author' },
  });

  const comments = await service.fetchDouyinComments('https://www.douyin.com/video/123', 0);
  assert.equal(comments.ok, true);
  assert.equal(comments.comments.length, 1);
  assert.equal(comments.comments[0].text.length, 500, 'comment text should be truncated');
  assert.equal(comments.cursor, 20);
  assert.deepEqual(await service.fetchDouyinComments('https://www.douyin.com/video/123', -1), {
    ok: false,
    error: 'invalid_cursor',
  });
  assert.deepEqual(await service.fetchDouyinComments('https://www.douyin.com/video/123', 10_001), {
    ok: false,
    error: 'invalid_cursor',
  });

  const concurrent = await Promise.all(Array.from({ length: 5 }, (_value, index) => (
    service.resolveDouyin(`https://www.douyin.com/video/${200 + index}`)
  )));
  assert.equal(concurrent.every((result) => result.ok), true);
  assert.equal(stats.maxActiveContexts <= 2, true, `max active contexts was ${stats.maxActiveContexts}`);
  assert.equal(stats.contextsCreated, stats.contextsClosed, 'every incognito context must close');

  await delay(60);
  assert.equal(stats.closes, 1, 'idle browser should close');
  assert.equal(service.getDiagnostics().browserStarted, false);

  const restarted = await service.resolveDouyin('https://www.douyin.com/video/999');
  assert.equal(restarted.ok, true);
  assert.equal(stats.launches, 2, 'next call should restart a closed browser');

  currentBrowser.crash();
  assert.equal(service.getDiagnostics().browserStarted, false, 'disconnect should clear the singleton');
  const recovered = await service.resolveDouyin('https://www.douyin.com/video/1000');
  assert.equal(recovered.ok, true);
  assert.equal(stats.launches, 3, 'next call should recover from a browser crash');
  await service.closeBrowser();

  const timeoutService = new BrowserService({
    launchBrowser: async () => {
      stats.launches += 1;
      return new FakeBrowser();
    },
    idleShutdownMs: 30,
    resolveTimeoutMs: 100,
    concurrency: 1,
  });
  const timedOut = await timeoutService.resolveDouyin('https://www.douyin.com/video/1001?hang=1');
  assert.deepEqual(timedOut, { ok: false, error: 'resolve_timeout' });
  await delay(270);
  await timeoutService.closeBrowser();
  assert.equal(stats.contextsCreated, stats.contextsClosed, 'timed out contexts must also close');

  console.log('douyin resolve smoke passed', JSON.stringify(stats));
}

main().catch(async (error) => {
  await closeBrowserService();
  console.error(error);
  process.exit(1);
});
