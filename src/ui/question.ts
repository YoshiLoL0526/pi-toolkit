import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import type { AskConfig, AskOutcome, AskRequest, AskResponse } from "../types.js";

const MAX_CONTEXT_LINES = 8;

const CHECKED = "[x]";
const UNCHECKED = "[ ]";

/**
 * TUI prompt.
 *
 * Single question: options list with an inline editor for free text.
 * Batch: one page per question plus a review page, navigated with tab/arrows.
 * Multi-select: space toggles, Enter submits the checked set.
 */
export async function askInTui(
	request: AskRequest,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskOutcome> {
	const questions = request.questions;
	const isBatch = questions.length > 1;
	const reviewTab = questions.length;

	if (signal?.aborted) return { responses: questions.map(() => null), cancelled: true };

	return ctx.ui.custom<AskOutcome>(
		(tui, theme, _keybindings, done) => {
			let currentTab = 0;
			let optionIndex = 0;
			let editMode = questions[0]?.options.length === 0;
			let editTarget: number | null = editMode ? 0 : null;
			let validationHint: string | null = null;
			let submitWarned = false;
			let focused = true;
			let finished = false;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const checked = questions.map(() => new Set<number>());
			const freeText = new Map<number, string>();
			const responses: (AskResponse | null)[] = questions.map(() => null);

			function detach() {
				signal?.removeEventListener("abort", onAbort);
			}

			function finish(outcome: AskOutcome) {
				if (finished) return;
				finished = true;
				detach();
				done(outcome);
			}

			function onAbort() {
				cancel();
			}

			function cancel() {
				finish({ responses: questions.map(() => null), cancelled: true });
			}

			function submit() {
				finish({ responses: [...responses], cancelled: false });
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

			signal?.addEventListener("abort", onAbort);

			function invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			}

			function refresh() {
				invalidate();
				tui.requestRender();
			}

			function questionAt(index: number): AskConfig | undefined {
				return questions[index];
			}

			function freeformIndex(question: AskConfig): number {
				return question.allowFreeform ? question.options.length : -1;
			}

			function rowCount(question: AskConfig): number {
				return question.options.length + (question.allowFreeform ? 1 : 0);
			}

			function isReview(): boolean {
				return isBatch && currentTab === reviewTab;
			}

			function allAnswered(): boolean {
				return responses.every((response) => response !== null);
			}

			function unansweredCount(): number {
				return responses.filter((response) => response === null).length;
			}

			function openEditor(index: number) {
				editMode = true;
				editTarget = index;
				validationHint = null;
				editor.setText(freeText.get(index) ?? "");
				refresh();
			}

			function closeEditor() {
				editMode = false;
				editTarget = null;
				editor.setText("");
				refresh();
			}

			function goToTab(index: number) {
				currentTab = index;
				optionIndex = 0;
				validationHint = null;
				const question = questionAt(index);
				if (question && question.options.length === 0) {
					openEditor(index);
					return;
				}
				editMode = false;
				editTarget = null;
				editor.setText("");
				refresh();
			}

			function nextTab(delta: number) {
				const count = questions.length + 1;
				goToTab((currentTab + delta + count) % count);
			}

			function record(index: number, response: AskResponse) {
				responses[index] = response;
				validationHint = null;
				submitWarned = false;
			}

			function advance(from: number) {
				if (!isBatch) {
					submit();
					return;
				}
				for (let step = 1; step <= questions.length; step++) {
					const index = (from + step) % questions.length;
					if (responses[index] === null) {
						goToTab(index);
						return;
					}
				}
				goToTab(reviewTab);
			}

			function pickSingle(index: number, option: number) {
				const question = questionAt(index);
				if (!question) return;
				if (option === freeformIndex(question)) {
					openEditor(index);
					return;
				}
				const choice = question.options[option];
				if (!choice) return;
				record(index, { kind: "selection", labels: [choice.label], indexes: [option + 1] });
				advance(index);
			}

			function toggle(index: number, option: number) {
				const set = checked[index];
				if (!set) return;
				if (set.has(option)) set.delete(option);
				else set.add(option);
				validationHint = null;
				refresh();
			}

			function commitMultiple(index: number) {
				const question = questionAt(index);
				const set = checked[index];
				if (!question || !set) return;

				const options = [...set].sort((a, b) => a - b).filter((i) => question.options[i]);
				const labels = options.map((i) => question.options[i]?.label ?? "");
				const indexes = options.map((i) => i + 1);
				const text = freeText.get(index);

				if (labels.length === 0 && !text) {
					validationHint = "Select at least one option, or type an answer.";
					refresh();
					return;
				}

				record(
					index,
					labels.length > 0
						? { kind: "selection", labels, indexes, ...(text ? { text } : {}) }
						: { kind: "freeform", text: text ?? "" },
				);
				advance(index);
			}

			editor.onSubmit = (value) => {
				const index = editTarget;
				if (index === null) return;
				const text = value.trim();
				if (!text) {
					closeEditor();
					return;
				}

				freeText.set(index, text);
				editMode = false;
				editTarget = null;
				editor.setText("");

				const question = questionAt(index);
				if (question?.allowMultiple) {
					validationHint = null;
					refresh();
					return;
				}

				record(index, { kind: "freeform", text });
				advance(index);
			};

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						closeEditor();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (isReview()) {
					if (matchesKey(data, Key.enter)) {
						if (!allAnswered() && !submitWarned) {
							submitWarned = true;
							refresh();
							return;
						}
						submit();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						cancel();
						return;
					}
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						nextTab(1);
						return;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						nextTab(-1);
						return;
					}
					if (/^[1-9]$/.test(data)) {
						const index = Number(data) - 1;
						if (index < questions.length) goToTab(index);
					}
					return;
				}

				const question = questionAt(currentTab);
				if (!question) return;
				const rows = rowCount(question);

				if (isBatch) {
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						nextTab(1);
						return;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						nextTab(-1);
						return;
					}
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = rows ? (optionIndex - 1 + rows) % rows : 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = rows ? (optionIndex + 1) % rows : 0;
					refresh();
					return;
				}

				const onFreeform = optionIndex === freeformIndex(question);

				if (onFreeform && matchesKey(data, Key.space)) {
					openEditor(currentTab);
					return;
				}
				if (onFreeform && matchesKey(data, Key.enter)) {
					// In multi-select, Enter commits the written answer; space reopens the editor.
					if (question.allowMultiple && freeText.has(currentTab)) commitMultiple(currentTab);
					else openEditor(currentTab);
					return;
				}

				if (matchesKey(data, Key.space)) {
					if (question.allowMultiple) toggle(currentTab, optionIndex);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (question.allowMultiple) commitMultiple(currentTab);
					else pickSingle(currentTab, optionIndex);
					return;
				}

				if (matchesKey(data, Key.escape)) {
					cancel();
					return;
				}

				// Digit quick-pick: single-select picks, multi-select toggles, the free-form digit opens the editor.
				if (/^[1-9]$/.test(data)) {
					const index = Number(data) - 1;
					if (index < question.options.length) {
						if (question.allowMultiple) toggle(currentTab, index);
						else pickSingle(currentTab, index);
					} else if (index === freeformIndex(question)) {
						optionIndex = index;
						openEditor(currentTab);
					}
				}
			}

			function renderTabBar(width: number): string[] {
				const parts: string[] = [theme.fg("dim", " ← ")];
				questions.forEach((question, i) => {
					const active = i === currentTab;
					const answered = responses[i] !== null;
					const box = answered ? "■" : "□";
					const text = ` ${box} ${question.label ?? `Q${i + 1}`} `;
					const style = active
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(answered ? "success" : "muted", text);
					parts.push(`${style} `);
				});
				const reviewActive = currentTab === reviewTab;
				const reviewText = " ✓ Submit ";
				const reviewStyle = reviewActive
					? theme.bg("selectedBg", theme.fg("text", reviewText))
					: theme.fg(allAnswered() ? "success" : "dim", reviewText);
				parts.push(`${reviewStyle}${theme.fg("dim", "→")}`);

				const lines: string[] = [];
				const renderWidth = Math.max(1, width);
				const wrapped = wrapTextWithAnsi(parts.join(""), Math.max(1, renderWidth - 1));
				wrapped.forEach((line) => lines.push(` ${line}`));
				return lines;
			}

			function renderReview(width: number): string[] {
				const lines: string[] = [];
				const pushWrapped = (text: string) => lines.push(...wrapTextWithAnsi(text, width));

				pushWrapped(theme.fg("accent", theme.bold("Review your answers")));
				lines.push("");

				questions.forEach((question, i) => {
					const label = question.label ?? `Q${i + 1}`;
					const response = responses[i] ?? null;
					pushWrapped(`${theme.fg("accent", label)} ${theme.fg("muted", question.question)}`);
					if (response) {
						pushWrapped(`  ${theme.fg("success", "✓")} ${theme.fg("text", summarize(response))}`);
					} else {
						pushWrapped(`  ${theme.fg("warning", "— not answered")}`);
					}
					lines.push("");
				});

				if (!allAnswered()) {
					const missing = unansweredCount();
					const message = submitWarned
						? `Press Enter again to submit; ${missing} unanswered question${missing === 1 ? "" : "s"} will be skipped.`
						: `${missing} question${missing === 1 ? "" : "s"} still unanswered.`;
					pushWrapped(theme.fg("warning", message));
				} else {
					pushWrapped(theme.fg("success", "Press Enter to submit."));
				}

				return lines;
			}

			function summarize(response: AskResponse): string {
				if (response.kind === "freeform") return response.text;
				const labels = response.labels.map((label, i) => {
					const index = response.indexes[i];
					return index ? `${index}. ${label}` : label;
				});
				const base = labels.join(", ");
				return response.text ? `${base} — also wrote: ${response.text}` : base;
			}

			function renderQuestion(width: number): string[] {
				const question = questionAt(currentTab);
				if (!question) return [];

				const lines: string[] = [];
				const pushWrapped = (text: string) => lines.push(...wrapTextWithAnsi(text, width));
				const pushPrefixed = (prefix: string, text: string) => {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= width) {
						pushWrapped(prefix + text);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
					const continuation = " ".repeat(prefixWidth);
					wrapped.forEach((line, i) => {
						lines.push(`${i === 0 ? prefix : continuation}${line}`);
					});
				};

				if (question.context) {
					const contextLines = wrapTextWithAnsi(question.context, Math.max(1, width - 2));
					for (const line of contextLines.slice(0, MAX_CONTEXT_LINES)) {
						lines.push(` ${theme.fg("muted", line)}`);
					}
					if (contextLines.length > MAX_CONTEXT_LINES) {
						const hidden = contextLines.length - MAX_CONTEXT_LINES;
						lines.push(` ${theme.fg("dim", `… ${hidden} more context line${hidden === 1 ? "" : "s"}`)}`);
					}
					lines.push("");
				}

				pushWrapped(theme.bold(theme.fg("text", question.question)));
				lines.push("");

				const set = checked[currentTab] ?? new Set<number>();
				question.options.forEach((option, i) => {
					const highlighted = !editMode && i === optionIndex;
					const prefix = highlighted ? theme.fg("accent", "> ") : "  ";
					const box = question.allowMultiple ? `${set.has(i) ? CHECKED : UNCHECKED} ` : "";
					const color = highlighted || set.has(i) ? "accent" : "text";
					pushPrefixed(prefix, theme.fg(color, `${box}${i + 1}. ${option.label}`));
					if (option.description) {
						pushPrefixed("       ", theme.fg("muted", option.description));
					}
				});

				if (question.allowFreeform && question.options.length > 0) {
					const index = freeformIndex(question);
					const highlighted = editMode || optionIndex === index;
					const prefix = highlighted ? theme.fg("accent", "> ") : "  ";
					const hasText = freeText.has(currentTab);
					const box = question.allowMultiple ? `${hasText ? CHECKED : UNCHECKED} ` : "";
					const marker = editMode ? " ✎" : "";
					pushPrefixed(
						prefix,
						theme.fg(highlighted || hasText ? "accent" : "text", `${box}${index + 1}. Type something.${marker}`),
					);
					const written = freeText.get(currentTab);
					if (written) pushPrefixed("       ", theme.fg("muted", written));
				}

				if (editMode) {
					lines.push("");
					pushPrefixed(" ", theme.fg("muted", "Your answer:"));
					for (const line of editor.render(Math.max(1, width - 2))) {
						lines.push(` ${line}`);
					}
				}

				return lines;
			}

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;

				const w = Math.max(1, width);
				const lines: string[] = [];

				editor.focused = focused && editMode;

				lines.push(theme.fg("accent", "─".repeat(w)));

				if (request.heading) {
					lines.push(...wrapTextWithAnsi(` ${theme.fg("accent", theme.bold(request.heading))}`, w));
					lines.push("");
				}

				if (isBatch) {
					lines.push(...renderTabBar(w));
					lines.push("");
				}

				if (isReview()) {
					lines.push(...renderReview(w));
				} else {
					lines.push(...renderQuestion(w));
				}

				lines.push("");
				const batchHint = isBatch ? "tab/←→ switch • " : "";
				let hint: string;
				if (editMode) {
					hint = "Enter to submit • Esc to go back";
				} else if (isReview()) {
					hint = `Enter to submit • 1-${questions.length} jump to a question • Esc to cancel`;
				} else if (questionAt(currentTab)?.allowMultiple) {
					hint = `${batchHint}space toggles • ↑↓ move • 1-9 toggle • Enter to submit • Esc to cancel`;
				} else {
					hint = `${batchHint}↑↓ move • 1-9 quick pick • Enter to select • Esc to cancel`;
				}

				if (validationHint) {
					lines.push(...wrapTextWithAnsi(` ${theme.fg("warning", validationHint)}`, w));
				}
				lines.push(...wrapTextWithAnsi(` ${theme.fg("dim", hint)}`, w));
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
			blocked: {
				kind: "question",
				message: request.heading ?? questions[0]?.question ?? "Waiting for an answer",
			},
		},
	);
}
