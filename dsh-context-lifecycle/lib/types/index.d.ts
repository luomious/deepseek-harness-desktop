/**
 * @dsh-external/dsh-context-lifecycle
 *
 * Token-saving context lifecycle manager for DSH.
 *
 * Watches every live agent's request pressure (via ctx.tokenMeter) and, when
 * the context grows expensive, asks the user — through a client banner — to
 * confirm one of two recovery actions:
 *
 *   compact      → ctx.compaction.compactNow (same path as /compact)
 *   new-session  → deterministic handover extraction (task, progress, files,
 *                  todos) that the user pastes into a fresh conversation
 *
 * Design rules:
 *  1. User confirms every action — the plugin recommends, never acts alone.
 *  2. Zero model-context cost: registers no tools, only a webServer route and
 *     slot-based client banner.
 *  3. Fail-safe: every observer/handler is wrapped; measurement or action
 *     failures degrade to "no suggestion".
 *  4. Anti-nag: per-session cooldown, dismissal memory, minimum session size.
 */
export declare const name = "@dsh-external/dsh-context-lifecycle";
export declare const inject: string[];
interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    arguments?: unknown;
    [key: string]: unknown;
}
interface MessageLike {
    role: string;
    content: ContentBlock[];
    source?: {
        kind?: string;
        [key: string]: unknown;
    };
}
export interface Config {
    /** Suggest compact at or above this fraction of the context window. */
    softRatio: number;
    /** Suggest a new session at or above this fraction. */
    hardRatio: number;
    /** Do not re-suggest within this window after the last suggestion. */
    cooldownMinutes: number;
    /** Ignore sessions below this pressure (tokens) — not worth interrupting. */
    minTokens: number;
    /** Context window fallback when no routed request logged one. */
    fallbackContextWindow: number;
    /** Pressure poll interval for live agents. */
    pollMs: number;
}
export type Suggestion = 'none' | 'compact' | 'new-session';
export interface DecisionInput {
    tokens: number;
    window: number;
    /** Whether THIS manager already compacted this session once. */
    compactedByUs: boolean;
    /** Approximate conversational activity (surface events). */
    eventCount: number;
}
export interface Decision {
    suggestion: Suggestion;
    ratio: number;
    reason: string;
}
/**
 * Decide what the user should be asked to confirm.
 *
 * - Too small to matter           → none
 * - Below soft threshold          → none
 * - Already compacted by us and pressure returned → new-session
 *   (compaction alone cannot keep up; every further round re-pays the tail)
 * - At/above hard threshold       → new-session
 * - Between soft and hard         → compact
 */
export declare function decideSuggestion(input: DecisionInput, config: Config): Decision;
export interface Handover {
    task: string;
    progress: string;
    files: string[];
    todos: string[];
    markdown: string;
}
export declare function extractHandover(messages: MessageLike[]): Handover;
export declare function apply(ctx: any, rawConfig?: Partial<Config>): void;
export {};
