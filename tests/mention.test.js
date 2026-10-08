// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MentionModule from '../mention.js';

const MentionJS = MentionModule?.default ?? MentionModule;

if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 0;
    };
}

if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
}

function setCaret(node, offset) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function beforeInput(element, inputType, data = null) {
    const event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType,
        data,
    });
    element.dispatchEvent(event);
    return event;
}

function input(element) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('MentionJS behavior invariants', () => {
    it('accepts only textarea or contenteditable editing hosts', () => {
        const inputElement = document.createElement('input');
        expect(() => new MentionJS(inputElement)).toThrow(/textarea or contenteditable/);
    });

    it('starts textarea search on the trigger and stops it when the trigger disappears', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
        const mention = new MentionJS(textarea, { searchFunction, debounceDelay: 0 });

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', null);
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.value = '';
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('cancels an unresolved search when the editing host loses focus', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        expect(searchFunction).toHaveBeenCalledTimes(1);
        textarea.dispatchEvent(new Event('blur'));
        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('inserts push() at the active textarea caret and keeps mention offsets correct', () => {
        const textarea = document.createElement('textarea');
        textarea.value = 'hello world';
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.focus();
        textarea.setSelectionRange(6, 6);

        mention.push({ id: 7, name: 'Alice' });

        expect(textarea.value).toBe('hello @Alice world');
        expect(mention.getMentions()).toEqual([
            { id: 7, name: 'Alice', start: 6, end: 12 },
        ]);
        expect(textarea.selectionStart).toBe(13);
        mention.destroy();
    });

    it('does not move textarea mention identity onto a different equal-looking token', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);

        mention.push({ id: 42, name: 'Alice' });
        textarea.value += '@Alice';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        textarea.setSelectionRange(0, 7);
        beforeInput(textarea, 'deleteContentBackward');
        textarea.value = textarea.value.substring(7);
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(textarea.value).toBe('@Alice');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('does not expose an unfinished contenteditable token as a committed mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention.active')).not.toBeNull();
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('backspace at a mention boundary deletes one adjacent character, not the whole rich-text node', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc</strong><span class="mention" data-mention-id="1" data-mention-name="Alice">@Alice</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 0);
        beforeInput(editor, 'deleteContentBackward');

        expect(editor.querySelector('strong')).not.toBeNull();
        expect(editor.querySelector('strong').textContent).toBe('ab');
        mention.destroy();
    });

    it('stops treating a contenteditable token as a mention when its trigger is removed by browser-driven input', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        span.textContent = 'Alice';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        expect(mention.getMentions()).toEqual([]);
        expect(editor.textContent.startsWith('Alice')).toBe(true);
        mention.destroy();
    });
});


describe('MentionJS interaction consistency', () => {
    it('keeps ARIA combobox state synchronized with dropdown selection', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        });

        textarea.value = '@';
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(textarea.getAttribute('aria-expanded')).toBe('true');
        });

        const dropdown = document.querySelector('.mention-dropdown');
        const options = dropdown.querySelectorAll('.mention-item[data-index]');

        expect(textarea.getAttribute('role')).toBe('combobox');
        expect(dropdown.getAttribute('role')).toBe('listbox');
        expect(options[0].getAttribute('role')).toBe('option');
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        expect(options[0].getAttribute('aria-selected')).toBe('false');
        expect(options[1].getAttribute('aria-selected')).toBe('true');
        expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);
        mention.destroy();
    });

    it('uses the hovered dropdown item for the next keyboard commit', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        });

        textarea.value = '@';
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        const second = document.querySelector('.mention-item[data-index="1"]');
        second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@Bob ');
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 0, end: 4 },
        ]);
        mention.destroy();
    });

    it('dispatches input after committing a contenteditable mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });
        const externalInput = vi.fn();
        editor.addEventListener('input', externalInput);

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        externalInput.mockClear();

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(externalInput).toHaveBeenCalledTimes(1);
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        mention.destroy();
    });

    it('ignores unrelated elements that only reuse the mention CSS class', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention">ordinary styled text</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        const foreign = editor.querySelector('.mention');
        setCaret(foreign.firstChild, 1);
        beforeInput(editor, 'deleteContentBackward');

        expect(foreign.textContent).toBe('ordinary styled text');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });
});


describe('MentionJS caret lifecycle', () => {
    it('closes textarea search when the caret leaves the active trigger token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.value = '@a';
        textarea.focus();
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.setSelectionRange(0, 0);
        document.dispatchEvent(new Event('selectionchange'));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('updates textarea search when the caret moves within the active token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.value = '@abc';
        textarea.focus();
        textarea.setSelectionRange(4, 4);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('abc', null);
        });

        textarea.setSelectionRange(2, 2);
        document.dispatchEvent(new Event('selectionchange'));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('a', null);
        });

        mention.destroy();
    });

    it('closes contenteditable search when selection leaves the active mention span', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        const outsideText = document.createTextNode('outside');
        editor.appendChild(outsideText);
        setCaret(outsideText, outsideText.textContent.length);
        document.dispatchEvent(new Event('selectionchange'));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS preserved feature behavior', () => {
    it('debounces non-empty searches and cancels the superseded query before execution', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 20,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('ab', null);
        });

        expect(searchFunction).not.toHaveBeenCalledWith('a', null);
        mention.destroy();
    });

    it('ignores a stale async response after a newer query has completed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveInitial;
        const initial = new Promise((resolve) => {
            resolveInitial = resolve;
        });
        const searchFunction = vi.fn((query) => {
            if (query === '') return initial;
            return Promise.resolve([{ id: 2, name: 'Fast' }]);
        });
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        textarea.value = '@f';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('Fast');
        });

        resolveInitial([{ id: 1, name: 'Stale' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-name')?.textContent).toBe('Fast');
        mention.destroy();
    });

    it('loads the next result page when keyboard selection approaches the end', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn(async (query, nextPageUrl) => {
            if (nextPageUrl) {
                return {
                    items: [{ id: 3, name: 'Charlie' }],
                    nextPageUrl: null,
                };
            }
            return {
                items: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
                nextPageUrl: '/next',
            };
        });
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/next');
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(3);
        });

        mention.destroy();
    });

    it('keeps custom single-character triggers behavior identical to the default trigger', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            trigger: '#',
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '#topic';
        textarea.setSelectionRange(6, 6);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('topic', null);
        });

        mention.destroy();
    });

    it('does not start textarea search when the trigger is embedded in a word', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = 'mail@alice';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(searchFunction).not.toHaveBeenCalled();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('inserts push() at the active contenteditable caret instead of appending to the end', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.textContent = 'hello world';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        editor.focus();
        setCaret(editor.firstChild, 6);
        mention.push({ id: 2, name: 'Bob' });

        expect(editor.textContent).toBe('hello @Bob\u00A0world');
        expect(mention.getMentions()).toEqual([{ id: '2', name: 'Bob' }]);

        const selection = window.getSelection();
        expect(selection.anchorNode.nodeType).toBe(Node.TEXT_NODE);
        expect(selection.anchorNode.textContent).toBe('\u00A0');
        expect(selection.anchorOffset).toBe(1);
        mention.destroy();
    });

    it('places the caret after the trailing space when a textarea mention is committed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@Alice ');
        expect(textarea.selectionStart).toBe(7);
        expect(textarea.selectionEnd).toBe(7);
        mention.destroy();
    });

    it('places the caret after the trailing non-breaking space when a contenteditable mention is committed', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        const selection = window.getSelection();
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        expect(selection.anchorNode.nodeType).toBe(Node.TEXT_NODE);
        expect(selection.anchorNode.textContent).toBe('\u00A0');
        expect(selection.anchorOffset).toBe(1);
        mention.destroy();
    });

    it('clear resets content, committed mentions, dropdown, and accessibility state', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        mention.push({ id: 2, name: 'Bob' });
        textarea.focus();
        textarea.value += '@';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        mention.clear();

        expect(textarea.value).toBe('');
        expect(mention.getMentions()).toEqual([]);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        mention.destroy();
    });

    it('destroy removes behavior listeners and restores host accessibility attributes', async () => {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('role', 'textbox');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, { searchFunction });

        expect(textarea.getAttribute('role')).toBe('textbox');
        expect(textarea.getAttribute('aria-autocomplete')).toBe('list');

        mention.destroy();

        expect(textarea.getAttribute('role')).toBe('textbox');
        expect(textarea.hasAttribute('aria-autocomplete')).toBe(false);
        expect(textarea.hasAttribute('aria-controls')).toBe(false);
        expect(textarea.hasAttribute('aria-expanded')).toBe(false);

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await Promise.resolve();

        expect(searchFunction).not.toHaveBeenCalled();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
    });
});


describe('MentionJS option and rich-text boundaries', () => {
    it('rejects invalid trigger values instead of partially supporting them', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(() => new MentionJS(textarea, { trigger: '' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: '@@' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: ' ' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: '#' })).not.toThrow();
    });

    it('rejects invalid debounce delays', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(() => new MentionJS(textarea, { debounceDelay: -1 })).toThrow(/debounceDelay/);
        expect(() => new MentionJS(textarea, { debounceDelay: Number.NaN })).toThrow(/debounceDelay/);
    });

    it('does not start contenteditable search directly after formatted non-whitespace text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc</strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });
        setCaret(editor, editor.childNodes.length);

        const event = beforeInput(editor, 'insertText', '@');
        await Promise.resolve();

        expect(event.defaultPrevented).toBe(false);
        expect(searchFunction).not.toHaveBeenCalled();
        expect(editor.querySelector('span.mention')).toBeNull();
        mention.destroy();
    });

    it('allows contenteditable search after whitespace inside a formatted node', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc </strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });
        setCaret(editor, editor.childNodes.length);

        const event = beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(event.defaultPrevented).toBe(true);
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });

        mention.destroy();
    });

    it('does not confuse a user search error named cancelled with internal cancellation', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const searchFunction = vi.fn().mockRejectedValue(new Error('cancelled'));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: search failed',
                expect.any(Error)
            );
        });

        mention.destroy();
    });
});


