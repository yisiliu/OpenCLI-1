/**
 * Xiaohongshu live-comments — capture the comment stream of a live room.
 *
 * Architecture (the MutationObserverWatcher pattern from
 * DimensionDev/Holoflows-Kit, re-implemented clean-room — that library is
 * AGPL-3.0 and OpenCLI is Apache-2.0, so the pattern is adopted, not the
 * code): an in-page watcher installed once per room observes the chat area
 * with a MutationObserver; each DOM mutation triggers a merge of the
 * structured `__INITIAL_STATE__.liveStream.comments` store (msg, nickName,
 * userId, commentId, fansGroup, ...) into a capped buffer, deduped by
 * commentId. The DOM is only the trigger — the store is the data source, so
 * rows carry full metadata instead of scraped text.
 *
 * The watcher lives on the persistent site tab ACROSS CLI invocations:
 * install once, then repeated `--duration 0` calls drain only what arrived
 * since the last call — a streaming loop out of one-shot commands, with
 * nothing lost between calls even when the page's own comment window slides.
 * This command therefore navigates with a PLAIN goto: the extension's
 * same-URL fast-path is what keeps the installed watcher alive. Running
 * other xiaohongshu commands in between navigates the shared tab away and
 * resets the watcher — keep a comment-capture loop on its own profile, or
 * accept a fresh install on the next call.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from './shared.js';

const MAX_DURATION_S = 60;
const BUFFER_CAP = 2000;
const SEEN_CAP = 10000;

export function buildLiveWatcherInstallJs() {
    return `
    (() => {
      if (window.__opencli_live_watch?.installed) return { installed: true, fresh: false };
      const state = { installed: true, buf: [], seen: new Set() };
      const readStore = () => {
        const ls = window.__INITIAL_STATE__?.liveStream;
        const raw = ls?.comments?._value ?? ls?.comments;
        return Array.isArray(raw) ? raw : [];
      };
      const merge = () => {
        for (const c of readStore()) {
          const id = String(c?.commentId ?? '');
          if (!id || state.seen.has(id)) continue;
          state.seen.add(id);
          try { state.buf.push(JSON.parse(JSON.stringify(c))); } catch { continue; }
          if (state.buf.length > ${BUFFER_CAP}) state.buf.shift();
        }
        if (state.seen.size > ${SEEN_CAP}) state.seen = new Set([...state.seen].slice(-${SEEN_CAP / 2}));
      };
      merge();
      const area = document.querySelector('.live-chat')
        ?? document.querySelector('[class*="chat-area"]')
        ?? document.body;
      const observer = new MutationObserver(merge);
      observer.observe(area, { childList: true, subtree: true });
      state.observer = observer;
      window.__opencli_live_watch = state;
      return { installed: true, fresh: true };
    })()
  `;
}

export function buildLiveWatcherDrainJs() {
    return `
    (() => {
      const state = window.__opencli_live_watch;
      if (!state?.installed) return { installed: false, items: [] };
      return { installed: true, items: state.buf.splice(0, state.buf.length) };
    })()
  `;
}

export function parseRoomUrl(raw) {
    const input = String(raw ?? '').trim();
    if (/^\d{6,}$/.test(input)) {
        return `https://www.xiaohongshu.com/livestream/${input}`;
    }
    let parsed;
    try {
        parsed = new URL(input);
    }
    catch {
        throw new ArgumentError('room-url must be a numeric room id or a full https://www.xiaohongshu.com/livestream/... URL');
    }
    if (parsed.hostname !== 'www.xiaohongshu.com' || !/^\/livestream\/\d+/.test(parsed.pathname)) {
        throw new ArgumentError('room-url must point at www.xiaohongshu.com/livestream/<room_id>', 'Use a room URL from `xiaohongshu lives` or the live list page.');
    }
    return parsed.toString();
}

function parseDuration(raw) {
    const parsed = Number(raw ?? 15);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DURATION_S) {
        throw new ArgumentError(`--duration must be an integer between 0 and ${MAX_DURATION_S} seconds, got ${JSON.stringify(raw)}`, '0 drains whatever accumulated since the previous call.');
    }
    return parsed;
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'live-comments',
    access: 'read',
    description: '采集小红书直播间评论流（页内 MutationObserver 持续捕获，跨调用不丢）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    siteSession: 'persistent',
    args: [
        { name: 'room-url', required: true, positional: true, help: 'Room URL from `xiaohongshu lives` (or a bare numeric room id)' },
        { name: 'duration', type: 'int', default: 15, help: `Seconds to collect before draining (0-${MAX_DURATION_S}; 0 = drain what accumulated since the last call)` },
        { name: 'limit', type: 'int', default: 200, help: 'Maximum comments to return' },
    ],
    columns: ['seq', 'nickname', 'user_id', 'msg', 'comment_type', 'fans_group', 'comment_id'],
    func: async (page, kwargs) => {
        const url = parseRoomUrl(kwargs['room-url']);
        const duration = parseDuration(kwargs.duration);
        const limit = Math.max(1, Number(kwargs.limit ?? 200));
        // Plain goto on purpose: a warm tab already in this room fast-paths
        // without reloading, which keeps the installed watcher (and its
        // dedupe state) alive across CLI invocations.
        await page.goto(url);
        await page.wait({ time: 2 });
        const install = unwrapEvaluateResult(await page.evaluate(buildLiveWatcherInstallJs()));
        if (!install || typeof install !== 'object' || install.installed !== true) {
            throw new CommandExecutionError('xiaohongshu live-comments: failed to install the in-page comment watcher');
        }
        if (duration > 0) {
            await page.wait({ time: duration });
        }
        const drained = unwrapEvaluateResult(await page.evaluate(buildLiveWatcherDrainJs()));
        if (!drained || typeof drained !== 'object' || !Array.isArray(drained.items)) {
            throw new CommandExecutionError('xiaohongshu live-comments: watcher drain returned a malformed payload');
        }
        const rows = drained.items
            .filter((item) => item && typeof item === 'object' && item.commentId)
            .slice(0, limit)
            .map((item, index) => ({
            seq: index + 1,
            nickname: String(item.nickName ?? ''),
            user_id: String(item.userId ?? ''),
            msg: String(item.msg ?? ''),
            comment_type: Number(item.commentType ?? 0),
            fans_group: String(item.fansGroup?.groupName ?? ''),
            comment_id: String(item.commentId),
        }));
        if (rows.length === 0) {
            if (duration === 0 && install.fresh === true) {
                throw new EmptyResultError('xiaohongshu live-comments', 'The watcher was freshly installed on this call (the tab had navigated away or this is the first call for this room) — nothing was buffered yet. Call again to drain from here on.');
            }
            throw new EmptyResultError('xiaohongshu live-comments', duration > 0
                ? `No comments arrived within ${duration}s — the room may be quiet or the stream ended.`
                : 'The watcher stayed alive but nothing new arrived since the previous drain.');
        }
        return rows;
    },
});
