// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import MentionModule from '../mention.js';

const MentionJS = MentionModule?.default ?? MentionModule;
const instances = [];
afterEach(() => {
    for (const instance of instances.splice(0)) instance.destroy();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

function makeTextarea(options) {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const instance = new MentionJS(field, options);
    instances.push(instance);
    return { field, instance };
}

describe('search-result and reporting isolation', () => {
    it('handles an item whose ID getter throws without rejecting a public input handler', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { field, instance } = makeTextarea({
            searchFunction: async () => [{ name: 'Alice', get id() { throw new Error('revoked data'); } }],
        });
        field.focus();
        field.value = '@';
        field.setSelectionRange(1, 1);
        await expect(instance._onTextareaInput()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            'MentionJS: searchFunction returned an invalid result',
            expect.any(Error)
        );
        expect(instance.getMentions()).toEqual([]);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
    });

    it('handles a throwing nextPageUrl accessor as an invalid result', async () => {
        const { instance } = makeTextarea({
            searchFunction: async () => ({
                items: [{ id: 1, name: 'Alice' }],
                get nextPageUrl() { throw new Error('revoked pagination'); },
            }),
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await instance._searchSession.search('');
        expect(typeof result).toBe('symbol');
        expect(instance._searchSession.items).toEqual([]);
    });

    it('isolates an exception from console.warn while the search callback rejects', async () => {
        const { field, instance } = makeTextarea({
            searchFunction: async () => { throw new Error('request failed'); },
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {
            throw new Error('logging failed');
        });
        field.focus();
        field.value = '@';
        field.setSelectionRange(1, 1);
        await expect(instance._onTextareaInput()).resolves.toBeUndefined();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
    });

    it('falls back to default renderer if both custom renderer and logger fail', () => {
        const { instance } = makeTextarea({
            renderItem() { throw new Error('renderer failed'); },
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {
            throw new Error('logging failed');
        });
        instance._ui.mount('textarea');
        expect(() => instance._ui.render([{ id: 1, name: 'Alice' }], 0)).not.toThrow();
        expect(instance._ui.el.querySelector('.mention-name')?.textContent).toBe('Alice');
    });
});