describe('MentionJS second-pass regressions', () => {
    it('releases an unfinished contenteditable token when search is cancelled', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention.active')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toBe('@');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.querySelector('[data-mentionjs-token]')).toBeNull();
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('uses the actual contenteditable DOM after replacing a selection inside a mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });

        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        const text = span.firstChild;

        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(text, 1);
        range.setEnd(text, 4);
        selection.removeAllRanges();
        selection.addRange(range);

        beforeInput(editor, 'insertText', 'B');

        text.textContent = '@Bce';
        setCaret(text, 2);
        input(editor);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Bce', null);
        });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(searchFunction).not.toHaveBeenCalledWith('BAlice', null);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('allows pagination for a new query even while an older page request is unresolved', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveOldPage;
        const oldPage = new Promise((resolve) => {
            resolveOldPage = resolve;
        });

        const searchFunction = vi.fn((query, nextPageUrl) => {
            if (nextPageUrl === '/old') return oldPage;
            if (nextPageUrl === '/new') {
                return Promise.resolve({
                    items: [{ id: 5, name: 'New Three' }],
                    nextPageUrl: null,
                });
            }
            if (query === 'n') {
                return Promise.resolve({
                    items: [
                        { id: 3, name: 'New One' },
                        { id: 4, name: 'New Two' },
                    ],
                    nextPageUrl: '/new',
                });
            }
            return Promise.resolve({
                items: [
                    { id: 1, name: 'Old One' },
                    { id: 2, name: 'Old Two' },
                ],
                nextPageUrl: '/old',
            });
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/old');
        });

        textarea.value = '@n';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', null);
            expect(document.querySelector('.mention-name')?.textContent).toBe('New One');
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', '/new');
        });

        resolveOldPage({
            items: [{ id: 6, name: 'Old Three' }],
            nextPageUrl: null,
        });

        mention.destroy();
    });

    it('does not start a mention at the start of a formatted node when text before it is non-whitespace', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<em>x</em><strong>abc</strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        const strongText = editor.querySelector('strong').firstChild;
        setCaret(strongText, 0);

        const event = beforeInput(editor, 'insertText', '@');
        await Promise.resolve();

        expect(event.defaultPrevented).toBe(false);
        expect(searchFunction).not.toHaveBeenCalled();
        expect(editor.querySelector('span.mention')).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS contenteditable input events', () => {
    it('emits one input event when the trigger is inserted manually', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const externalInput = vi.fn();
        editor.addEventListener('input', externalInput);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.textContent).toBe('@');
        });

        expect(externalInput).toHaveBeenCalledTimes(1);
        mention.destroy();
    });

    it('emits input when a prevented backspace mutates mention content', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [],
        });
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const externalInput = vi.fn();
        editor.addEventListener('input', externalInput);

        setCaret(span.firstChild, span.textContent.length);
        const event = beforeInput(editor, 'deleteContentBackward');

        await vi.waitFor(() => {
            expect(span.textContent).toBe('@Alic');
        });

        expect(event.defaultPrevented).toBe(true);
        expect(externalInput).toHaveBeenCalledTimes(1);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('emits input when Enter inserts a line break after a committed mention', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const externalInput = vi.fn();
        editor.addEventListener('input', externalInput);

        setCaret(span.firstChild, span.textContent.length);
        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.querySelector('br')).not.toBeNull();
        expect(externalInput).toHaveBeenCalledTimes(1);

        mention.destroy();
    });
});


describe('MentionJS async and selection races', () => {
    it('does not let an old pagination request unlock a newer pagination request', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveOldPage;
        let resolveNewPage;
        const oldPage = new Promise((resolve) => { resolveOldPage = resolve; });
        const newPage = new Promise((resolve) => { resolveNewPage = resolve; });

        const searchFunction = vi.fn((query, nextPageUrl) => {
            if (nextPageUrl === '/old') return oldPage;
            if (nextPageUrl === '/new') return newPage;
            if (query === 'n') {
                return Promise.resolve({
                    items: [
                        { id: 3, name: 'New One' },
                        { id: 4, name: 'New Two' },
                    ],
                    nextPageUrl: '/new',
                });
            }
            return Promise.resolve({
                items: [
                    { id: 1, name: 'Old One' },
                    { id: 2, name: 'Old Two' },
                ],
                nextPageUrl: '/old',
            });
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/old');
        });

        textarea.value = '@n';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('New One');
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', '/new');
        });

        resolveOldPage({
            items: [{ id: 5, name: 'Old Three' }],
            nextPageUrl: null,
        });
        await Promise.resolve();
        await Promise.resolve();

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        document.querySelector('.mention-dropdown')
            .dispatchEvent(new Event('scroll', { bubbles: true }));

        expect(
            searchFunction.mock.calls.filter(([, url]) => url === '/new')
        ).toHaveLength(1);

        resolveNewPage({
            items: [{ id: 6, name: 'New Three' }],
            nextPageUrl: null,
        });

        mention.destroy();
    });

    it('does not treat a selection crossing a mention boundary as editing inside the mention', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const tail = document.createTextNode('tail');
        editor.appendChild(tail);

        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(span.firstChild, 2);
        range.setEnd(tail, 2);
        selection.removeAllRanges();
        selection.addRange(range);

        const event = beforeInput(editor, 'deleteContentBackward');

        expect(event.defaultPrevented).toBe(false);
        expect(span.textContent).toBe('@Alice');
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);

        mention.destroy();
    });
});


describe('MentionJS pending search cancellation', () => {
    it('Escape cancels a pending textarea search before the dropdown opens', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('Escape cancels a pending contenteditable search and releases the token', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(editor, { searchFunction });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.querySelector('[data-mentionjs-token]')).toBeNull();
        expect(editor.textContent).toBe('@');
        mention.destroy();
    });
});


describe('MentionJS search failure handling', () => {
    it('closes stale results when the current top-level search fails', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const searchFunction = vi.fn((query) => {
            if (query === 'a') return Promise.resolve([{ id: 1, name: 'Alice' }]);
            return Promise.reject(new Error('offline'));
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('Alice');
        });

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: search failed',
                expect.any(Error)
            );
            expect(document.querySelector('.mention-dropdown')).toBeNull();
        });

        mention.destroy();
    });

    it('keeps loaded results and allows retry when pagination fails', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let pageAttempts = 0;
        const searchFunction = vi.fn((query, nextPageUrl) => {
            if (nextPageUrl) {
                pageAttempts++;
                if (pageAttempts === 1) return Promise.reject(new Error('page failed'));
                return Promise.resolve({
                    items: [{ id: 3, name: 'Charlie' }],
                    nextPageUrl: null,
                });
            }

            return Promise.resolve({
                items: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
                nextPageUrl: '/next',
            });
        });

        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]')).toHaveLength(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: search failed',
                expect.any(Error)
            );
        });

        expect(document.querySelectorAll('.mention-item[data-index]')).toHaveLength(2);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]')).toHaveLength(3);
        });

        mention.destroy();
    });

    it('rejects malformed search result shapes without crashing the dropdown', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mention = new MentionJS(textarea, {
            searchFunction: async () => ({ items: 'not-an-array', nextPageUrl: 42 }),
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: searchFunction returned an invalid result',
                expect.anything()
            );
        });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS stale search failures', () => {
    it('ignores a stale rejection after a newer query has succeeded', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let rejectOld;
        const oldRequest = new Promise((_, reject) => {
            rejectOld = reject;
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const searchFunction = vi.fn((query) => {
            if (query === 'a') return oldRequest;
            return Promise.resolve([{ id: 2, name: 'New Result' }]);
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('a', null);
        });

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('New Result');
        });

        rejectOld(new Error('old request failed'));
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-name')?.textContent).toBe('New Result');
        expect(warning).not.toHaveBeenCalled();

        mention.destroy();
    });
});


describe('MentionJS selections inside mentions', () => {
    it('lets the browser delete an internal selected range and searches the resulting text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const text = span.firstChild;
        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(text, 2);
        range.setEnd(text, 5);
        selection.removeAllRanges();
        selection.addRange(range);

        const event = beforeInput(editor, 'deleteContentBackward');

        expect(event.defaultPrevented).toBe(false);

        text.textContent = '@Ae';
        setCaret(text, 2);
        input(editor);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Ae', null);
        });

        expect(span.textContent).toBe('@Ae');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('lets the browser replace a selection beginning at the trigger', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const text = span.firstChild;
        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 3);
        selection.removeAllRanges();
        selection.addRange(range);

        const event = beforeInput(editor, 'insertText', 'X');
        expect(event.defaultPrevented).toBe(false);

        text.textContent = 'Xice';
        setCaret(text, 1);
        input(editor);

        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.textContent.includes('Xice')).toBe(true);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });
});


describe('MentionJS outside-click and connected DOM lifecycle', () => {
    it('cancels a pending search on an outside click before the dropdown opens', async () => {
        const textarea = document.createElement('textarea');
        const outside = document.createElement('div');
        document.body.append(textarea, outside);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        outside.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            composed: true,
        }));

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('treats connected nodes inside a shadow root as part of the live DOM', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        const textarea = document.createElement('textarea');
        shadow.appendChild(textarea);

        const mention = new MentionJS(textarea);
        const child = document.createElement('span');
        textarea.after(child);

        expect(child.isConnected).toBe(true);
        expect(mention._inDOM(child)).toBe(true);

        mention.destroy();
    });

    it('does not interpret a composed click inside a shadow-hosted editor as an outside click', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        const textarea = document.createElement('textarea');
        shadow.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        mention._mentionStart = 0;
        mention._mentionEnd = 1;
        mention._openDropdown([{ id: 1, name: 'Alice' }]);

        textarea.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            composed: true,
        }));

        expect(document.querySelector('.mention-dropdown')).not.toBeNull();

        document.body.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            composed: true,
        }));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS contenteditable line boundaries', () => {
    it('allows a trigger at the start of a new block after non-whitespace text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<div>first</div><div>second</div>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        const secondText = editor.children[1].firstChild;
        setCaret(secondText, 0);
        const event = beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(event.defaultPrevented).toBe(true);
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });

        mention.destroy();
    });

    it('allows a trigger immediately after a br boundary', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = 'first<br>second';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        const secondText = editor.lastChild;
        setCaret(secondText, 0);
        const event = beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(event.defaultPrevented).toBe(true);
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });

        mention.destroy();
    });
});


describe('MentionJS separator and stylesheet isolation', () => {
    it('commits a textarea mention before existing whitespace without duplicating the separator', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@al hello';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@Alice hello');
        expect(textarea.selectionStart).toBe(7);
        expect(textarea.selectionEnd).toBe(7);
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 0, end: 6 },
        ]);

        mention.destroy();
    });

    it('pushes a textarea mention before existing whitespace without duplicating the separator', () => {
        const textarea = document.createElement('textarea');
        textarea.value = 'hello world';
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.focus();
        textarea.setSelectionRange(5, 5);

        mention.push({ id: 2, name: 'Bob' });

        expect(textarea.value).toBe('hello@Bob world');
        expect(textarea.selectionStart).toBe(10);
        expect(textarea.selectionEnd).toBe(10);
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 5, end: 9 },
        ]);

        mention.destroy();
    });

    it('keeps default mention styles scoped to MentionJS-owned DOM', () => {
        const foreignItem = document.createElement('div');
        foreignItem.className = 'mention-item';
        const foreignMention = document.createElement('span');
        foreignMention.className = 'mention active';
        document.body.append(foreignItem, foreignMention);

        const sheetText = readFileSync('mention.css', 'utf8');

        expect(sheetText).not.toMatch(/^\.mention-item\s*\{/m);
        expect(sheetText).not.toMatch(/^\.mention\s*\{/m);
        expect(sheetText).toContain('.mention-dropdown[data-mention-type] .mention-item');
        expect(sheetText).toContain('span.mention[data-mentionjs-token="true"]');
    });
});


