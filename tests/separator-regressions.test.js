// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import MentionModule from '../mention.js';

const MentionJS = MentionModule?.default ?? MentionModule;
const instances = [];
afterEach(() => {
    for (const instance of instances.splice(0)) instance.destroy();
    document.body.innerHTML = '';
});

function setCaret(node, offset) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function makeEditor(content) {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = content;
    document.body.appendChild(editor);
    editor.focus();
    const instance = new MentionJS(editor);
    instances.push(instance);
    setCaret(editor.firstChild, 0);
    return { editor, instance };
}

describe('separator contract is consistent between editor modes', () => {
    for (const punctuation of [',', ';', '!', '?']) {
        it(`contenteditable push leaves ${punctuation} directly after a committed mention`, () => {
            const { editor, instance } = makeEditor(punctuation + 'tail');
            instance.push({ id: 7, name: 'Alice' });
            expect(editor.textContent).toBe('@Alice' + punctuation + 'tail');
            expect(instance.getMentions()).toEqual([{ id: '7', name: 'Alice' }]);
            const selection = window.getSelection();
            expect(selection.anchorNode.textContent).toBe(punctuation + 'tail');
            expect(selection.anchorOffset).toBe(0);
        });

        it(`contenteditable suggestion commit leaves ${punctuation} adjacent`, () => {
            const { editor, instance } = makeEditor(punctuation + 'tail');
            const span = document.createElement('span');
            span.className = 'mention active';
            span.dataset.mentionjsToken = 'true';
            span.textContent = '@a';
            editor.insertBefore(span, editor.firstChild);
            instance._mentionSpan = span;
            setCaret(span.firstChild, 2);
            instance._commitSpanMention({ id: 7, name: 'Alice' });
            expect(editor.textContent).toBe('@Alice' + punctuation + 'tail');
            expect(instance.getMentions()).toEqual([{ id: '7', name: 'Alice' }]);
            const selection = window.getSelection();
            expect(selection.anchorNode.textContent).toBe(punctuation + 'tail');
            expect(selection.anchorOffset).toBe(0);
        });

        it(`textarea push also omits redundant space before ${punctuation}`, () => {
            const field = document.createElement('textarea');
            field.value = punctuation + 'tail';
            document.body.appendChild(field);
            const instance = new MentionJS(field);
            instances.push(instance);
            field.focus();
            field.setSelectionRange(0, 0);
            instance.push({ id: 7, name: 'Alice' });
            expect(field.value).toBe('@Alice' + punctuation + 'tail');
            expect(instance.getMentions()).toEqual([
                { id: 7, name: 'Alice', start: 0, end: 6 },
            ]);
            expect(field.selectionStart).toBe(6);
        });
    }

    it('retains existing whitespace and places the caret after it', () => {
        const { editor, instance } = makeEditor(' rest');
        instance.push({ id: 7, name: 'Alice' });
        expect(editor.textContent).toBe('@Alice rest');
        expect(window.getSelection().anchorOffset).toBe(1);
    });

    it('keeps the legacy space after a mention inserted before plain text', () => {
        const { editor, instance } = makeEditor('hello');
        instance.push({ id: 7, name: 'Alice' });
        expect(editor.textContent).toBe('@Alice\u00A0hello');
        expect(window.getSelection().anchorOffset).toBe(1);
    });
});
