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

function createEditor(markup) {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.innerHTML = markup;
    document.body.appendChild(editor);
    const instance = new MentionJS(editor, {
        debounceDelay: 0,
        searchFunction: async () => [],
    });
    instances.push(instance);
    editor.focus();
    return { editor, instance };
}

function setCaret(node, offset) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function edit(editor, inputType) {
    const event = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType,
    });
    editor.dispatchEvent(event);
    return event;
}

const mention = (id, name) => `<span class="mention" data-mention-id="${id}" data-mention-name="${name}">@${name}</span>`;

describe('atomic mentions inside formatting wrappers', () => {
    it('Backspace before a mention never deletes a character inside the previous formatted mention', () => {
        const { editor, instance } = createEditor(
            `<strong>${mention('first', 'Alice')}</strong>${mention('second', 'Bob')}`
        );
        const alice = editor.querySelector('[data-mention-id="first"]');
        const bob = editor.querySelector('[data-mention-id="second"]');
        setCaret(bob.firstChild, 0);
        const event = edit(editor, 'deleteContentBackward');
        expect(event.defaultPrevented).toBe(true);
        expect(alice.textContent).toBe('@Alice');
        expect(alice.dataset.mentionId).toBe('first');
        expect(bob.textContent).toBe('@Bob');
        expect(bob.dataset.mentionId).toBe('second');

        // Cancel the newly active previous token as with a direct sibling.
        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        expect(instance.getMentions()).toEqual([
            { id: 'first', name: 'Alice' },
            { id: 'second', name: 'Bob' },
        ]);
    });

    it('Backspace at a formatted boundary removes normal trailing text, not earlier mention metadata', () => {
        const { editor, instance } = createEditor(
            `<strong>${mention('first', 'Alice')}tail</strong>${mention('second', 'Bob')}`
        );
        const bob = editor.querySelector('[data-mention-id="second"]');
        setCaret(bob.firstChild, 0);
        const event = edit(editor, 'deleteContentBackward');
        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('strong').textContent).toBe('@Alicetai');
        expect(instance.getMentions()).toEqual([
            { id: 'first', name: 'Alice' },
            { id: 'second', name: 'Bob' },
        ]);
    });

    it('Forward delete removes an adjacent committed mention atomically inside a wrapper', () => {
        const { editor, instance } = createEditor(
            `${mention('first', 'Bob')}<em>${mention('second', 'Alice')}</em>`
        );
        const bob = editor.querySelector('[data-mention-id="first"]');
        setCaret(bob.firstChild, bob.textContent.length);
        const event = edit(editor, 'deleteContentForward');
        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('[data-mention-id="second"]')).toBeNull();
        expect(instance.getMentions()).toEqual([{ id: 'first', name: 'Bob' }]);
        expect(editor.textContent).toBe('@Bob');
    });

    it('Forward delete removes ordinary formatted text normally when no mention is at the edge', () => {
        const { editor, instance } = createEditor(
            `${mention('first', 'Bob')}<em>hello${mention('second', 'Alice')}</em>`
        );
        const bob = editor.querySelector('[data-mention-id="first"]');
        setCaret(bob.firstChild, bob.textContent.length);
        const event = edit(editor, 'deleteContentForward');
        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('em').textContent).toBe('ello@Alice');
        expect(instance.getMentions()).toEqual([
            { id: 'first', name: 'Bob' },
            { id: 'second', name: 'Alice' },
        ]);
    });
});

describe('formatted line-break boundaries', () => {
    it('Backspace removes the trailing nested br rather than editing a preceding committed mention', () => {
        const { editor, instance } = createEditor(
            `<strong>${mention('first', 'Alice')}<br></strong>${mention('second', 'Bob')}`
        );
        const bob = editor.querySelector('[data-mention-id="second"]');
        setCaret(bob.firstChild, 0);
        const event = edit(editor, 'deleteContentBackward');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('strong br')).toBeNull();
        expect(editor.querySelector('[data-mention-id="first"]').textContent).toBe('@Alice');
        expect(instance.getMentions()).toEqual([
            { id: 'first', name: 'Alice' },
            { id: 'second', name: 'Bob' },
        ]);
    });

    it('Delete removes a leading nested br rather than the following committed mention', () => {
        const { editor, instance } = createEditor(
            `${mention('first', 'Bob')}<em><br>${mention('second', 'Alice')}</em>`
        );
        const bob = editor.querySelector('[data-mention-id="first"]');
        setCaret(bob.firstChild, bob.textContent.length);
        const event = edit(editor, 'deleteContentForward');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('em br')).toBeNull();
        expect(editor.querySelector('[data-mention-id="second"]').textContent).toBe('@Alice');
        expect(instance.getMentions()).toEqual([
            { id: 'first', name: 'Bob' },
            { id: 'second', name: 'Alice' },
        ]);
    });

    it('allows a mention trigger directly after a line break nested in inline formatting', () => {
        const { editor } = createEditor('<strong>word<br></strong>');
        setCaret(editor, 1);
        const event = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: '@',
        });
        editor.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('span.mention.active')?.textContent).toBe('@');
        expect(editor.querySelector('strong br')).not.toBeNull();
    });

    it('still treats a nested mention as atomic when no br separates it from the caret', () => {
        const { editor, instance } = createEditor(
            `<strong>${mention('first', 'Alice')}</strong>${mention('second', 'Bob')}`
        );
        const bob = editor.querySelector('[data-mention-id="second"]');
        setCaret(bob.firstChild, 0);
        const event = edit(editor, 'deleteContentBackward');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.querySelector('[data-mention-id="first"]').textContent).toBe('@Alice');
        expect(instance.getMentions().some(item => item.id === 'second')).toBe(true);
    });
});