describe('MentionJS composition, paste, and textarea selections', () => {
    it('does not search from a textarea while a non-collapsed selection is active', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@alice';
        textarea.setSelectionRange(2, 5);
        input(textarea);

        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(searchFunction).not.toHaveBeenCalled();
        expect(document.querySelector('.mention-dropdown')).toBeNull();

        mention.destroy();
    });

    it('closes an open textarea search when text becomes selected', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@ali';
        textarea.setSelectionRange(4, 4);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.setSelectionRange(1, 3);
        document.dispatchEvent(new Event('selectionchange'));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('moves IME composition before a mention without swallowing browser input', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 0);
        editor.dispatchEvent(new CompositionEvent('compositionstart', {
            bubbles: true,
            data: '',
        }));
        const event = beforeInput(editor, 'insertCompositionText', 'Ж');

        expect(event.defaultPrevented).toBe(false);

        const selection = window.getSelection();
        expect(selection.anchorNode).toBe(editor);
        expect(selection.anchorOffset).toBe(
            Array.from(editor.childNodes).indexOf(span)
        );
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);

        mention.destroy();
    });

    it('does not swallow a browser-managed paste at the start of a mention', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 0);
        const event = beforeInput(editor, 'insertFromPaste');

        expect(event.defaultPrevented).toBe(false);

        // Simulate the browser mutation that follows the non-cancelled beforeinput.
        span.firstChild.textContent = 'pasted@Alice';
        setCaret(span.firstChild, 6);
        input(editor);

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('keeps replacement text outside a committed mention when typed at its end', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, span.textContent.length);
        const event = beforeInput(editor, 'insertReplacementText', 'X');

        expect(event.defaultPrevented).toBe(true);
        expect(span.textContent).toBe('@Alice');
        expect(editor.textContent).toBe('@AliceX\u00A0');
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);

        mention.destroy();
    });
});


describe('MentionJS Unicode grapheme behavior', () => {
    it('supports a single emoji grapheme as the trigger', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            trigger: '💬',
            searchFunction,
        });

        textarea.focus();
        textarea.value = '💬';
        textarea.setSelectionRange('💬'.length, '💬'.length);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });

        mention.destroy();
    });

    it('places the contenteditable caret after an emoji trigger without splitting the surrogate pair', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            trigger: '💬',
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        const event = beforeInput(editor, 'insertText', '💬');

        expect(event.defaultPrevented).toBe(true);

        const span = editor.querySelector('span.mention');
        const selection = window.getSelection();
        expect(span.textContent).toBe('💬');
        expect(selection.anchorNode).toBe(span.firstChild);
        expect(selection.anchorOffset).toBe('💬'.length);

        mention.destroy();
    });

    it('backspaces a whole emoji grapheme inside an edited mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [],
        });
        mention.push({ id: 1, name: 'A😊' });

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, span.textContent.length);
        beforeInput(editor, 'deleteContentBackward');

        expect(span.textContent).toBe('@A');
        expect(span.textContent.includes('\uFFFD')).toBe(false);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('forward-deletes a whole emoji grapheme inside an edited mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [],
        });
        mention.push({ id: 1, name: 'A😊B' });

        const span = editor.querySelector('span.mention');
        const emojiStart = '@A'.length;
        setCaret(span.firstChild, emojiStart);
        beforeInput(editor, 'deleteContentForward');

        expect(span.textContent).toBe('@AB');
        expect(span.textContent.includes('\uFFFD')).toBe(false);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('removes a whole emoji trigger when backspacing over it', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            trigger: '💬',
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '💬');

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, '💬'.length);
        beforeInput(editor, 'deleteContentBackward');

        expect(editor.textContent).toBe('');
        expect(editor.querySelector('span.mention')).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS Unicode boundaries around mentions', () => {
    it('backspace before a mention removes a whole emoji from adjacent rich text', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>A😊</strong>';
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        editor.focus();
        setCaret(editor, editor.childNodes.length);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, 0);
        beforeInput(editor, 'deleteContentBackward');

        expect(editor.querySelector('strong').textContent).toBe('A');
        expect(editor.textContent.includes('\uFFFD')).toBe(false);

        mention.destroy();
    });

    it('forward delete after a mention removes a whole emoji from adjacent text', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        const spacer = span.nextSibling;
        spacer.textContent = '😊B';

        setCaret(span.firstChild, span.textContent.length);
        beforeInput(editor, 'deleteContentForward');

        expect(spacer.textContent).toBe('B');
        expect(editor.textContent.includes('\uFFFD')).toBe(false);

        mention.destroy();
    });
});


describe('MentionJS search item validation', () => {
    it('rejects result items without a valid id', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ name: 'Missing Id' }],
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: searchFunction returned an invalid result',
                expect.anything()
            );
        });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('rejects result items without a string name', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 42 }],
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: searchFunction returned an invalid result',
                expect.anything()
            );
        });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('rejects objects that omit the required items array', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mention = new MentionJS(textarea, {
            searchFunction: async () => ({ nextPageUrl: null }),
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: searchFunction returned an invalid result',
                expect.anything()
            );
        });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS editing-host and preloaded mention ownership', () => {
    it('rejects a descendant that merely inherits contenteditable from an ancestor', () => {
        const host = document.createElement('div');
        host.setAttribute('contenteditable', 'true');
        const child = document.createElement('span');
        host.appendChild(child);
        document.body.appendChild(host);

        expect(() => new MentionJS(child)).toThrow(/editing host/);
    });

    it('keeps a preloaded mention owned while it is edited', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML =
            '<span class="mention" data-mention-id="7" data-mention-name="Alice">@Alice</span>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, span.textContent.length - 1);
        const event = beforeInput(editor, 'insertText', 'x');

        expect(event.defaultPrevented).toBe(false);

        // Simulate the browser mutation after beforeinput.
        span.firstChild.textContent = '@Alicxe';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Alicxe', null);
        });

        expect(span.dataset.mentionjsToken).toBe('true');
        expect(span.classList.contains('mention')).toBe(true);
        expect(span.classList.contains('active')).toBe(true);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });
});


describe('MentionJS pending selection lifecycle', () => {
    it('cancels a pending textarea search when the caret moves outside the token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@alice tail';
        textarea.setSelectionRange(6, 6);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('alice', null);
        });

        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        document.dispatchEvent(new Event('selectionchange'));

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('supersedes a pending textarea query when the caret moves within the token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveOld;
        const old = new Promise((resolve) => { resolveOld = resolve; });
        const searchFunction = vi.fn((query) => (
            query === 'alice'
                ? old
                : Promise.resolve([{ id: 2, name: 'Al' }])
        ));
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@alice';
        textarea.setSelectionRange(6, 6);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('alice', null);
        });

        textarea.setSelectionRange(3, 3);
        document.dispatchEvent(new Event('selectionchange'));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('al', null);
            expect(document.querySelector('.mention-name')?.textContent).toBe('Al');
        });

        resolveOld([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-name')?.textContent).toBe('Al');
        mention.destroy();
    });

    it('cancels a pending contenteditable search when the caret moves out of its token', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.appendChild(document.createTextNode('tail'));
        document.body.appendChild(editor);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(editor, { searchFunction });

        editor.focus();
        setCaret(editor.firstChild, 0);
        beforeInput(editor, 'insertText', '@');

        expect(searchFunction).toHaveBeenCalledWith('', null);

        const tail = editor.lastChild;
        setCaret(tail, tail.textContent.length);
        document.dispatchEvent(new Event('selectionchange'));

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(editor.querySelector('span.mention')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS framework-controlled DOM lifecycle', () => {
    it('cleans up when an external input listener removes a just-created token', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.addEventListener('input', () => {
            editor.querySelector('span.mention')?.remove();
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await Promise.resolve();
        await Promise.resolve();

        expect(editor.querySelector('span.mention')).toBeNull();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        await vi.waitFor(() => {
            expect(mention._mentionSpan).toBeNull();
            expect(mention._h.selectionChange).toBeNull();
        });

        mention.destroy();
    });

    it('cleans up when an active token is removed while its search is pending', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        let resolveSearch;
        const mention = new MentionJS(editor, {
            searchFunction: () => new Promise((resolve) => {
                resolveSearch = resolve;
            }),
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        const span = editor.querySelector('span.mention');
        span.remove();

        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        await vi.waitFor(() => {
            expect(mention._mentionSpan).toBeNull();
            expect(mention._h.selectionChange).toBeNull();
        });

        mention.destroy();
    });
});


describe('MentionJS instance and cancelled-token cleanup', () => {
    it('rejects two active instances on the same editing host', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const first = new MentionJS(textarea);
        expect(() => new MentionJS(textarea)).toThrow(/already has an active instance/);

        first.destroy();

        const second = new MentionJS(textarea);
        expect(second).toBeInstanceOf(MentionJS);
        second.destroy();
    });

    it('unwraps a cancelled pending token to plain text without leaving wrapper markup', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toBe('@');
        expect(editor.querySelector('span')).toBeNull();
        mention.destroy();
    });

    it('does not steal selection back when a pending token is cancelled from outside', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        const outside = document.createElement('input');
        document.body.append(editor, outside);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention')).not.toBeNull();
        });

        outside.focus();
        outside.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            composed: true,
        }));

        expect(document.activeElement).toBe(outside);
        expect(editor.textContent).toBe('@');
        expect(editor.querySelector('span')).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS stale selectable results during debounce', () => {
    it('does not commit an old textarea result after the query changes', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const searchFunction = vi.fn((query) => (
            query === 'a'
                ? Promise.resolve([{ id: 1, name: 'Alice' }])
                : Promise.resolve([{ id: 2, name: 'Abel' }])
        ));
        const mention = new MentionJS(textarea, {
            debounceDelay: 50,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('Alice');
        });

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@ab');
        expect(mention.getMentions()).toEqual([]);
        expect(searchFunction).not.toHaveBeenCalledWith('ab', null);

        mention.destroy();
    });

    it('does not commit an old contenteditable result after its token changes', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn((query) => (
            query === 'a'
                ? Promise.resolve([{ id: 1, name: 'Alice' }])
                : Promise.resolve([{ id: 2, name: 'Abel' }])
        ));
        const mention = new MentionJS(editor, {
            debounceDelay: 50,
            searchFunction,
        });

        editor.innerHTML = '<span class="mention" data-mentionjs-token="true">@a</span>';
        const span = editor.firstChild;
        span.classList.add('active');
        mention._mentionSpan = span;

        editor.focus();
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('Alice');
        });

        span.firstChild.textContent = '@ab';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toContain('@ab');
        expect(mention.getMentions()).toEqual([]);
        expect(searchFunction).not.toHaveBeenCalledWith('ab', null);

        mention.destroy();
    });
});


