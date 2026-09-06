import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildLiveWatcherDrainJs, buildLiveWatcherInstallJs } from './live-comments.js';
import './live-comments.js';

const ROOM_URL = 'https://www.xiaohongshu.com/livestream/570440812909234340?xsec_token=ABtok';

function comment(id, msg, nick = '晶晶') {
    return {
        commentId: id,
        msg,
        nickName: nick,
        userId: `u-${id}`,
        commentType: 0,
        avatar: 'https://a/b.jpg',
        fansGroup: { groupName: '毛毛拖鞋', groupLevel: 2 },
    };
}

function makeRoomDom(initialComments) {
    const dom = new JSDOM('<div class="live-chat"><div class="virtual-list"></div></div>', {
        url: 'https://www.xiaohongshu.com/livestream/1',
    });
    const win = dom.window;
    win.__INITIAL_STATE__ = { liveStream: { comments: { _value: initialComments } } };
    const run = (script) => Function('window', 'document', 'MutationObserver', `return (${script})`)(
        win, win.document, win.MutationObserver,
    );
    const touchChat = async () => {
        win.document.querySelector('.virtual-list').appendChild(win.document.createElement('div'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { win, run, touchChat };
}

describe('live-comments in-page watcher (real MutationObserver in JSDOM)', () => {
    it('captures the initial store snapshot on install and drains it once', async () => {
        const { run } = makeRoomDom([comment('c1', '这个咖啡机怎么卖')]);
        expect(run(buildLiveWatcherInstallJs())).toEqual({ installed: true, fresh: true });
        const first = run(buildLiveWatcherDrainJs());
        expect(first.installed).toBe(true);
        expect(first.items.map((i) => i.commentId)).toEqual(['c1']);
        expect(run(buildLiveWatcherDrainJs()).items).toEqual([]);
    });

    it('merges new store comments when the chat DOM mutates, deduped by commentId', async () => {
        const { win, run, touchChat } = makeRoomDom([comment('c1', 'a')]);
        run(buildLiveWatcherInstallJs());
        run(buildLiveWatcherDrainJs());
        // Virtual-list style churn: the store window slides, old + new coexist.
        win.__INITIAL_STATE__.liveStream.comments._value = [comment('c1', 'a'), comment('c2', 'b')];
        await touchChat();
        const drained = run(buildLiveWatcherDrainJs());
        expect(drained.items.map((i) => i.commentId)).toEqual(['c2']);
    });

    it('is idempotent: a second install keeps the buffer and reports fresh=false', async () => {
        const { win, run, touchChat } = makeRoomDom([comment('c1', 'a')]);
        run(buildLiveWatcherInstallJs());
        win.__INITIAL_STATE__.liveStream.comments._value = [comment('c2', 'b')];
        await touchChat();
        expect(run(buildLiveWatcherInstallJs())).toEqual({ installed: true, fresh: false });
        const drained = run(buildLiveWatcherDrainJs());
        expect(drained.items.map((i) => i.commentId)).toEqual(['c1', 'c2']);
    });

    it('drain on a page without the watcher reports installed=false', () => {
        const { run } = makeRoomDom([]);
        expect(run(buildLiveWatcherDrainJs())).toEqual({ installed: false, items: [] });
    });
});

describe('xiaohongshu/live-comments command', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/live-comments');

    function makePage({ drains = [{ installed: true, items: [comment('c1', '好优雅', 'Joce1yn')] }], fresh = true } = {}) {
        let drainIndex = 0;
        return {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                const s = String(script);
                if (s.includes('splice')) return drains[Math.min(drainIndex++, drains.length - 1)];
                if (s.includes('__opencli_live_watch')) return { installed: true, fresh };
                throw new Error(`unexpected script: ${s.slice(0, 40)}`);
            }),
        };
    }

    it('registers persistent with adapter-owned navigation', () => {
        const cmd = getCommand();
        expect(cmd).toBeDefined();
        expect(cmd.navigateBefore).toBe(false);
        expect(cmd.siteSession).toBe('persistent');
    });

    it('navigates with a PLAIN goto so a warm tab keeps the installed watcher', async () => {
        const page = makePage();
        page.getCurrentUrl = vi.fn().mockResolvedValue(ROOM_URL);
        await getCommand().func(page, { 'room-url': ROOM_URL, duration: 0 });
        expect(page.goto).toHaveBeenCalledWith(ROOM_URL);
        expect(page.evaluate).not.toHaveBeenCalledWith('location.reload()');
    });

    it('maps drained comments into rows', async () => {
        const page = makePage();
        const rows = await getCommand().func(page, { 'room-url': ROOM_URL, duration: 0 });
        expect(rows).toEqual([{
            seq: 1,
            nickname: 'Joce1yn',
            user_id: 'u-c1',
            msg: '好优雅',
            comment_type: 0,
            fans_group: '毛毛拖鞋',
            comment_id: 'c1',
        }]);
    });

    it('waits out --duration before draining', async () => {
        const page = makePage();
        await getCommand().func(page, { 'room-url': ROOM_URL, duration: 10 });
        const waited = page.wait.mock.calls.reduce((sum, [arg]) => sum + (arg?.time ?? arg ?? 0), 0);
        expect(waited).toBeGreaterThanOrEqual(10);
    });

    it('rejects durations beyond the command timeout budget', async () => {
        const page = makePage();
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, duration: 999 }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
    });

    it('accepts a bare room id', async () => {
        const page = makePage();
        await getCommand().func(page, { 'room-url': '570440812909234340', duration: 0 });
        expect(page.goto).toHaveBeenCalledWith('https://www.xiaohongshu.com/livestream/570440812909234340');
    });

    it('throws EMPTY_RESULT when nothing new arrived', async () => {
        const page = makePage({ drains: [{ installed: true, items: [] }] });
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, duration: 0 }))
            .rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    });
});

describe('xiaohongshu/live-comments empty-drain diagnostics', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/live-comments');
    function makeEmptyPage(fresh) {
        return {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                const s = String(script);
                if (s.includes('splice')) return { installed: true, items: [] };
                if (s.includes('__opencli_live_watch')) return { installed: true, fresh };
                throw new Error('unexpected script');
            }),
        };
    }

    it('tells the caller when an empty drain is due to a fresh install (watcher was lost)', async () => {
        await expect(getCommand().func(makeEmptyPage(true), { 'room-url': ROOM_URL, duration: 0 }))
            .rejects.toMatchObject({ code: 'EMPTY_RESULT', hint: expect.stringContaining('freshly installed') });
    });

    it('tells the caller when the watcher survived but nothing new arrived', async () => {
        await expect(getCommand().func(makeEmptyPage(false), { 'room-url': ROOM_URL, duration: 0 }))
            .rejects.toMatchObject({ code: 'EMPTY_RESULT', hint: expect.stringContaining('stayed alive') });
    });
});
