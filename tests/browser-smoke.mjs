import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER_URL = 'http://127.0.0.1:9515';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const BROWSER = process.env.BROWSER || 'chrome';
const BUNDLE = process.env.BUNDLE || 'source';

if (!['chrome', 'firefox'].includes(BROWSER)) {
    throw new Error(`Unsupported browser: ${BROWSER}`);
}
if (!['source', 'dist'].includes(BUNDLE)) {
    throw new Error(`Unsupported browser fixture: ${BUNDLE}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function sleep(ms) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function request(path, method = 'GET', body = undefined) {
    const response = await fetch(DRIVER_URL + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
        throw new Error(
            `WebDriver ${method} ${path} failed: ${JSON.stringify(payload)}`
        );
    }
    return payload.value;
}

async function waitForDriver(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const status = await request('/status');
            if (status.ready) return;
        } catch (_) {}
        await sleep(100);
    }
    throw new Error('ChromeDriver did not become ready');
}

async function waitFor(exec, predicate, message, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await exec();
        if (predicate(last)) return last;
        await sleep(50);
    }
    throw new Error(`${message}; last value: ${JSON.stringify(last)}`);
}

const driver = BROWSER === 'firefox'
    ? spawn('geckodriver', ['--port', '9515'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn('chromedriver', ['--port=9515'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

let driverOutput = '';
driver.stdout.on('data', (chunk) => { driverOutput += chunk.toString(); });
driver.stderr.on('data', (chunk) => { driverOutput += chunk.toString(); });

let sessionId = null;

try {
    await waitForDriver();

    const alwaysMatch = BROWSER === 'firefox'
        ? {
            browserName: 'firefox',
            'moz:firefoxOptions': {
                args: ['-headless'],
            },
        }
        : {
            browserName: 'chrome',
            'goog:chromeOptions': {
                args: [
                    '--headless=new',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--allow-file-access-from-files',
                ],
            },
        };

    const session = await request('/session', 'POST', {
        capabilities: { alwaysMatch },
    });
    sessionId = session.sessionId;

    const base = `/session/${sessionId}`;
    const execute = async (script, args = []) => request(
        base + '/execute/sync',
        'POST',
        { script, args }
    );
    const activeElement = async () => {
        const element = await request(base + '/element/active');
        return element[ELEMENT_KEY];
    };
    const sendKeys = async (text) => {
        const elementId = await activeElement();
        await request(
            `${base}/element/${encodeURIComponent(elementId)}/value`,
            'POST',
            { text, value: Array.from(text) }
        );
    };

    const fixtureUrl = pathToFileURL(
        resolve(process.cwd(), BUNDLE === 'dist'
            ? 'tests/browser-smoke-dist.html'
            : 'tests/browser-smoke.html')
    ).href;
    await request(base + '/url', 'POST', { url: fixtureUrl });

    await waitFor(
        () => execute('return typeof window.MentionJS'),
        (value) => value === 'function',
        'MentionJS did not load in Chrome'
    );

    // 1. Real textarea key events: trigger -> query -> Enter commit -> caret.
    await execute(`
        window.__instance?.destroy();
        window.__calls = [];
        const textarea = document.getElementById('textarea');
        textarea.value = '';
        textarea.focus();
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__calls.push(query);
                return [{ id: 1, name: 'Alice' }];
            },
        });
    `);
    await sendKeys('@a');

    await waitFor(
        () => execute(`
            return {
                calls: window.__calls,
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.calls.includes('a'),
        'Textarea search did not open for native key input'
    );

    await sendKeys('\uE007'); // Enter
    const textareaCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(textareaCommit.value === '@Alice ', 'Textarea commit text mismatch');
    assert(textareaCommit.start === 7 && textareaCommit.end === 7,
        'Textarea caret was not placed after committed mention');
    assert(textareaCommit.mentions.length === 1 && textareaCommit.mentions[0].id === 1,
        'Textarea committed mention metadata mismatch');

    // 2. Real contenteditable key events: trigger -> query -> Enter commit.
    await execute(`
        window.__instance.destroy();
        window.__calls = [];
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__calls.push(query);
                return [{ id: 2, name: 'Bob' }];
            },
        });
    `);
    await sendKeys('@b');

    await waitFor(
        () => execute(`
            return {
                calls: window.__calls,
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.calls.includes('b'),
        'Contenteditable search did not open for native key input'
    );

    await sendKeys('\uE007');
    const editableCommit = await execute(`
        const editor = document.getElementById('editor');
        const span = editor.querySelector('span.mention');
        const selection = window.getSelection();
        return {
            text: editor.textContent,
            id: span?.dataset.mentionId ?? null,
            name: span?.dataset.mentionName ?? null,
            active: span?.classList.contains('active') ?? null,
            caretText: selection.anchorNode?.textContent ?? null,
            caretOffset: selection.anchorOffset,
        };
    `);
    assert(editableCommit.id === '2' && editableCommit.name === 'Bob',
        'Contenteditable committed mention metadata mismatch');
    assert(editableCommit.active === false,
        'Contenteditable committed mention stayed active');
    assert(editableCommit.caretText === '\u00A0' && editableCommit.caretOffset === 1,
        'Contenteditable caret was not placed after trailing separator');

    // 3. Escape must cancel a pending search before its response arrives.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__pendingResolve = null;
        window.__instance = new MentionJS(editor, {
            searchFunction: () => new Promise((resolve) => {
                window.__pendingResolve = resolve;
            }),
        });
    `);
    await sendKeys('@');

    await waitFor(
        () => execute('return typeof window.__pendingResolve'),
        (value) => value === 'function',
        'Pending contenteditable search was not started'
    );

    await sendKeys('\uE00C'); // Escape
    await execute(`
        window.__pendingResolve([{ id: 3, name: 'Carol' }]);
    `);
    await sleep(100);

    const pendingEscape = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            mention: !!editor.querySelector('span.mention'),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    assert(pendingEscape.text === '@', 'Escape changed pending trigger text');
    assert(!pendingEscape.mention, 'Escape left a pending mention token');
    assert(!pendingEscape.dropdown, 'Late pending response reopened dropdown after Escape');

    // 4. Native Backspace must remove a trigger-only token completely.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            searchFunction: async () => [],
        });
    `);
    await sendKeys('@');
    await waitFor(
        () => execute("return !!document.querySelector('#editor span.mention')"),
        Boolean,
        'Trigger-only mention token was not created'
    );
    await sendKeys('\uE003'); // Backspace
    const backspace = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            span: !!editor.querySelector('span'),
        };
    `);
    assert(backspace.text === '' && !backspace.span,
        'Backspace did not remove trigger-only token cleanly');

    // Removing the trigger ends the old search; typing a new trigger must
    // start a clean independent search with the caret inside a new span.
    await sendKeys('@x');
    await waitFor(
        () => execute("return document.querySelector('#editor span.mention.active')?.textContent === '@x' && !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Search did not restart after deleting and retyping the trigger'
    );
    await sendKeys('\uE00C');
    const cancelledRestart = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            pending: !!editor.querySelector('span.mention'),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    assert(cancelledRestart.text === '@x' &&
        !cancelledRestart.pending && !cancelledRestart.dropdown,
        'Escape after restarting a deleted trigger left broken markup');

    // 5. Native undo/redo must never leave mention metadata detached from text.
    await execute(`
        window.__instance?.destroy();
        const textarea = document.getElementById('textarea');
        textarea.value = '';
        textarea.focus();
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 10, name: 'Alice' }],
        });
    `);
    await sendKeys('@a');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Textarea dropdown did not open before undo/redo check'
    );
    await sendKeys('\uE007');

    const assertTextareaMentionConsistency = async (label) => {
        const state = await execute(`
            const textarea = document.getElementById('textarea');
            return {
                value: textarea.value,
                mentions: window.__instance.getMentions(),
            };
        `);

        for (const mention of state.mentions) {
            assert(
                state.value.slice(mention.start, mention.end) === '@' + mention.name,
                label + ': textarea mention metadata is stale'
            );
        }
    };

    await sendKeys('\uE009z\uE000'); // Control+Z
    await sleep(100);
    await assertTextareaMentionConsistency('undo');

    await sendKeys('\uE009\uE008z\uE000'); // Control+Shift+Z
    await sleep(100);
    await assertTextareaMentionConsistency('redo');

    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 11, name: 'Bob' }],
        });
    `);
    await sendKeys('@b');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Contenteditable dropdown did not open before undo/redo check'
    );
    await sendKeys('\uE007');

    const assertEditableMentionConsistency = async (label) => {
        const state = await execute(`
            const editor = document.getElementById('editor');
            return Array.from(
                editor.querySelectorAll('span[data-mention-id][data-mention-name]')
            ).map((span) => ({
                text: span.textContent,
                name: span.dataset.mentionName,
                active: span.classList.contains('active'),
            }));
        `);

        for (const mention of state) {
            assert(
                mention.text === '@' + mention.name && !mention.active,
                label + ': contenteditable mention metadata is stale'
            );
        }
    };

    await sendKeys('\uE009z\uE000'); // Control+Z
    await sleep(100);
    await assertEditableMentionConsistency('undo');

    await sendKeys('\uE009\uE008z\uE000'); // Control+Shift+Z
    await sleep(100);
    await assertEditableMentionConsistency('redo');

    // 6. A caret inside a token must replace its entire suffix, while
    // preserving the comma that follows the name.
    await execute(`
        window.__instance.destroy();
        window.__queries = [];
        const textarea = document.getElementById('textarea');
        textarea.value = '@alice, world';
        textarea.focus();
        textarea.setSelectionRange(3, 3);
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__queries.push(query);
                return [{ id: 22, name: 'Bob' }];
            },
        });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(
        () => execute(`
            return {
                query: window.__queries.at(-1),
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.query === 'al',
        'Mid-token query failed in the native browser'
    );
    await sendKeys('\uE007');
    const middleCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            caret: textarea.selectionStart,
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(middleCommit.value === '@Bob, world',
        'A mid-token commit lost punctuation or kept the old token suffix');
    assert(middleCommit.caret === 4, 'Caret after a mid-token mention is wrong');
    assert(middleCommit.mentions.length === 1 &&
        middleCommit.mentions[0].id === 22,
        'Mid-token commit did not retain the selected identity');

    // 7. External .value changes without input must invalidate stale
    // autocomplete results before a keyboard commit.
    await execute(`
        const textarea = document.getElementById('textarea');
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Dropdown did not open before stale-input regression'
    );
    await execute(`
        const textarea = document.getElementById('textarea');
        textarea.value = 'plain text';
        textarea.setSelectionRange(10, 10);
    `);
    await sendKeys('\uE007');
    const staleCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            mentions: window.__instance.getMentions(),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    // If selectionchange closes the dropdown before Enter, a textarea may
    // accept Enter as an ordinary newline. What must never happen is
    // committing the stale mention or reopening its suggestion list.
    assert(/^plain text(?:\r?\n)?$/u.test(staleCommit.value) &&
        staleCommit.mentions.length === 0 && !staleCommit.dropdown,
        'Stale result after silent host edit: ' + JSON.stringify(staleCommit));

    // 8. Real browser selection must survive cancellation of an active
    // contenteditable mention, including backwards anchor/focus direction.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [],
        });
    `);
    await sendKeys('@al');
    await waitFor(
        () => execute(`
            const span = document.querySelector('#editor span.mention.active');
            return !!span && span.textContent === '@al' &&
                !!document.querySelector('.mention-dropdown.active');
        `),
        Boolean,
        'Active rich-text mention did not initialize for selection test'
    );
    const backwardSelection = await execute(`
        const editor = document.getElementById('editor');
        const span = editor.querySelector('span.mention.active');
        const tail = document.createTextNode(' tail');
        editor.appendChild(tail);
        const selection = window.getSelection();
        selection.setBaseAndExtent(tail, 3, span.firstChild, 1);
        document.dispatchEvent(new Event('selectionchange'));
        return {
            hasSpan: !!editor.querySelector('span.mention'),
            text: editor.textContent,
            selected: selection.toString(),
            anchorIsTail: selection.anchorNode === tail,
            anchorOffset: selection.anchorOffset,
            focusIsText: selection.focusNode === editor.firstChild,
            focusOffset: selection.focusOffset,
        };
    `);
    assert(!backwardSelection.hasSpan &&
        backwardSelection.text === '@al tail' &&
        backwardSelection.selected === 'al ta' &&
        backwardSelection.anchorIsTail &&
        backwardSelection.anchorOffset === 3 &&
        backwardSelection.focusIsText &&
        backwardSelection.focusOffset === 1,
        'Backward selection was not preserved after cancelling a mention: ' +
        JSON.stringify(backwardSelection));


    // 9. Exercise the interactive demo, not just the isolated library fixture.
    const siteUrl = pathToFileURL(resolve(process.cwd(), 'index.html')).href;
    await request(base + '/url', 'POST', { url: siteUrl });
    await waitFor(
        () => execute("return document.documentElement.dataset.demoReady === 'true' && typeof window.MentionJS === 'function';"),
        Boolean, 'Interactive demo did not initialize'
    );
    const readyDemo = await execute(
        "return { title: document.title, editor: !!document.getElementById('editor'), textarea: !!document.getElementById('textarea'), previews: document.querySelectorAll('.mention-preview').length };"
    );
    assert(readyDemo.title.includes('MentionJS') &&
        readyDemo.editor && readyDemo.textarea && readyDemo.previews === 2,
        'Demo is missing an interactive editor or metadata preview');

    await execute("document.getElementById('textarea').focus();");
    await sendKeys('@');
    await waitFor(
        () => execute("return document.querySelectorAll('.mention-dropdown.active .mention-item[data-index]').length;"),
        (value) => value === 5, 'Demo did not show the first result page'
    );
    await execute(
        "const list = document.querySelector('.mention-dropdown'); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll'));"
    );
    await waitFor(
        () => execute("return document.querySelectorAll('.mention-dropdown.active .mention-item[data-index]').length;"),
        (value) => value === 10, 'Demo did not load the second result page'
    );

    await sendKeys('\uE007');
    const demoCommit = await execute(
        "return { value: document.getElementById('textarea').value, mentions: JSON.parse(document.getElementById('mentions-textarea').textContent), feedback: document.getElementById('status-textarea').textContent };"
    );
    assert(demoCommit.value.startsWith('@Anna Ivanova') &&
        demoCommit.mentions.length === 1 && demoCommit.mentions[0].id === 1 &&
        demoCommit.feedback.includes('Selected'),
        'Demo did not show committed textarea mention metadata');

    const demoApi = await execute(
        "pushMention('textarea'); const pushed = JSON.parse(document.getElementById('mentions-textarea').textContent); " +
        "clearField('textarea'); const cleared = JSON.parse(document.getElementById('mentions-textarea').textContent); " +
        "pushMention('editor'); const editorPushed = JSON.parse(document.getElementById('mentions-editor').textContent); " +
        "clearField('editor'); const editorCleared = JSON.parse(document.getElementById('mentions-editor').textContent); " +
        "return { pushed: pushed.length, cleared: cleared.length, editorPushed, editorCleared: editorCleared.length, textarea: document.getElementById('textarea').value, editorText: document.getElementById('editor').textContent };"
    );
    assert(demoApi.pushed === 2 && demoApi.cleared === 0 &&
        demoApi.editorPushed.length === 1 && demoApi.editorPushed[0].id === '7' &&
        demoApi.editorCleared === 0 && demoApi.textarea === '' && demoApi.editorText === '',
        'Demo public API controls did not keep metadata in sync');


    // 10. Long native contenteditable typing must not silently unwrap the active
    // mention before the user chooses a suggestion, even with no match.
    await request(base + '/url', 'POST', { url: fixtureUrl });
    await execute(`
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__typingTrace = [];
        const snapshot = (type, event) => {
            const span = editor.querySelector('span.mention');
            const sel = window.getSelection();
            window.__typingTrace.push({
                type,
                inputType: event?.inputType || null,
                data: event?.data || null,
                text: editor.textContent,
                span: span?.textContent || null,
                active: !!span?.classList.contains('active'),
                node: sel.anchorNode?.nodeName || null,
                parent: sel.anchorNode?.parentElement?.tagName || null,
                offset: sel.anchorOffset,
            });
        };
        editor.addEventListener('beforeinput', (event) => snapshot('beforeinput', event), true);
        editor.addEventListener('input', (event) => snapshot('input', event));
        document.addEventListener('selectionchange', () => snapshot('selectionchange'));
        window.__instance = new MentionJS(editor, {
            debounceDelay: 30,
            // Unconfigured contenteditable must keep v1 multi-word search.
            searchFunction: async (query) => {
                await new Promise(resolve => setTimeout(resolve, 85));
                return query.toLowerCase().startsWith('anna')
                    ? [{ id: 100, name: 'Anna Ivanova' }]
                    : [];
            },
        });
    `);
    await sendKeys('@Anna Ivanod');
    await sleep(450);
    const typingState = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            span: editor.querySelector('span.mention')?.outerHTML || null,
            active: !!editor.querySelector('span.mention.active'),
            expanded: editor.getAttribute('aria-expanded'),
            dropdown: !!document.querySelector('.mention-dropdown.active'),
            trace: window.__typingTrace.slice(-35),
        };
    `);
    assert(typingState.text === '@Anna Ivanod' &&
        typingState.active && typingState.dropdown,
        'Long native contenteditable query lost its active token: ' +
        JSON.stringify(typingState));

    // Editing a committed mention must retain the editable token while
    // the trigger still exists, without silently converting it to plain text.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            allowSpacesInQuery: true,
            searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
        });
    `);
    await sendKeys('@a');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean, 'No suggestions before edit-committed case'
    );
    await sendKeys('\uE007');
    await execute(`
        const span = document.querySelector('#editor span[data-mention-id]');
        const range = document.createRange();
        range.setStart(span.firstChild, span.textContent.length - 1);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.getElementById('editor').focus();
    `);
    await sendKeys('\uE003');
    await sleep(120);
    const reedit = await execute(`
        const el = document.getElementById('editor');
        const span = el.querySelector('span.mention');
        return {
            text: el.textContent,
            active: !!span?.classList.contains('active'),
            span: span?.outerHTML || null,
            dropdown: !!document.querySelector('.mention-dropdown.active'),
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(reedit.active && reedit.dropdown &&
        reedit.mentions.length === 0,
        'Editing a committed mention did not retain an active span: ' + JSON.stringify(reedit));


    // 10b. After editing a committed mention with Backspace, subsequent
    // native typing must keep the same active span and resume suggestions.
    await sendKeys('xy');
    await waitFor(
        () => execute("return !!document.querySelector('#editor span.mention.active') && !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Typing after deleting inside a mention dropped the editable span'
    );
    const afterReeditTyping = await execute(`
        const editor = document.getElementById('editor');
        const active = editor.querySelector('span.mention.active');
        const selection = window.getSelection();
        return {
            html: editor.innerHTML,
            text: editor.textContent,
            token: active?.textContent ?? null,
            committed: window.__instance.getMentions(),
            focused: document.activeElement?.id ?? null,
            caretParent: selection.anchorNode?.parentElement?.tagName ?? null,
            caretOffset: selection.anchorOffset,
            trace: window.__typingTrace.slice(-28),
        };
    `);
    assert(afterReeditTyping.token.includes('xy') &&
        afterReeditTyping.committed.length === 0 &&
        afterReeditTyping.focused === 'editor' &&
        afterReeditTyping.caretParent === 'SPAN',
        'Native typing after Backspace broke rich-text mention: ' +
        JSON.stringify(afterReeditTyping));
    await sendKeys('\uE007');
    const recommitted = await execute(`
        return {
            mentions: window.__instance.getMentions(),
            span: document.querySelector('#editor span[data-mention-id]')?.outerHTML ?? null,
        };
    `);
    assert(recommitted.mentions.length === 1 &&
        recommitted.mentions[0].id === '1',
        'Edited mention could not be selected a second time: ' +
        JSON.stringify(recommitted));


    // 10c. Verify boundary editing in the native browser. These are important
    // because a DOM text-node caret may be retargeted to the host after edit.
    for (const scenario of [
        { name: 'Backspace at the end of a committed mention', offset: 'end', key: '\uE003', insert: 'Z' },
        { name: 'Delete in the middle of a committed mention', offset: 'middle', key: '\uE017', insert: 'Q' },
    ]) {
        await execute(`
            window.__instance.destroy();
            const editor = document.getElementById('editor');
            editor.innerHTML = '';
            editor.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            window.__instance = new MentionJS(editor, {
                debounceDelay: 0,
                allowSpacesInQuery: true,
                searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
            });
        `);
        await sendKeys('@a');
        await waitFor(
            () => execute("return !!document.querySelector('.mention-dropdown.active')"),
            Boolean, 'No dropdown before ' + scenario.name
        );
        await sendKeys('\uE007');
        await execute(`
            const editor = document.getElementById('editor');
            const span = editor.querySelector('span[data-mention-id]');
            const range = document.createRange();
            const offset = arguments[0] === 'end'
                ? span.firstChild.textContent.length
                : Math.floor(span.firstChild.textContent.length / 2);
            range.setStart(span.firstChild, offset);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
        `, [scenario.offset]);
        await sendKeys(scenario.key);
        await waitFor(
            () => execute("return !!document.querySelector('#editor span.mention.active')"),
            Boolean, scenario.name + ' did not activate mention edit'
        );
        await sendKeys(scenario.insert);
        const result = await waitFor(
            () => execute(`
                const editor = document.getElementById('editor');
                const span = editor.querySelector('span.mention.active');
                const sel = window.getSelection();
                return {
                    text: editor.textContent,
                    active: !!span,
                    span: span?.textContent ?? null,
                    dropdown: !!document.querySelector('.mention-dropdown.active'),
                    committed: window.__instance.getMentions(),
                    focused: document.activeElement?.id,
                    caretNode: sel.anchorNode?.nodeName,
                    caretParent: sel.anchorNode?.parentElement?.tagName,
                    html: editor.innerHTML,
                    trace: window.__typingTrace.slice(-14),
                };
            `),
            (v) => v.active && v.dropdown && v.span.includes(scenario.insert),
            scenario.name + ' caused mention to unwrap after typing'
        );
        assert(result.committed.length === 0,
            scenario.name + ' kept invalid committed ID');
    }

    // 10d. Delete characters in an uncommitted token, then keep typing.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const sel = window.getSelection(), range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            allowSpacesInQuery: true,
            searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
        });
    `);
    await sendKeys('@abc');
    await sendKeys('\uE003\uE003');
    await sendKeys('x');
    const continuing = await waitFor(
        () => execute(`
            const editor = document.getElementById('editor');
            return {
                text: editor.textContent,
                span: editor.querySelector('span.mention.active')?.textContent ?? null,
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (v) => v.span === '@ax' && v.dropdown,
        'Continuing to type after deleting uncommitted mention characters failed'
    );


    // 10e. Deleting from the default post-commit caret should not cause
    // subsequent typing to discard the existing mention span.
    for (const backspaceCount of [1, 2]) {
        await execute(`
            window.__instance.destroy();
            const editor = document.getElementById('editor');
            editor.innerHTML = '';
            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            window.__instance = new MentionJS(editor, {
                debounceDelay: 0,
                allowSpacesInQuery: true,
                searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
            });
        `);
        await sendKeys('@a');
        await waitFor(
            () => execute("return !!document.querySelector('.mention-dropdown.active')"),
            Boolean, 'Could not select mention for trailing-caret Backspace test'
        );
        await sendKeys('\uE007');
        await sendKeys('\uE003'.repeat(backspaceCount));
        await sendKeys('X');
        const state = await execute(`
            const editor = document.getElementById('editor');
            const sel = window.getSelection();
            const span = editor.querySelector('span.mention');
            return {
                text: editor.textContent,
                html: editor.innerHTML,
                span: span?.outerHTML ?? null,
                committed: window.__instance.getMentions(),
                caretNode: sel.anchorNode?.nodeName,
                caretParent: sel.anchorNode?.parentElement?.tagName,
                caretOffset: sel.anchorOffset,
                focused: document.activeElement?.id,
                trace: window.__typingTrace.slice(-20),
            };
        `);
        assert(state.text.includes('X') && state.span && state.focused === 'editor',
            backspaceCount + ' Backspace key(s) after commit dropped the span: ' +
            JSON.stringify(state));
    }

    // 11. The published demo opts in to multi-word queries in both editors.
    await request(base + '/url', 'POST', { url: siteUrl });
    await waitFor(
        () => execute("return document.documentElement.dataset.demoReady === 'true'"),
        Boolean, 'Demo not ready for full-name queries'
    );
    await execute("document.getElementById('editor').focus();");
    await sendKeys('@Anna Iv');
    await waitFor(
        () => execute("return !!document.querySelector('#editor span.mention.active') && !!document.querySelector('.mention-dropdown.active')"),
        Boolean, 'Demo rich-text full-name search stopped at a space'
    );
    const editorMultiwordQuery = await execute(`
        return {
            token: document.querySelector('#editor span.mention.active')?.textContent,
            feedback: document.querySelector('#search-editor')?.textContent,
        };
    `);
    assert(editorMultiwordQuery.token.replace(/\u00A0/g, ' ') === '@Anna Iv' &&
        editorMultiwordQuery.feedback.includes('1 result'),
        'Demo rich-text search failed after whitespace: ' + JSON.stringify(editorMultiwordQuery));

    await execute("document.getElementById('textarea').focus();");
    await sendKeys('@Anna Iv');
    await waitFor(
        () => execute(`return {
            value: document.getElementById('textarea').value,
            focused: document.activeElement?.id,
            dropdown: !!document.querySelector('.mention-dropdown.active'),
            expanded: document.getElementById('textarea').getAttribute('aria-expanded'),
            searchStatus: document.getElementById('search-textarea').textContent,
            selection: [document.getElementById('textarea').selectionStart, document.getElementById('textarea').selectionEnd],
        };`),
        (state) => state.dropdown && state.value === '@Anna Iv',
        'Demo textarea full-name search stopped at a space'
    );
    await sendKeys('\uE007');
    const textareaMultiwordCommit = await execute(`
        return {
            mentions: JSON.parse(document.getElementById('mentions-textarea').textContent),
            value: document.getElementById('textarea').value,
        };
    `);
    assert(textareaMultiwordCommit.mentions.length === 1 &&
        textareaMultiwordCommit.mentions[0].name === 'Anna Ivanova' &&
        textareaMultiwordCommit.value.startsWith('@Anna Ivanova'),
        'Demo did not commit the selected full-name result: ' + JSON.stringify(textareaMultiwordCommit));


    // Editing the selected token revokes its previous identity, so the demo
    // should not continue to display an outdated "Selected ..." message.
    await execute(`
        const textarea = document.getElementById('textarea');
        textarea.focus();
        textarea.setSelectionRange(3, 3);
    `);
    await sendKeys('X');
    const invalidated = await waitFor(
        () => execute(`
            return {
                mentions: JSON.parse(document.getElementById('mentions-textarea').textContent),
                status: document.getElementById('status-textarea').textContent,
                value: document.getElementById('textarea').value,
            };
        `),
        (state) => state.mentions.length === 0 && state.status === '' &&
            state.value.includes('@AnXna'),
        'Demo did not clear stale selection feedback after editing a committed ID'
    );


    // Native cursor-before-trigger identity regression: typing a space and
    // then another character must not silently decommit a saved mention.
    await request(base + '/url', 'POST', { url: fixtureUrl });
    const beforeTriggerCases = [];
    for (const caretKind of ['text-start', 'span-start', 'editor-before']) {
        await execute(`
            const editor = document.getElementById('editor');
            window.__instance?.destroy();
            editor.innerHTML = '';
            editor.focus();
            const caret = document.createRange();
            caret.selectNodeContents(editor);
            caret.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(caret);
            window.__instance = new MentionJS(editor, {
                searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
            });
            window.__instance.push({ id: 1, name: 'Anna Ivanova' });
            const span = editor.querySelector('span.mention');
            const start = document.createRange();
            if (arguments[0] === 'text-start') {
                start.setStart(span.firstChild, 0);
            } else if (arguments[0] === 'span-start') {
                start.setStart(span, 0);
            } else {
                start.setStart(editor, 0);
            }
            start.collapse(true);
            selection.removeAllRanges();
            selection.addRange(start);
        `, [caretKind]);
        const initial = await execute(`
            const editor = document.getElementById('editor');
            const sel = window.getSelection();
            return {
                mentions: window.__instance.getMentions(),
                html: editor.innerHTML,
                caret: { node: sel.anchorNode?.nodeName, offset: sel.anchorOffset },
            };
        `);
        await sendKeys(' ');
        const afterSpace = await execute(`
            const editor = document.getElementById('editor');
            const sel = window.getSelection();
            return {
                mentions: window.__instance.getMentions(),
                html: editor.innerHTML,
                text: editor.textContent,
                caret: { node: sel.anchorNode?.nodeName, offset: sel.anchorOffset },
            };
        `);
        await sendKeys('x');
        const afterTyping = await execute(`
            const editor = document.getElementById('editor');
            const sel = window.getSelection();
            const span = editor.querySelector('span.mention[data-mention-id]');
            return {
                mentions: window.__instance.getMentions(),
                html: editor.innerHTML,
                text: editor.textContent,
                savedId: span?.dataset.mentionId ?? null,
                savedName: span?.dataset.mentionName ?? null,
                spanText: span?.textContent ?? null,
                caret: { node: sel.anchorNode?.nodeName, offset: sel.anchorOffset },
                focus: document.activeElement?.id,
            };
        `);
        beforeTriggerCases.push({ caretKind, initial, afterSpace, afterTyping });
    }
    assert(beforeTriggerCases.every((c) =>
        c.afterSpace.mentions.length === 1 &&
        c.afterSpace.mentions[0].id === '1'
    ), 'Inserting a space before a committed mention loses the mention: ' +
        JSON.stringify(beforeTriggerCases));
    assert(beforeTriggerCases.every((c) =>
        c.afterTyping.mentions.length === 1 &&
        c.afterTyping.mentions[0].id === '1' &&
        c.afterTyping.savedId === '1' &&
        c.afterTyping.savedName === 'Anna Ivanova' &&
        c.afterTyping.spanText === '@Anna Ivanova' &&
        /^[\s\u00A0]x@Anna Ivanova/u.test(c.afterTyping.text)
    ), 'Typing before the trigger invalidates the committed mention: ' +
        JSON.stringify(beforeTriggerCases));


    // Adjacent committed mentions, selected prefixes, and formatted paste:
    // mutating surrounding text must not invalidate unrelated IDs.
    const adjacencyCases = [];
    for (const scenario of ['between-mentions', 'replace-prefix-selection', 'native-insert-html', 'before-mention-enter']) {
        await request(base + '/url', 'POST', { url: fixtureUrl });
        const initial = await execute(`
            const editor = document.getElementById('editor');
            editor.focus();
            window.__boundaryEvents = [];
            for (const eventName of ['beforeinput', 'input', 'paste', 'compositionstart']) {
                editor.addEventListener(eventName, (event) => {
                    const selection = window.getSelection();
                    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
                    window.__boundaryEvents.push({
                        name: eventName,
                        type: event.inputType || null,
                        data: event.data || null,
                        cancelable: event.cancelable,
                        container: range?.startContainer?.nodeName ?? null,
                        offset: range?.startOffset ?? null,
                        html: editor.innerHTML,
                    });
                }, { capture: true });
            }
            window.__instance = new MentionJS(editor);
            if (arguments[0] === 'between-mentions') {
                window.__instance.push({ id: 'left', name: 'Alice' });
                window.__instance.push({ id: 'right', name: 'Bob' });
                const first = editor.querySelector('span.mention');
                const second = editor.querySelectorAll('span.mention')[1];
                const sel = window.getSelection(), range = document.createRange();
                range.setStartBefore(second);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            } else {
                window.__instance.push({ id: 'right', name: 'Bob' });
                const span = editor.querySelector('span.mention');
                if (arguments[0] === 'replace-prefix-selection') {
                    span.before(document.createTextNode('hello'));
                    const range = document.createRange();
                    range.setStart(span.previousSibling, 2);
                    range.setEnd(span.previousSibling, 5);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                } else {
                    const sel = window.getSelection(), range = document.createRange();
                    range.setStart(editor, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            return { html: editor.innerHTML, selection: window.getSelection().toString() };
        `, [scenario]);
        if (scenario === 'between-mentions') {
            await sendKeys('xy');
        } else if (scenario === 'replace-prefix-selection') {
            await sendKeys('z');
        } else if (scenario === 'before-mention-enter') {
            await sendKeys('\uE007'); // Enter at caret before mention
        } else {
            // execCommand exercises a browser-owned rich HTML insertion path
            // (similar to a formatted paste) without mocking a DOM mutation.
            const supported = await execute(`
                return document.execCommand('insertHTML', false, '<em>hello</em>');
            `);
            if (!supported) {
                adjacencyCases.push({ scenario, skipped: 'execCommand unsupported' });
                continue;
            }
        }
        const result = await execute(`
            const editor = document.getElementById('editor');
            const spans = [...editor.querySelectorAll('span.mention[data-mention-id]')];
            return {
                html: editor.innerHTML,
                text: editor.textContent,
                mentions: window.__instance.getMentions(),
                spans: spans.map(span => ({
                    id: span.dataset.mentionId,
                    name: span.dataset.mentionName,
                    text: span.textContent,
                })),
                selectionText: window.getSelection().toString(),
                events: window.__boundaryEvents,
            };
        `);
        adjacencyCases.push({ scenario, initial, result });
    }
    assert(adjacencyCases.every(({ scenario, skipped, result }) => {
        if (skipped) return true;
        if (scenario === 'native-insert-html') {
            // execCommand('insertHTML') does not dispatch beforeinput.
            // Firefox keeps the adjacent mention span intact; Chrome edits
            // inside its span and conservatively invalidates the changed ID.
            // Either outcome is safe: no stale ID may refer to changed text.
            return (
                result.mentions.length === 1 &&
                result.spans.length === 1 &&
                result.spans[0].id === 'right' &&
                result.spans[0].text === '@Bob'
            ) || (result.mentions.length === 0 && result.spans.length === 0);
        }
        return result.mentions.length === (scenario === 'between-mentions' ? 2 : 1) &&
            result.spans.every(s => s.text === '@' + s.name) &&
            result.spans.length === (scenario === 'between-mentions' ? 2 : 1) &&
            result.mentions.some(s => s.id === 'right' && s.name === 'Bob') &&
            (scenario !== 'between-mentions' ||
                result.mentions.some(s => s.id === 'left' && s.name === 'Alice')) &&
            (scenario !== 'before-mention-enter' || result.html.includes('<br>'));
    }), 'Editing adjacent to saved mentions corrupted identity: ' + JSON.stringify(adjacencyCases));


    // Pending search must be canceled on caret movement even before the first
    // dropdown mounts. Input host remains focused throughout this scenario.
    await request(base + '/url', 'POST', { url: fixtureUrl });
    await execute(`
        const editor = document.getElementById('editor');
        editor.textContent = 'tail';
        editor.focus();
        const sel = window.getSelection(), range = document.createRange();
        range.setStart(editor.firstChild, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        window.__pendingSearchResolve = null;
        window.__pendingSearchSignal = null;
        window.__instance = new MentionJS(editor, {
            provideSearchContext: true,
            searchFunction(query, page, context) {
                window.__pendingSearchSignal = context.signal;
                return new Promise(resolve => window.__pendingSearchResolve = resolve);
            },
        });
    `);
    await sendKeys('@');
    await waitFor(
        () => execute("return typeof window.__pendingSearchResolve === 'function'"),
        Boolean, 'Pending search not started before caret movement'
    );
    await execute(`
        const editor = document.getElementById('editor');
        const tail = editor.lastChild;
        const sel = window.getSelection(), range = document.createRange();
        range.setStart(tail, tail.textContent.length);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
    `);
    const abortedOnCaretMove = await execute(`
        return {
            aborted: window.__pendingSearchSignal.aborted,
            active: !!document.querySelector('#editor span.mention.active'),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    await execute("window.__pendingSearchResolve([{ id: 55, name: 'Stale' }]);");
    await sleep(250);
    const staleCaretResults = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            active: !!editor.querySelector('span.mention.active'),
            dropdown: !!document.querySelector('.mention-dropdown'),
            focused: document.activeElement?.id,
            aborted: window.__pendingSearchSignal.aborted,
        };
    `);
    assert(abortedOnCaretMove.aborted && !staleCaretResults.active &&
        !staleCaretResults.dropdown && staleCaretResults.focused === 'editor',
        'Pending search outlived its caret: ' + JSON.stringify({
            abortedOnCaretMove, staleCaretResults,
        }));


    // Native undo/redo must retain the mention while reversing text typed
    // immediately before it. Probe a selection-only native edit separately,
    // without using that probe as the test oracle.
    const boundaryUndoCases = [];
    for (const mode of ['current', 'native-reposition', 'exec-empty', 'exec-nbsp', 'exec-zwsp', 'native-prefilled']) {
        await request(base + '/url', 'POST', { url: fixtureUrl });
        await execute(`
            const editor = document.getElementById('editor');
            editor.focus();
            window.__instance = new MentionJS(editor);
            window.__instance.push({ id: 'persist', name: 'Bob' });
            const range = document.createRange(), sel = window.getSelection();
            range.setStart(editor, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            if (arguments[0] === 'native-reposition') {
                // Diagnostic: could the browser own the edit and undo stack
                // if caret were moved to an adjacent text node before input?
                window.__instance._insertTextBeforeCommittedMention = (e) => {
                    if (e.inputType !== 'insertText') return false;
                    const span = editor.querySelector('span.mention');
                    const textNode = document.createTextNode('');
                    span.before(textNode);
                    const r = document.createRange();
                    r.setStart(textNode, 0);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                    return false;
                };
            }
            if (arguments[0] === 'native-prefilled' ||
                arguments[0].startsWith('exec-')) {
                const mode = arguments[0];
                window.__instance._insertTextBeforeCommittedMention = (e) => {
                    if (e.inputType !== 'insertText' || window.__execInProgress) return false;
                    const span = editor.querySelector('span.mention');
                    const sentinel = mode === 'exec-nbsp' ? '\u00A0' :
                        mode === 'exec-zwsp' ? '\u200B' :
                        mode === 'native-prefilled' ? '~' : '';
                    const node = document.createTextNode(sentinel);
                    span.before(node);
                    const r = document.createRange();
                    r.setStart(node, 0);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                    window.__boundarySentinel = node;
                    window.__sentinelValue = sentinel;
                    if (mode === 'native-prefilled') return false;
                    e.preventDefault();
                    window.__execInProgress = true;
                    try {
                        window.__execOk = document.execCommand('insertText', false, e.data);
                    } catch (err) {
                        window.__execError = String(err);
                    } finally {
                        window.__execInProgress = false;
                    }
                    return true;
                };
            }
        `, [mode]);
        const state = () => execute(`
            const editor = document.getElementById('editor');
            return {
                text: editor.textContent,
                html: editor.innerHTML,
                mentions: window.__instance.getMentions(),
            };
        `);
        await sendKeys('x');
        await execute(`
            const node = window.__boundarySentinel;
            const value = window.__sentinelValue;
            if (value && node?.isConnected) {
                const index = node.textContent.indexOf(value);
                if (index >= 0) node.deleteData(index, value.length);
            }
        `);
        const inserted = await state();
        await sendKeys('\uE009z\uE000');
        const undone = await state();
        await sendKeys('\uE009\uE008z\uE000');
        const redone = await state();
        const probeInfo = await execute("return { execOk: window.__execOk ?? null, execError: window.__execError ?? null, sentinel: window.__boundarySentinel?.textContent ?? null };");
        boundaryUndoCases.push({ mode, inserted, undone, redone, probeInfo });
    }
    const undoCurrent = boundaryUndoCases.find(c => c.mode === 'current');
    assert(undoCurrent.inserted.text.startsWith('x@Bob') &&
        undoCurrent.inserted.mentions.length === 1 &&
        !undoCurrent.undone.text.startsWith('x@Bob') &&
        undoCurrent.undone.mentions.length === 1 &&
        undoCurrent.redone.text.startsWith('x@Bob') &&
        undoCurrent.redone.mentions.length === 1,
        'Native undo/redo after typing before mention is broken: ' +
        JSON.stringify(boundaryUndoCases));

    await execute('window.__browserSmokePassed = true; return true;');
    console.log(`MentionJS ${BROWSER} ${BUNDLE} smoke tests passed`);
} catch (error) {
    console.error(error);
    console.error(driverOutput);
    process.exitCode = 1;
} finally {
    if (sessionId) {
        try {
            await request(`/session/${sessionId}`, 'DELETE');
        } catch (_) {}
    }
    driver.kill('SIGTERM');
}