describe('MentionJS trigger-only deletion cleanup', () => {
    it('removes a default trigger-only token completely', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, 1);
        const deletion = beforeInput(editor, 'deleteContentBackward');

        expect(deletion.defaultPrevented).toBe(true);
        expect(editor.textContent).toBe('');
        expect(editor.querySelector('span')).toBeNull();
        expect(mention._mentionSpan).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS direct text-node Unicode boundary', () => {
    it('backspace before a mention removes a whole emoji from an adjacent text node', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.appendChild(document.createTextNode('A😊'));
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        editor.focus();
        setCaret(editor.firstChild, editor.firstChild.textContent.length);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, 0);
        beforeInput(editor, 'deleteContentBackward');

        expect(editor.firstChild.nodeType).toBe(Node.TEXT_NODE);
        expect(editor.firstChild.textContent).toBe('A');
        expect(editor.textContent.includes('\uFFFD')).toBe(false);

        mention.destroy();
    });
});


describe('MentionJS composition lifecycle', () => {
    it('moves IME composition before a mention at its left boundary', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 0);
        editor.dispatchEvent(new CompositionEvent('compositionstart', {
            bubbles: true,
            data: '',
        }));

        const selection = window.getSelection();
        expect(selection.anchorNode).toBe(editor);
        expect(selection.anchorOffset).toBe(
            Array.from(editor.childNodes).indexOf(span)
        );

        mention.destroy();
    });

    it('moves IME composition into trailing text at a committed mention end', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        const trailing = span.nextSibling;

        setCaret(span.firstChild, span.textContent.length);
        editor.dispatchEvent(new CompositionEvent('compositionstart', {
            bubbles: true,
            data: '',
        }));

        const selection = window.getSelection();
        expect(selection.anchorNode).toBe(trailing);
        expect(selection.anchorOffset).toBe(0);
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);

        mention.destroy();
    });

    it('leaves composition inside an active token browser-managed', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });

        editor.innerHTML =
            '<span class="mention active" data-mentionjs-token="true">@a</span>';
        const span = editor.firstChild;
        mention._mentionSpan = span;
        editor.focus();
        setCaret(span.firstChild, span.textContent.length);

        editor.dispatchEvent(new CompositionEvent('compositionstart', {
            bubbles: true,
            data: '',
        }));
        const before = beforeInput(editor, 'insertCompositionText', '日');

        expect(before.defaultPrevented).toBe(false);

        span.firstChild.textContent = '@a日';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('a日', null);
        });
        expect(span.textContent).toBe('@a日');

        mention.destroy();
    });
});


describe('MentionJS push during active search', () => {
    it('cancels textarea search before programmatic insertion', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        mention.push({ id: 2, name: 'Bob' });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.value).toBe('@a@Bob ');
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 2, end: 6 },
        ]);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@a@Bob ');
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 2, end: 6 },
        ]);

        mention.destroy();
    });

    it('does not nest a pushed contenteditable mention inside an active token', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        const active = editor.querySelector('span.mention.active');
        setCaret(active.firstChild, active.textContent.length);
        mention.push({ id: 2, name: 'Bob' });

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(editor.querySelector('span.mention span.mention')).toBeNull();

        const mentions = editor.querySelectorAll('span.mention');
        expect(mentions).toHaveLength(1);
        expect(mentions[0].dataset.mentionId).toBe('2');
        expect(mention.getMentions()).toEqual([{ id: '2', name: 'Bob' }]);

        mention.destroy();
    });

    it('validates push() data at runtime', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);

        expect(() => mention.push(null)).toThrow(/push/);
        expect(() => mention.push({ id: 1 })).toThrow(/push/);
        expect(() => mention.push({ id: {}, name: 'Alice' })).toThrow(/push/);

        mention.destroy();
    });
});


describe('MentionJS stale async UI isolation', () => {
    it('hides old textarea results immediately when a new debounced query starts', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const searchFunction = vi.fn((query) => (
            query === 'a'
                ? Promise.resolve([{ id: 1, name: 'Alice' }])
                : Promise.resolve([{ id: 2, name: 'Abel' }])
        ));
        const mention = new MentionJS(textarea, {
            debounceDelay: 100,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        expect(document.querySelector('.mention-dropdown.active')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');

        mention.destroy();
    });

    it('does not let stale pagination hide the loading state of a newer page request', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveOldPage;
        let resolveNewPage;
        const oldPage = new Promise((resolve) => { resolveOldPage = resolve; });
        const newPage = new Promise((resolve) => { resolveNewPage = resolve; });

        const searchFunction = vi.fn((query, nextPageUrl) => {
            if (nextPageUrl === '/old') return oldPage;
            if (nextPageUrl === '/new') return newPage;
            if (query === 'n') {
                return Promise.resolve({
                    items: [
                        { id: 3, name: 'New One' },
                        { id: 4, name: 'New Two' },
                    ],
                    nextPageUrl: '/new',
                });
            }
            return Promise.resolve({
                items: [
                    { id: 1, name: 'Old One' },
                    { id: 2, name: 'Old Two' },
                ],
                nextPageUrl: '/old',
            });
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]')).toHaveLength(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/old');
        });

        textarea.value = '@n';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('New One');
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', '/new');
            expect(document.querySelector('.mention-loading')).not.toBeNull();
        });

        resolveOldPage({
            items: [{ id: 5, name: 'Old Three' }],
            nextPageUrl: null,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-loading')).not.toBeNull();

        resolveNewPage({
            items: [{ id: 6, name: 'New Three' }],
            nextPageUrl: null,
        });

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-loading')).toBeNull();
        });

        mention.destroy();
    });
});


describe('MentionJS framework-controlled textarea commit', () => {
    it('reconciles when an earlier external input listener replaces the committed value', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        textarea.addEventListener('input', (event) => {
            if (!event.isTrusted && textarea.value.startsWith('@Alice')) {
                textarea.value = 'controlled';
                textarea.setSelectionRange(
                    textarea.value.length,
                    textarea.value.length
                );
            }
        });

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('controlled');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('reconciles when a later external input listener replaces the committed value', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.addEventListener('input', (event) => {
            if (!event.isTrusted && textarea.value.startsWith('@Alice')) {
                textarea.value = 'controlled';
                textarea.setSelectionRange(
                    textarea.value.length,
                    textarea.value.length
                );
            }
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('controlled');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });
});


describe('MentionJS detached host lifecycle', () => {
    it('does not open an orphan textarea dropdown after the host is removed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveSearch;
        const mention = new MentionJS(textarea, {
            searchFunction: () => new Promise((resolve) => {
                resolveSearch = resolve;
            }),
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        expect(typeof resolveSearch).toBe('function');

        textarea.remove();
        resolveSearch([{ id: 1, name: 'Alice' }]);

        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');

        mention.destroy();
    });

    it('does not open an orphan contenteditable dropdown after the host is removed', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        let resolveSearch;
        const mention = new MentionJS(editor, {
            searchFunction: () => new Promise((resolve) => {
                resolveSearch = resolve;
            }),
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        expect(typeof resolveSearch).toBe('function');

        editor.remove();
        resolveSearch([{ id: 1, name: 'Alice' }]);

        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS teardown after textarea deletion keys', () => {
    it('does not mutate restored accessibility state after destroy()', async () => {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('role', 'textbox');
        textarea.setAttribute('aria-expanded', 'legacy');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
        }));

        mention.destroy();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(textarea.getAttribute('role')).toBe('textbox');
        expect(textarea.getAttribute('aria-expanded')).toBe('legacy');
        expect(document.querySelector('.mention-dropdown')).toBeNull();
    });
});


describe('MentionJS actual contenteditable editing hosts', () => {
    it('rejects a nested editable element whose parent is also editable', () => {
        const outer = document.createElement('div');
        outer.setAttribute('contenteditable', 'true');
        const inner = document.createElement('div');
        inner.setAttribute('contenteditable', 'true');
        outer.appendChild(inner);
        document.body.appendChild(outer);

        expect(() => new MentionJS(inner)).toThrow(/editing host/);
    });

    it('accepts an editable island inside a non-editable boundary', () => {
        const outer = document.createElement('div');
        outer.setAttribute('contenteditable', 'true');
        const boundary = document.createElement('div');
        boundary.setAttribute('contenteditable', 'false');
        const inner = document.createElement('div');
        inner.setAttribute('contenteditable', 'true');
        boundary.appendChild(inner);
        outer.appendChild(boundary);
        document.body.appendChild(outer);

        const mention = new MentionJS(inner);
        expect(mention).toBeInstanceOf(MentionJS);
        mention.destroy();
    });
});


describe('MentionJS Unicode avatar placeholders', () => {
    it('renders the first full grapheme for names beginning with emoji', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: '😊 Alice' }],
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(
                document.querySelector('.mention-avatar-placeholder')?.textContent
            ).toBe('😊');
        });

        mention.destroy();
    });
});


describe('MentionJS contenteditable attribute semantics', () => {
    it('treats contenteditable values case-insensitively', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'TRUE');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        expect(mention).toBeInstanceOf(MentionJS);
        mention.destroy();
    });

    it('respects an inherited editable ancestor when determining the editing host', () => {
        const outer = document.createElement('div');
        outer.setAttribute('contenteditable', 'true');
        const middle = document.createElement('div');
        const inner = document.createElement('div');
        inner.setAttribute('contenteditable', 'true');
        middle.appendChild(inner);
        outer.appendChild(middle);
        document.body.appendChild(outer);

        expect(() => new MentionJS(inner)).toThrow(/editing host/);
    });

    it('respects a contenteditable=false boundary before a nested editable island', () => {
        const outer = document.createElement('div');
        outer.setAttribute('contenteditable', 'true');
        const boundary = document.createElement('div');
        boundary.setAttribute('contenteditable', 'false');
        const middle = document.createElement('div');
        const inner = document.createElement('div');
        inner.setAttribute('contenteditable', 'true');
        middle.appendChild(inner);
        boundary.appendChild(middle);
        outer.appendChild(boundary);
        document.body.appendChild(outer);

        const mention = new MentionJS(inner);
        expect(mention).toBeInstanceOf(MentionJS);
        mention.destroy();
    });
});


