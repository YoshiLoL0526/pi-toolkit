import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import type { AskConfig, AskUiResult } from "../types.js";

const MAX_CONTEXT_LINES = 8;

/**
 * Single question with an options list and an inline editor for free text.
 * Escape in the editor goes back to the list; Escape in the list cancels.
 */
export async function askInTui(
	config: AskConfig,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskUiResult> {
	if (signal?.aborted) return null;

	const options = config.options;
	const freeformIndex = config.allowFreeform ? options.length : -1;
	const rowCount = options.length + (config.allowFreeform ? 1 : 0);

	return ctx.ui.custom<AskUiResult>(
		(tui, theme, _keybindings, done) => {
			let optionIndex = 0;
			// No options means an open question: start typing immediately.
			let editMode = options.length === 0;
			let focused = true;
			let finished = false;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			function detach() {
				signal?.removeEventListener("abort", onAbort);
			}

			function finish(result: AskUiResult) {
				if (finished) return;
				finished = true;
				detach();
				done(result);
			}

			function onAbort() {
				finish(null);
			}

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (trimmed) {
					finish({ kind: "freeform", text: trimmed });
					return;
				}
				if (options.length > 0) {
					editMode = false;
					editor.setText("");
					refresh();
				}
			};

			signal?.addEventListener("abort", onAbort);

			function invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			}

			function refresh() {
				invalidate();
				tui.requestRender();
			}

			function select(index: number) {
				const option = options[index];
				if (!option) return;
				finish({ kind: "selection", label: option.label, index: index + 1 });
			}

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						if (options.length > 0) {
							editMode = false;
							editor.setText("");
							refresh();
						} else {
							finish(null);
						}
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
					optionIndex = (optionIndex - 1 + rowCount) % rowCount;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
					optionIndex = (optionIndex + 1) % rowCount;
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (optionIndex === freeformIndex) {
						editMode = true;
						refresh();
					} else {
						select(optionIndex);
					}
					return;
				}

				if (matchesKey(data, Key.escape)) {
					finish(null);
					return;
				}

				// Digit quick-pick: 1-9 selects an option, the next digit opens the editor.
				if (/^[1-9]$/.test(data)) {
					const picked = Number(data) - 1;
					if (picked < options.length) {
						select(picked);
					} else if (picked === freeformIndex) {
						optionIndex = freeformIndex;
						editMode = true;
						refresh();
					}
				}
			}

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;

				const w = Math.max(1, width);
				const lines: string[] = [];

				const pushWrapped = (text: string) => {
					lines.push(...wrapTextWithAnsi(text, w));
				};
				const pushPrefixed = (prefix: string, text: string) => {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= w) {
						pushWrapped(prefix + text);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
					const continuation = " ".repeat(prefixWidth);
					wrapped.forEach((line, i) => {
						lines.push(`${i === 0 ? prefix : continuation}${line}`);
					});
				};

				editor.focused = focused && editMode;

				lines.push(theme.fg("accent", "─".repeat(w)));

				if (config.context) {
					const contextLines = wrapTextWithAnsi(config.context, Math.max(1, w - 2));
					for (const line of contextLines.slice(0, MAX_CONTEXT_LINES)) {
						lines.push(` ${theme.fg("muted", line)}`);
					}
					if (contextLines.length > MAX_CONTEXT_LINES) {
						const hidden = contextLines.length - MAX_CONTEXT_LINES;
						lines.push(` ${theme.fg("dim", `… ${hidden} more context line${hidden === 1 ? "" : "s"}`)}`);
					}
					lines.push("");
				}

				pushWrapped(theme.bold(theme.fg("text", config.question)));
				lines.push("");

				options.forEach((option, i) => {
					const selected = !editMode && i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					pushPrefixed(prefix, theme.fg(selected ? "accent" : "text", `${i + 1}. ${option.label}`));
					if (option.description) {
						pushPrefixed("       ", theme.fg("muted", option.description));
					}
				});

				if (config.allowFreeform && options.length > 0) {
					const selected = editMode || optionIndex === freeformIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const marker = editMode ? " ✎" : "";
					pushPrefixed(
						prefix,
						theme.fg(selected ? "accent" : "text", `${freeformIndex + 1}. Type something.${marker}`),
					);
				}

				if (editMode) {
					lines.push("");
					pushPrefixed(" ", theme.fg("muted", "Your answer:"));
					for (const line of editor.render(Math.max(1, w - 2))) {
						lines.push(` ${line}`);
					}
				}

				lines.push("");
				const hint = editMode
					? options.length > 0
						? "Enter to submit • Esc to go back"
						: "Enter to submit • Esc to cancel"
					: "↑↓ or tab to move • 1-9 quick pick • Enter to select • Esc to cancel";
				pushPrefixed(" ", theme.fg("dim", hint));
				lines.push(theme.fg("accent", "─".repeat(w)));

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			const component: Component & Focusable & { dispose(): void } = {
				get focused() {
					return focused;
				},
				set focused(value: boolean) {
					focused = value;
				},
				render,
				handleInput,
				invalidate,
				dispose: detach,
			};

			return component;
		},
		{
			blocked: { kind: "question", message: config.question },
		},
	);
}
