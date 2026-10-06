/**
 * MentionJS v1.0.0
 * Lightweight @-mention autocomplete for textarea and contenteditable
 */

declare namespace MentionJS {
    interface MentionItem {
        id: string | number;
        name: string;
        avatar?: string;
        details?: string;
        [key: string]: unknown;
    }

    interface SearchResult {
        items: MentionItem[];
        nextPageUrl?: string | null;
    }

    type SearchFunction = (
        query: string,
        nextPageUrl?: string | null
    ) => Promise<SearchResult | MentionItem[]>;

    type RenderItemFunction = (
        data: MentionItem,
        index: number,
        isActive: boolean
    ) => HTMLElement | null | undefined;

    type RenderNoResultsFunction = (
        noResultsText: string
    ) => HTMLElement | null | undefined;

    type RenderLoadingFunction = () => HTMLElement | null | undefined;

    interface MentionJSOptions {
        /** Exactly one non-whitespace Unicode grapheme. */
        trigger?: string;
        searchFunction?: SearchFunction | null;
        /** Non-negative finite delay in milliseconds. */
        debounceDelay?: number;
        noResultsText?: string;
        dropdownClass?: string;
        onMentionSelect?: ((data: { id: string | number; name: string }) => void) | null;
        renderItem?: RenderItemFunction | null;
        renderNoResults?: RenderNoResultsFunction | null;
        renderLoading?: RenderLoadingFunction | null;
    }

    interface TextareaMention {
        id: string | number;
        name: string;
        start: number;
        end: number;
    }

    interface ContentEditableMention {
        id: string;
        name: string;
    }
}

declare class MentionJS {
    constructor(element: HTMLElement, options?: MentionJS.MentionJSOptions);

    /** Returns all committed mentions. */
    getMentions(): MentionJS.TextareaMention[] | MentionJS.ContentEditableMention[];

    /** Programmatically insert a mention at the current cursor / end of field. */
    push(data: { id: string | number; name: string }): void;

    /** Clear all content and committed mentions. */
    clear(): void;

    /** Tear down all event listeners and remove the dropdown. */
    destroy(): void;

    static create(element: HTMLElement, options?: MentionJS.MentionJSOptions): MentionJS;
}

export = MentionJS;