describe('MentionJS non-cancelable beforeinput safety', () => {
    function nonCancelableBeforeInput(element, inputType, data = null) {
        const event = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: false,
            inputType,
            data,
        });
        element.dispatchEvent(event);
        return event;
    }

    it('does not manually duplicate a non-cancelable trigger insertion', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        editor.focus();
        setCaret(editor, 0);
        const event = nonCancelableBeforeInput(editor, 'insertText', '@');

        expect(event.defaultPrevented).toBe(false);
        expect(editor.textContent).toBe('');
        expect(editor.querySelector('span.mention')).toBeNull();

        editor.appendChild(document.createTextNode('@'));
        setCaret(editor.firstChild, 1);
        input(editor);

        expect(editor.textContent).toBe('@');
        expect(editor.querySelectorAll('span.mention.active')).toHaveLength(1);

        mention.destroy();
    });

    it('does not manually delete content for a non-cancelable backward edit', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, span.textContent.length);
        const event = nonCancelableBeforeInput(
            editor,
            'deleteContentBackward'
        );

        expect(event.defaultPrevented).toBe(false);
        expect(span.textContent).toBe('@Alice');
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);

        span.firstChild.textContent = '@Alic';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        expect(span.textContent).toBe('@Alic');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('does not manually insert a line break for non-cancelable beforeinput', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 2);
        const event = nonCancelableBeforeInput(editor, 'insertParagraph');

        expect(event.defaultPrevented).toBe(false);
        expect(editor.querySelector('br')).toBeNull();

        mention.destroy();
    });
});


describe('MentionJS controlled native textarea input', () => {
    it('drops stale mention metadata when an earlier listener replaces the whole value', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        textarea.addEventListener('input', () => {
            if (textarea.value.startsWith('Q')) {
                textarea.value = 'controlled';
                textarea.setSelectionRange(
                    textarea.value.length,
                    textarea.value.length
                );
            }
        });

        const mention = new MentionJS(textarea);
        mention.push({ id: 1, name: 'Alice' });
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 0, end: 6 },
        ]);

        textarea.focus();
        textarea.setSelectionRange(0, 0);
        beforeInput(textarea, 'insertText', 'Q');

        // Simulate the browser's native insertion before the input event.
        textarea.value = 'Q' + textarea.value;
        textarea.setSelectionRange(1, 1);
        input(textarea);

        expect(textarea.value).toBe('controlled');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('keeps metadata when a controlled listener changes unrelated text but preserves the range', () => {
        const textarea = document.createElement('textarea');
        textarea.value = 'prefix ';
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        mention.push({ id: 1, name: 'Alice' });

        const expected = mention.getMentions()[0];
        expect(textarea.value.slice(expected.start, expected.end)).toBe('@Alice');

        textarea.addEventListener('input', () => {
            textarea.value = textarea.value.replace('prefix', 'PREFIX');
        });

        textarea.setSelectionRange(0, 6);
        beforeInput(textarea, 'insertReplacementText', 'PREFIX');
        textarea.value = textarea.value.replace('prefix', 'PREFIX');
        textarea.setSelectionRange(6, 6);
        input(textarea);

        const mentions = mention.getMentions();
        expect(mentions).toHaveLength(1);
        expect(textarea.value.slice(mentions[0].start, mentions[0].end))
            .toBe('@Alice');

        mention.destroy();
    });
});


describe('MentionJS runtime option validation', () => {
    it('rejects non-function callback options at construction time', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        for (const optionName of [
            'searchFunction',
            'onMentionSelect',
            'renderItem',
            'renderNoResults',
            'renderLoading',
        ]) {
            expect(() => new MentionJS(textarea, {
                [optionName]: 'not-a-function',
            })).toThrow(new RegExp(optionName));
        }
    });

    it('rejects non-string display options', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(() => new MentionJS(textarea, {
            noResultsText: 42,
        })).toThrow(/noResultsText/);

        expect(() => new MentionJS(textarea, {
            dropdownClass: {},
        })).toThrow(/dropdownClass/);
    });

    it('accepts null callback options and valid custom renderers', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: null,
            onMentionSelect: null,
            renderItem: () => document.createElement('div'),
            renderNoResults: () => document.createElement('div'),
            renderLoading: () => document.createElement('div'),
            noResultsText: 'Nothing',
            dropdownClass: 'custom',
        });

        expect(mention).toBeInstanceOf(MentionJS);
        mention.destroy();
    });
});


describe('MentionJS Shadow DOM textarea focus semantics', () => {
    it('push() inserts at the current caret inside a shadow-root textarea', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        const textarea = document.createElement('textarea');
        textarea.value = 'hello world';
        shadow.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.focus();
        textarea.setSelectionRange(6, 6);

        mention.push({ id: 1, name: 'Alice' });

        expect(textarea.value).toBe('hello @Alice world');
        expect(textarea.selectionStart).toBe(13);
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 6, end: 12 },
        ]);

        mention.destroy();
    });

    it('reopens search after a caret move within a shadow-root token', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        const textarea = document.createElement('textarea');
        shadow.appendChild(textarea);

        const searchFunction = vi.fn().mockResolvedValue([
            { id: 1, name: 'Alice' },
        ]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@abc';
        textarea.setSelectionRange(4, 4);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('abc', null);
        });

        textarea.setSelectionRange(2, 2);
        document.dispatchEvent(new Event('selectionchange'));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('a', null);
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });

        mention.destroy();
    });
});


describe('MentionJS textarea mention ordering', () => {
    it('returns programmatically inserted mentions in document order', () => {
        const textarea = document.createElement('textarea');
        textarea.value = 'middle';
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);

        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        mention.push({ id: 2, name: 'Right' });

        textarea.setSelectionRange(0, 0);
        mention.push({ id: 1, name: 'Left' });

        const mentions = mention.getMentions();
        expect(mentions.map((item) => item.id)).toEqual([1, 2]);
        expect(mentions[0].start).toBeLessThan(mentions[1].start);
        expect(textarea.value.slice(mentions[0].start, mentions[0].end))
            .toBe('@Left');
        expect(textarea.value.slice(mentions[1].start, mentions[1].end))
            .toBe('@Right');

        mention.destroy();
    });

    it('keeps document ordering after edits before multiple mentions', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);

        mention.push({ id: 1, name: 'Alice' });
        mention.push({ id: 2, name: 'Bob' });

        textarea.focus();
        textarea.setSelectionRange(0, 0);
        beforeInput(textarea, 'insertText', 'X');
        textarea.value = 'X' + textarea.value;
        textarea.setSelectionRange(1, 1);
        input(textarea);

        const mentions = mention.getMentions();
        expect(mentions.map((item) => item.id)).toEqual([1, 2]);
        expect(mentions[0].start).toBeLessThan(mentions[1].start);

        mention.destroy();
    });
});


describe('MentionJS controlled contenteditable commit', () => {
    it('drops stale metadata when an external listener rewrites committed text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.addEventListener('input', () => {
            const span = editor.querySelector(
                'span[data-mention-id][data-mention-name]'
            );
            if (span) span.textContent = '@Controlled';
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toContain('@Controlled');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.querySelector('[data-mention-id]')).toBeNull();
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('preserves externally controlled metadata when visible text still matches', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.addEventListener('input', () => {
            const span = editor.querySelector(
                'span[data-mention-id][data-mention-name]'
            );
            if (span) {
                span.dataset.mentionId = '9';
                span.dataset.mentionName = 'Alice';
                span.textContent = '@Alice';
            }
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(mention.getMentions()).toEqual([{ id: '9', name: 'Alice' }]);

        mention.destroy();
    });

    it('filters stale preloaded metadata from getMentions()', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML =
            '<span class="mention" data-mention-id="1" data-mention-name="Alice">@Other</span>';
        document.body.appendChild(editor);

        const mention = new MentionJS(editor);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });
});


describe('MentionJS onMentionSelect state reconciliation', () => {
    it('reconciles textarea metadata after onMentionSelect rewrites the value', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
            onMentionSelect: () => {
                textarea.value = 'callback-controlled';
            },
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('callback-controlled');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('reconciles contenteditable metadata after onMentionSelect rewrites committed text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
            onMentionSelect: () => {
                const span = editor.querySelector('[data-mention-id]');
                if (span) span.textContent = '@Changed';
            },
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toContain('@Changed');
        expect(editor.querySelector('[data-mention-id]')).toBeNull();
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('reconciles state even when onMentionSelect throws', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const error = new Error('callback failed');
        const mention = new MentionJS(textarea, {
            onMentionSelect: () => {
                textarea.value = 'changed-before-throw';
                throw error;
            },
        });

        mention.push({ id: 1, name: 'Alice' });
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 0, end: 6 },
        ]);

        expect(() => mention._fireSelect({ id: 1, name: 'Alice' }))
            .toThrow(error);

        expect(textarea.value).toBe('changed-before-throw');
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });;
});


describe('MentionJS destroyed-instance lifecycle', () => {
    it('makes destroy() idempotent', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        expect(() => mention.destroy()).not.toThrow();
        expect(() => mention.destroy()).not.toThrow();
    });

    it('rejects public mutations and reads after destroy()', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        mention.destroy();

        expect(() => mention.getMentions()).toThrow(/destroyed/);
        expect(() => mention.push({ id: 1, name: 'Alice' })).toThrow(/destroyed/);
        expect(() => mention.clear()).toThrow(/destroyed/);
    });

    it('prevents a destroyed instance from mutating a host owned by a new instance', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const oldInstance = new MentionJS(textarea);
        oldInstance.destroy();

        const current = new MentionJS(textarea);
        current.push({ id: 2, name: 'Bob' });
        const valueAfterCurrent = textarea.value;

        expect(() => oldInstance.push({ id: 1, name: 'Alice' })).toThrow(/destroyed/);
        expect(textarea.value).toBe(valueAfterCurrent);
        expect(current.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 0, end: 4 },
        ]);

        current.destroy();
    });
});


describe('MentionJS abortable search sessions', () => {
    it('passes an AbortSignal to searchFunction', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let receivedSignal = null;
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async (query, nextPageUrl, context) => {
                receivedSignal = context.signal;
                return [];
            },
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
        });

        mention.destroy();
    });

    it('aborts a pending request when a newer query starts', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let firstSignal = null;
        const searchFunction = vi.fn((query, nextPageUrl, context) => {
            if (query === 'a') {
                firstSignal = context.signal;
                return new Promise(() => {});
            }
            return Promise.resolve([{ id: 2, name: 'Abel' }]);
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(firstSignal).toBeInstanceOf(AbortSignal);
        });

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(firstSignal.aborted).toBe(true);
            expect(document.querySelector('.mention-name')?.textContent)
                .toBe('Abel');
        });

        mention.destroy();
    });

    it('settles an internal search immediately on destroy even if user promise never resolves', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let signal = null;
        const mention = new MentionJS(textarea, {
            searchFunction: (query, nextPageUrl, context) => {
                signal = context.signal;
                return new Promise(() => {});
            },
        });

        const pending = mention._search('');
        await vi.waitFor(() => {
            expect(signal).toBeInstanceOf(AbortSignal);
        });

        mention.destroy();

        const result = await Promise.race([
            pending,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('search did not cancel')),
                50
            )),
        ]);

        expect(result).toBeNull();
        expect(signal.aborted).toBe(true);
    });

    it('keeps legacy one- and two-argument search functions compatible', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const oneArg = vi.fn(async (query) => [{ id: 1, name: query || 'A' }]);
        const first = new MentionJS(textarea, {
            searchFunction: oneArg,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(oneArg).toHaveBeenCalled();
        });
        first.destroy();

        const second = new MentionJS(textarea, {
            searchFunction: async (query, nextPageUrl) => ({
                items: [{ id: 2, name: 'Bob' }],
                nextPageUrl: null,
            }),
        });

        textarea.value = '@';
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent)
                .toBe('Bob');
        });

        second.destroy();
    });
});


