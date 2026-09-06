import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './live-comment-send.js';

const ROOM_URL = 'https://www.xiaohongshu.com/livestream/570440812909234340?xsec_token=ABtok';

describe('xiaohongshu/live-comment-send command', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/live-comment-send');

    function makeSendPage({ prepare = { ok: true, content: '666', sendVisible: true }, clicked = { clicked: true }, verify = { sent: true, commentId: 'c9', cleared: true } } = {}) {
        return {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                const s = String(script);
                if (s.includes('insertText')) return prepare;
                if (s.includes('__send_click')) return clicked;
                if (s.includes('__send_verify')) return verify;
                throw new Error(`unexpected script: ${s.slice(0, 40)}`);
            }),
        };
    }

    it('registers as a persistent write with adapter-owned navigation', () => {
        const cmd = getCommand();
        expect(cmd).toBeDefined();
        expect(cmd.access).toBe('write');
        expect(cmd.siteSession).toBe('persistent');
        expect(cmd.navigateBefore).toBe(false);
    });

    it('sends and reports the verified comment', async () => {
        const page = makeSendPage();
        const rows = await getCommand().func(page, { 'room-url': ROOM_URL, text: '666' });
        expect(rows).toEqual([{ status: 'sent', room_id: '570440812909234340', msg: '666', comment_id: 'c9' }]);
        expect(page.goto).toHaveBeenCalledWith(ROOM_URL);
    });

    it('rejects empty or over-long text before navigation', async () => {
        const page = makeSendPage();
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, text: '   ' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, text: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('fails typed when the comment box is missing (logged out / room ended)', async () => {
        const page = makeSendPage({ prepare: { ok: false, reason: 'no_input_box' } });
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, text: '666' }))
            .rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('no_input_box') });
    });

    it('fails when the typed content does not match before sending (never sends garbled input)', async () => {
        const page = makeSendPage({ prepare: { ok: true, content: '66', sendVisible: true } });
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, text: '666' }))
            .rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('mismatch') });
        expect(page.evaluate.mock.calls.every(([s]) => !String(s).includes('__send_click'))).toBe(true);
    });

    it('fails when the postcondition never confirms the comment landed', async () => {
        const page = makeSendPage({ verify: { sent: false, cleared: false } });
        await expect(getCommand().func(page, { 'room-url': ROOM_URL, text: '666' }))
            .rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('not confirmed') });
    });
});