describe('MentionJS abort hook ownership', () => {
    it('keeps the newest cancellation hook after an older request finalizes', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        const signals = [];
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: (query, nextPageUrl, context) => {
                signals.push(context.signal);
                return new Promise(() => {});
            },
        });

        const first = mention._search('');
        await vi.waitFor(() => {
            expect(signals).toHaveLength(1);
        });

        const second = mention._search('next');
        await vi.waitFor(() => {
            expect(signals).toHaveLength(2);
            expect(signals[0].aborted).toBe(true);
        });

        expect(await first).toBeNull();

        mention.destroy();

        const secondResult = await Promise.race([
            second,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('newest search did not cancel')),
                50
            )),
        ]);

        expect(secondResult).toBeNull();
        expect(signals[1].aborted).toBe(true);
    });
});


describe('MentionJS legacy search invocation shape', () => {
    it('keeps legacy callbacks at exactly two runtime arguments', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let observedArgs = null;
        const legacy = function (query, nextPageUrl) {
            observedArgs = Array.from(arguments);
            return Promise.resolve([]);
        };

        const mention = new MentionJS(textarea, {
            searchFunction: legacy,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(observedArgs).not.toBeNull();
        });

        expect(observedArgs).toEqual(['', null]);

        mention.destroy();
    });

    it('passes context only to callbacks explicitly declaring a third parameter', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let observedArgs = null;
        const abortAware = function (query, nextPageUrl, context) {
            observedArgs = Array.from(arguments);
            return Promise.resolve([]);
        };

        const mention = new MentionJS(textarea, {
            searchFunction: abortAware,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(observedArgs).not.toBeNull();
        });

        expect(observedArgs).toHaveLength(3);
        expect(observedArgs[0]).toBe('');
        expect(observedArgs[1]).toBeNull();
        expect(observedArgs[2].signal).toBeInstanceOf(AbortSignal);

        mention.destroy();
    });
});

describe('MentionJS detached active-token editing regressions', () => {
    function activeToken(before = '') {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = before +
            '<span class="mention active" data-mentionjs-token="true">@a</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');
        mention._mentionSpan = span;
        editor.focus();
        setCaret(span.firstChild, 0);
        return { editor, mention, span };
    }

    it('inserts text before an unfinished token without using its detached span', () => {
        const { editor, mention } = activeToken();
        const change = beforeInput(editor, 'insertText', 'X');
        expect(change.defaultPrevented).toBe(true);
        expect(editor.textContent).toBe('X@a');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(window.getSelection().anchorNode.textContent).toBe('X');
        expect(window.getSelection().anchorOffset).toBe(1);
        mention.destroy();
    });

    it('backspaces adjacent formatted text before an unfinished token', () => {
        const { editor, mention } = activeToken('<strong>abc</strong>');
        beforeInput(editor, 'deleteContentBackward');
        expect(editor.querySelector('strong')?.textContent).toBe('ab');
        expect(editor.textContent).toBe('ab@a');
        expect(editor.querySelector('span.mention')).toBeNull();
        mention.destroy();
    });

    it('forward-deletes the trigger of an unfinished token', () => {
        const { editor, mention } = activeToken();
        beforeInput(editor, 'deleteContentForward');
        expect(editor.textContent).toBe('a');
        expect(editor.querySelector('span.mention')).toBeNull();
        mention.destroy();
    });

    it('moves IME composition before an unfinished token without a detached-range error', () => {
        const { editor, mention } = activeToken();
        editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        expect(editor.textContent).toBe('@a');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(window.getSelection().anchorNode).toBe(editor);
        expect(window.getSelection().anchorOffset).toBe(0);
        mention.destroy();
    });

    it('inserts a line break after releasing an unfinished token', () => {
        const { editor, mention, span } = activeToken();
        setCaret(span.firstChild, span.textContent.length);
        const change = beforeInput(editor, 'insertParagraph');
        expect(change.defaultPrevented).toBe(true);
        expect(editor.textContent).toBe('@a');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.querySelector('br')).not.toBeNull();
        mention.destroy();
    });
});

describe('MentionJS committed identity and atomic insertion regressions', () => {
    it('keeps committed contenteditable identity after an unchanged input event', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, 3);

        input(editor);

        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        expect(span.dataset.mentionId).toBe('1');
        expect(editor.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('drops textarea metadata after an external value assignment without input', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        mention.push({ id: 1, name: 'Alice' });
        textarea.value = '';

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('reconciles external textarea value before a later push', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        mention.push({ id: 1, name: 'Alice' });
        textarea.value = '';
        mention.push({ id: 2, name: 'Bob' });

        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 0, end: 4 },
        ]);
        mention.destroy();
    });

    it('inserts a new contenteditable mention after an existing mention atomically', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });

        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, 3);
        mention.push({ id: 2, name: 'Bob' });

        expect(editor.querySelector('span.mention span.mention')).toBeNull();
        expect(mention.getMentions()).toEqual([
            { id: '1', name: 'Alice' },
            { id: '2', name: 'Bob' },
        ]);
        expect(editor.textContent).toBe('@Alice\u00A0@Bob\u00A0');
        mention.destroy();
    });

    it('replaces an entire mention when the programmatic selection splits it', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        const range = document.createRange();
        range.setStart(span.firstChild, 2);
        range.setEnd(span.firstChild, 5);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        mention.push({ id: 2, name: 'Bob' });

        expect(editor.querySelector('span.mention span.mention')).toBeNull();
        expect(mention.getMentions()).toEqual([{ id: '2', name: 'Bob' }]);
        expect(editor.textContent).toBe('@Bob\u00A0');
        mention.destroy();
    });

    it('does not suppress later native input if a listener stops a synthetic commit event', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let interceptCommit = false;
        textarea.addEventListener('input', (event) => {
            if (interceptCommit) {
                interceptCommit = false;
                event.stopImmediatePropagation();
            }
        });
        const searchFunction = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
        const mention = new MentionJS(textarea, { debounceDelay: 0, searchFunction });
        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown')).not.toBeNull());

        interceptCommit = true;
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        textarea.value += '@';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });
        mention.destroy();
    });

    it('ends a contenteditable token when whitespace is typed into it', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction, debounceDelay: 0 });
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@a</span>';
        const span = editor.firstChild;
        mention._mentionSpan = span;
        editor.focus();
        span.firstChild.textContent = '@a ';
        setCaret(span.firstChild, 3);
        input(editor);

        expect(editor.querySelector('.mention')).toBeNull();
        expect(editor.textContent).toBe('@a ');
        expect(searchFunction).not.toHaveBeenCalled();
        mention.destroy();
    });
});

describe('MentionJS dismissed search and native trigger recovery', () => {
    it('does not restart a dismissed textarea token until the trigger is deleted', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, { searchFunction, debounceDelay: 0 });
        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown')).not.toBeNull());

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        expect(document.querySelector('.mention-dropdown')).toBeNull();

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(searchFunction).toHaveBeenCalledTimes(1);

        textarea.value = '';
        textarea.setSelectionRange(0, 0);
        input(textarea);

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => expect(searchFunction).toHaveBeenCalledTimes(2));
        mention.destroy();
    });

    it('lets Tab move focus when no matching results exist', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, { searchFunction: async () => [] });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown')).not.toBeNull());

        const event = new KeyboardEvent('keydown', {
            key: 'Tab', bubbles: true, cancelable: true,
        });
        textarea.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('adopts a browser-inserted trigger after non-cancelable beforeinput', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });
        editor.focus();
        setCaret(editor, 0);
        const event = new InputEvent('beforeinput', {
            bubbles: true, cancelable: false, inputType: 'insertText', data: '@',
        });
        editor.dispatchEvent(event);

        editor.textContent = '@';
        setCaret(editor.firstChild, 1);
        input(editor);
        await vi.waitFor(() => expect(editor.querySelector('span.mention.active')).not.toBeNull());
        expect(editor.textContent).toBe('@');
        expect(searchFunction).toHaveBeenCalledWith('', null);
        mention.destroy();
    });

    it('does not adopt a native trigger embedded in ordinary text', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.textContent = 'hello';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        editor.focus();
        setCaret(editor.firstChild, 5);
        editor.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: false, inputType: 'insertText', data: '@',
        }));
        editor.firstChild.textContent = 'hello@';
        setCaret(editor.firstChild, 6);
        input(editor);

        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.textContent).toBe('hello@');
        mention.destroy();
    });
});

describe('MentionJS explicit asynchronous and programmatic contracts', () => {
    it('passes AbortSignal to default-argument callbacks with opt-in search context', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let observed = null;
        const callback = (query, page, context = {}) => {
            observed = { query, page, signal: context.signal };
            return Promise.resolve([]);
        };
        expect(callback.length).toBe(2);
        const mention = new MentionJS(textarea, {
            searchFunction: callback, provideSearchContext: true,
        });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => expect(observed?.signal).toBeInstanceOf(AbortSignal));
        expect(observed.query).toBe('');
        expect(observed.page).toBeNull();
        mention.destroy();
    });

    it('validates new boolean options', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        expect(() => new MentionJS(textarea, { provideSearchContext: 'yes' }))
            .toThrow(/provideSearchContext/);
        expect(() => new MentionJS(textarea, { emitInputOnProgrammaticChange: null }))
            .toThrow(/emitInputOnProgrammaticChange/);
    });

    it('preserves the default no-event contract for programmatic changes', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const onInput = vi.fn();
        textarea.addEventListener('input', onInput);
        const mention = new MentionJS(textarea);

        mention.push({ id: 1, name: 'Alice' });
        mention.clear();

        expect(onInput).not.toHaveBeenCalled();
        mention.destroy();
    });

    it('dispatches and reconciles opt-in textarea input events on push and clear', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const inputs = [];
        textarea.addEventListener('input', () => inputs.push(textarea.value));
        const mention = new MentionJS(textarea, { emitInputOnProgrammaticChange: true });

        mention.push({ id: 1, name: 'Alice' });
        mention.clear();

        expect(inputs).toEqual(['@Alice ', '']);
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('dispatches opt-in contenteditable input events with proper input types', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const types = [];
        editor.addEventListener('input', (event) => types.push(event.inputType));
        const mention = new MentionJS(editor, { emitInputOnProgrammaticChange: true });

        mention.push({ id: 1, name: 'Alice' });
        mention.clear();

        expect(types).toEqual(['insertReplacementText', 'deleteContent']);
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });
});

describe('MentionJS Unicode fallback and numeric identifier boundaries', () => {
    it('supports combining marks and compound emoji without Intl.Segmenter', () => {
        const source = readFileSync('mention.js', 'utf8');
        const sandbox = {
            module: { exports: {} }, exports: {},
            Intl: { Segmenter: undefined },
            window, document, HTMLElement, Element, Node, Event, InputEvent,
            AbortController, requestAnimationFrame, setTimeout, clearTimeout, console,
        };
        runInNewContext(source, sandbox, { filename: 'mention-fallback.js' });
        const FallbackMention = sandbox.module.exports;
        for (const trigger of ['e\u0301', '🇩🇰', '👩🏽‍💻']) {
            const textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            const mention = new FallbackMention(textarea, { trigger });
            mention.destroy();
            textarea.remove();
        }
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new FallbackMention(editor);
        mention.push({ id: 1, name: 'A👩🏽‍💻' });
        const span = editor.querySelector('span.mention');
        setCaret(span.firstChild, span.textContent.length);
        beforeInput(editor, 'deleteContentBackward');
        expect(span.textContent).toBe('@A');
        mention.destroy();
    });

    it('rejects non-finite public mention identifiers', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        expect(() => mention.push({ id: NaN, name: 'Alice' })).toThrow(/push/);
        expect(() => mention.push({ id: Infinity, name: 'Alice' })).toThrow(/push/);
        mention.destroy();
    });
});

describe('MentionJS ambiguous textarea edits and identity protection', () => {
    function twoIdenticalMentions() {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        textarea.focus();
        mention.push({ id: 'original-first', name: 'Alice' });
        mention.push({ id: 'original-second', name: 'Alice' });
        expect(textarea.value).toBe('@Alice @Alice ');
        return { textarea, mention };
    }

    it('does not retain an arbitrary ID when one identical token is removed without beforeinput', () => {
        const { textarea, mention } = twoIdenticalMentions();
        textarea.value = '@Alice ';

        // The remaining visible token could have come from either source;
        // returning original-first would incorrectly identify original-second.
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('does not attach an existing mention ID to an inserted identical token', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        mention.push({ id: 'old', name: 'Alice' });
        textarea.value = '@Alice @Alice ';

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('keeps unambiguous identity when text is inserted outside its range', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        mention.push({ id: 1, name: 'Alice' });
        textarea.value = 'Hello ' + textarea.value;

        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 6, end: 12 },
        ]);
        mention.destroy();
    });

    it('preserves exactly the surviving ID with a matching native beforeinput range', () => {
        const { textarea, mention } = twoIdenticalMentions();
        textarea.setSelectionRange(0, 7);
        beforeInput(textarea, 'deleteContentBackward');
        textarea.value = '@Alice ';
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(mention.getMentions()).toEqual([
            { id: 'original-second', name: 'Alice', start: 0, end: 6 },
        ]);
        mention.destroy();
    });

    it('does not trust an invalidated beforeinput range when a framework rewrites text', () => {
        const { textarea, mention } = twoIdenticalMentions();
        textarea.setSelectionRange(14, 14);
        beforeInput(textarea, 'insertText', 'X');
        // A controlled input handler removes one ambiguous token instead.
        textarea.value = '@Alice ';
        textarea.setSelectionRange(7, 7);
        input(textarea);

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });
});

describe('MentionJS pending native textarea edits', () => {
    it('getMentions does not consume a beforeinput range before the native input', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        textarea.focus();
        mention.push({ id: 'first', name: 'Alice' });
        mention.push({ id: 'second', name: 'Alice' });

        textarea.setSelectionRange(0, 7);
        beforeInput(textarea, 'deleteContentBackward');

        expect(mention.getMentions()).toEqual([
            { id: 'first', name: 'Alice', start: 0, end: 6 },
            { id: 'second', name: 'Alice', start: 7, end: 13 },
        ]);

        textarea.value = '@Alice ';
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(mention.getMentions()).toEqual([
            { id: 'second', name: 'Alice', start: 0, end: 6 },
        ]);
        mention.destroy();
    });
});

describe('MentionJS cross-token input focus synchronization', () => {
    it('closes stale suggestions if input moves into an unchanged committed mention', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@a</span>' +
            '<span class="mention" data-mention-id="1" data-mention-name="Alice">@Alice</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const active = editor.firstChild;
        const committed = editor.lastChild;
        mention._mentionSpan = active;
        editor.focus();
        setCaret(active.firstChild, 2);
        mention._openDropdown([{ id: 9, name: 'Other' }]);
        expect(document.querySelector('.mention-dropdown')).not.toBeNull();

        setCaret(committed.firstChild, 3);
        // Selectionchange may be delivered after input when framework listeners run.
        input(editor);

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        expect(editor.querySelector('span.mention.active')).toBeNull();
        mention.destroy();
    });
});

describe('MentionJS animation-frame lifecycle isolation', () => {
    it('does not reposition a remounted dropdown using an old scheduled frame', () => {
        const scheduled = [];
        const nativeRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (fn) => {
            scheduled.push(fn);
            return scheduled.length;
        };
        try {
            const textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            const mention = new MentionJS(textarea);
            const ui = mention._ui;
            ui.mount('textarea');
            ui.position({ top: 100, left: 120, cursorY: 100 });
            ui.mount('textarea');

            const newest = ui.el;
            expect(newest.style.top).toBe('');
            scheduled.shift()();
            expect(newest.style.top).toBe('');
            mention.destroy();
        } finally {
            globalThis.requestAnimationFrame = nativeRaf;
        }
    });

    it('ignores stale textarea geometry frames after the active token changes', () => {
        const scheduled = [];
        const nativeRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (fn) => {
            scheduled.push(fn);
            return scheduled.length;
        };
        try {
            const textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            const mention = new MentionJS(textarea);
            mention._ui.mount('textarea');
            mention._mentionStart = 0;
            mention._positionNearCursorInTextarea();
            mention._mentionStart = 6;
            scheduled.shift()();

            expect(mention._ui.el.style.top).toBe('');
            mention.destroy();
        } finally {
            globalThis.requestAnimationFrame = nativeRaf;
        }
    });
});

describe('MentionJS controlled input alignment invariants', () => {
    it('rejects overlapping prefix/suffix assumptions for inconsistent beforeinput', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        textarea.focus();
        mention.push({ id: 'left', name: 'Alice' });
        mention.push({ id: 'right', name: 'Alice' });

        textarea.setSelectionRange(7, 7);
        beforeInput(textarea, 'insertText', 'X');
        textarea.value = '@Alice ';
        textarea.setSelectionRange(7, 7);
        input(textarea);

        // A collapsed insertion cannot remove half of the old value. Two
        // IDs must never be projected onto the same surviving text span.
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('retains distinct identities after a prefix insertion on many mentions', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        textarea.focus();
        for (let i = 0; i < 180; i++) {
            mention.push({ id: i, name: 'Alice' });
        }
        textarea.value = '# ' + textarea.value;

        const mentions = mention.getMentions();
        expect(mentions).toHaveLength(180);
        expect(mentions[0]).toEqual({ id: 0, name: 'Alice', start: 2, end: 8 });
        expect(mentions[179].id).toBe(179);
        expect(mentions.every((item, index) =>
            index === 0 || item.start >= mentions[index - 1].end
        )).toBe(true);
        mention.destroy();
    });
});

describe('MentionJS element-boundary caret offsets', () => {
    it('deletes the last character when caret is at the element-child end boundary', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, { searchFunction: async () => [] });
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');

        setCaret(span, 1); // Child index 1 = after the entire text node.
        const event = beforeInput(editor, 'deleteContentBackward');

        expect(event.defaultPrevented).toBe(true);
        expect(span.textContent).toBe('@Alic');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('moves IME out of a committed mention at the element-child end boundary', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        const trailing = span.nextSibling;

        setCaret(span, 1);
        editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        expect(window.getSelection().anchorNode).toBe(trailing);
        expect(window.getSelection().anchorOffset).toBe(0);
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        mention.destroy();
    });

    it('preserves the zero-offset caret when unwrapping an unfinished span', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@ab</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');
        mention._mentionSpan = span;
        editor.focus();
        setCaret(span, 0);
        mention._closeDropdown();

        expect(editor.textContent).toBe('@ab');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(window.getSelection().anchorNode).toBe(editor.firstChild);
        expect(window.getSelection().anchorOffset).toBe(0);
        mention.destroy();
    });
});

describe('MentionJS textarea replacement across the caret', () => {
    it('replaces the whole uncommitted token when accepting from its middle', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const query = vi.fn().mockResolvedValue([{ id: 3, name: 'Bob' }]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0, searchFunction: query,
        });

        textarea.focus();
        textarea.value = 'hello @alice rest';
        textarea.setSelectionRange(9, 9); // after @al
        input(textarea);
        await vi.waitFor(() => {
            expect(query).toHaveBeenCalledWith('al', null);
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));

        expect(textarea.value).toBe('hello @Bob rest');
        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        expect(mention.getMentions()).toEqual([
            { id: 3, name: 'Bob', start: 6, end: 10 },
        ]);
        expect(textarea.selectionStart).toBe(11);
        mention.destroy();
    });

    it('does not leave a suffix when replacing a token before punctuation', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 5, name: 'Jo' }],
        });
        textarea.focus();
        textarea.value = '@alex, rest';
        textarea.setSelectionRange(3, 3); // @al|ex, in the token
        input(textarea);
        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(textarea.value).toBe('@Jo, rest');
        expect(mention.getMentions()).toEqual([
            { id: 5, name: 'Jo', start: 0, end: 3 },
        ]);
        expect(textarea.selectionStart).toBe(3);
        mention.destroy();
    });
});

describe('MentionJS punctuation after committed or pushed mentions', () => {
    it('does not insert a space before punctuation when pushing at the caret', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        textarea.value = 'hello, world';
        textarea.focus();
        textarea.setSelectionRange(5, 5);
        mention.push({ id: 1, name: 'Alice' });

        expect(textarea.value).toBe('hello@Alice, world');
        expect(textarea.selectionStart).toBe(11);
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 5, end: 11 },
        ]);
        mention.destroy();
    });
});

describe('MentionJS silent host mutation race protection', () => {
    it('does not open a pending textarea search after the trigger is removed silently', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let resolveRequest;
        const searchFunction = () => new Promise((resolve) => {
            resolveRequest = resolve;
        });
        const mention = new MentionJS(textarea, { searchFunction });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => expect(resolveRequest).toBeTypeOf('function'));

        // Framework updates can assign .value without a corresponding input.
        textarea.value = '';
        textarea.setSelectionRange(0, 0);
        resolveRequest([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        mention.destroy();
    });

    it('refuses a stale keyboard selection after the trigger is removed without an input event', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });

        textarea.value = 'normal text';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));

        expect(textarea.value).toBe('normal text');
        expect(mention.getMentions()).toEqual([]);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('preserves the legitimate result when the caret and token still match', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Alice', start: 0, end: 6 },
        ]);
        mention.destroy();
    });
});

describe('MentionJS reentrant custom rendering lifecycle', () => {
    it('does not restore dropdown or ARIA state after renderItem destroys the instance', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let mention;
        mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
            renderItem() {
                mention.destroy();
                return document.createElement('div');
            },
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => expect(mention._destroyed).toBe(true));
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.hasAttribute('aria-expanded')).toBe(false);
    });

    it('does not re-open a dropdown when renderNoResults clears the editor', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let mention;
        mention = new MentionJS(textarea, {
            searchFunction: async () => [],
            renderNoResults() {
                mention.clear();
                return document.createElement('div');
            },
        });
        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => expect(textarea.value).toBe(''));
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        mention.destroy();
    });

    it('does not start another page search when renderLoading destroys the instance', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue({
            items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
            nextPageUrl: '/next',
        });
        let mention;
        mention = new MentionJS(textarea, {
            searchFunction,
            renderLoading() {
                mention.destroy();
                return document.createElement('div');
            },
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true, cancelable: true,
        }));
        expect(mention._destroyed).toBe(true);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(searchFunction).toHaveBeenCalledTimes(1);
    });
});

describe('MentionJS abort listener reentrancy', () => {
    it('does not start a replacement search after abort synchronously destroys the instance', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let calls = 0;
        let mention;
        mention = new MentionJS(textarea, {
            searchFunction(query, page, context) {
                calls++;
                context.signal.addEventListener('abort', () => mention.destroy());
                return new Promise(() => {});
            },
        });

        const initial = mention._search('');
        expect(calls).toBe(1);
        const replacement = mention._search('');
        expect(await initial).toBeNull();
        expect(await replacement).toBeNull();
        expect(calls).toBe(1);
        expect(mention._destroyed).toBe(true);
        expect(mention._searchSession._activeController).toBeNull();
    });

    it('preserves a newer search started synchronously inside an abort callback', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        let calls = 0;
        let nested = null;
        let mention;
        const signals = [];
        mention = new MentionJS(textarea, {
            searchFunction(query, page, context) {
                calls++;
                signals.push(context.signal);
                if (calls === 1) {
                    context.signal.addEventListener('abort', () => {
                        nested = mention._search('');
                    });
                    return new Promise(() => {});
                }
                return Promise.resolve([{ id: 2, name: 'New' }]);
            },
        });

        const initial = mention._search('');
        const superseded = mention._search('');
        expect(await initial).toBeNull();
        expect(await superseded).toBeNull();
        expect(nested).not.toBeNull();
        expect(await nested).toEqual([{ id: 2, name: 'New' }]);
        expect(calls).toBe(2);
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
        expect(mention._searchSession.items).toEqual([{ id: 2, name: 'New' }]);
        mention.destroy();
        // The second request has already settled; AbortSignal is only
        // required to abort while the corresponding request is pending.
        expect(mention._searchSession.items).toEqual([]);
    });
});

describe('MentionJS identical native replacement identity', () => {
    it('invalidates a mention replaced by identical visible text', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);
        mention.push({ id: 42, name: 'Alice' });
        textarea.focus();
        textarea.setSelectionRange(0, 6);
        beforeInput(textarea, 'insertReplacementText', '@Alice');

        // A native replacement has occurred, but its final value is identical.
        input(textarea);

        expect(textarea.value).toBe('@Alice ');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('preserves an untouched mention when an identical replacement occurs elsewhere', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        textarea.value = 'hello ';
        const mention = new MentionJS(textarea);
        mention.push({ id: 42, name: 'Alice' });
        textarea.value += 'world';
        expect(mention.getMentions()).toHaveLength(1);
        textarea.focus();
        textarea.setSelectionRange(0, 5);
        beforeInput(textarea, 'insertReplacementText', 'hello');
        input(textarea);

        expect(mention.getMentions()).toEqual([
            { id: 42, name: 'Alice', start: 6, end: 12 },
        ]);
        mention.destroy();
    });
});

describe('MentionJS keyboard selection synchronization', () => {
    it('does not commit an old contenteditable token when Enter beats selectionchange', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 7, name: 'Alice' }],
        });
        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');
        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });
        const active = editor.querySelector('span.mention.active');
        const outside = document.createTextNode('tail');
        editor.appendChild(outside);
        setCaret(outside, 4);

        // The browser queues selectionchange; keydown can occur first.
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        });
        editor.dispatchEvent(enter);

        expect(enter.defaultPrevented).toBe(false);
        expect(editor.textContent).toBe('@tail');
        expect(mention.getMentions()).toEqual([]);
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});

describe('MentionJS selection spanning a cancelled token', () => {
    it('preserves a noncollapsed selection when an active token is unwrapped', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@al</span> tail';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');
        const trailingText = span.nextSibling;
        mention._mentionSpan = span;
        mention._bindSelectionChange();
        editor.focus();

        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(span.firstChild, 1);
        range.setEnd(trailingText, 3);
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe('al ta');

        document.dispatchEvent(new Event('selectionchange'));

        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.textContent).toBe('@al tail');
        expect(selection.isCollapsed).toBe(false);
        expect(selection.toString()).toBe('al ta');
        mention.destroy();
    });
});

describe('MentionJS backwards selection during token cleanup', () => {
    it('keeps the selection anchor and focus orientation after unwrapping', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@al</span> tail';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');
        const tail = span.nextSibling;
        mention._mentionSpan = span;
        mention._bindSelectionChange();
        editor.focus();

        const selection = window.getSelection();
        expect(typeof selection.setBaseAndExtent).toBe('function');
        selection.setBaseAndExtent(tail, 3, span.firstChild, 1);
        expect(selection.toString()).toBe('al ta');
        expect(selection.anchorNode).toBe(tail);

        document.dispatchEvent(new Event('selectionchange'));

        expect(editor.querySelector('span.mention')).toBeNull();
        expect(selection.toString()).toBe('al ta');
        expect(selection.anchorNode).toBe(tail);
        expect(selection.anchorOffset).toBe(3);
        expect(selection.focusNode).toBe(editor.firstChild);
        expect(selection.focusOffset).toBe(1);
        mention.destroy();
    });
});

describe('MentionJS optional multi-word mention searches', () => {
    it('rejects non-boolean allowSpacesInQuery values', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        expect(() => new MentionJS(textarea, {
            allowSpacesInQuery: 'yes',
        })).toThrow(/allowSpacesInQuery/);
    });

    it('keeps the previous whitespace-as-terminator behavior by default', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            searchFunction, debounceDelay: 0,
        });
        textarea.focus();
        textarea.value = '@Anna';
        textarea.setSelectionRange(5, 5);
        input(textarea);
        await vi.waitFor(() => expect(searchFunction).toHaveBeenCalledWith('Anna', null));
        textarea.value = '@Anna ';
        textarea.setSelectionRange(6, 6);
        input(textarea);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(mention._mentionStart).toBeNull();
        mention.destroy();
    });

    it('keeps a textarea search active across spaces and commits the whole name', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([
            { id: 1, name: 'Anna Ivanova' },
        ]);
        const mention = new MentionJS(textarea, {
            allowSpacesInQuery: true, debounceDelay: 0, searchFunction,
        });
        textarea.focus();
        textarea.value = '@Anna Iva';
        textarea.setSelectionRange(9, 9);
        input(textarea);
        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Anna Iva', null);
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(textarea.value).toBe('@Anna Ivanova ');
        expect(mention.getMentions()).toEqual([
            { id: 1, name: 'Anna Ivanova', start: 0, end: 13 },
        ]);
        mention.destroy();
    });

    it('replaces a complete multi-word textarea token before punctuation', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            allowSpacesInQuery: true, debounceDelay: 0,
            searchFunction: async () => [{ id: 2, name: 'Anna Ivanova' }],
        });
        textarea.focus();
        textarea.value = '@Anna Ivanod, rest';
        textarea.setSelectionRange(4, 4);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown.active')).not.toBeNull());
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(textarea.value).toBe('@Anna Ivanova, rest');
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Anna Ivanova', start: 0, end: 13 },
        ]);
        mention.destroy();
    });

    it('normalizes browser-inserted NBSP before calling a contenteditable search', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML =
            '<span class="mention active" data-mentionjs-token="true">@Anna\u00A0Iva</span>';
        document.body.appendChild(editor);
        const span = editor.firstChild;
        const searchFunction = vi.fn().mockResolvedValue([{ id: 3, name: 'Anna Ivanova' }]);
        const mention = new MentionJS(editor, {
            allowSpacesInQuery: true,
            debounceDelay: 0,
            searchFunction,
        });
        mention._mentionSpan = span;
        editor.focus();
        setCaret(span.firstChild, span.textContent.length);
        input(editor);
        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Anna Iva', null);
            expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        });
        expect(editor.querySelector('span.mention.active')).toBe(span);
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('ends multi-word searches on newline and when the trigger is removed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            allowSpacesInQuery: true,
            searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
        });
        textarea.focus();
        textarea.value = '@Anna Ivan';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown.active')).not.toBeNull());
        textarea.value = '@Anna\nIvan';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);
        expect(document.querySelector('.mention-dropdown')).toBeNull();

        textarea.value = '@Anna Ivan';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);
        await vi.waitFor(() => expect(document.querySelector('.mention-dropdown.active')).not.toBeNull());
        textarea.value = 'Anna Ivan';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});

describe('MentionJS blur does not regain selection focus', () => {
    it('releases a pending contenteditable span without restoring caret on blur', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention active" data-mentionjs-token="true">@Anna\u00A0Iv</span>';
        const textarea = document.createElement('textarea');
        document.body.append(editor, textarea);
        const mention = new MentionJS(editor, {
            allowSpacesInQuery: true,
        });
        const span = editor.firstChild;
        mention._mentionSpan = span;
        editor.focus();
        setCaret(span.firstChild, span.textContent.length);
        const unwrap = vi.spyOn(mention, '_unwrapMentionSpan');

        textarea.focus();

        expect(document.activeElement).toBe(textarea);
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.textContent).toBe('@Anna\u00A0Iv');
        expect(unwrap).toHaveBeenCalledWith(span, null);
        mention.destroy();
    });
});
