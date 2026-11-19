import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildCharter, type EngineerCapabilities } from "../src/engineer/charter.js";
import { applyRole, detectCapabilities } from "../src/engineer/prompt.js";
import {
	defaultEngineerSettings,
	loadEngineerSettings,
	resolvePromptFile,
	type EngineerSettings,
} from "../src/engineer/settings.js";

const COMMANDS = ["on", "off", "status", "show", "init"] as const;

/** `getSystemPromptOptions` lives on command contexts only, so probe defensively. */
type OptionsContext = { getSystemPromptOptions?: () => BuildSystemPromptOptions };

function systemPromptOptions(ctx: ExtensionContext): BuildSystemPromptOptions | undefined {
	const fn = (ctx as OptionsContext).getSystemPromptOptions;
	return typeof fn === "function" ? fn.call(ctx) : undefined;
}

/**
 * A senior-engineer orchestrator role for the main session.
 *
 * `role` mode replaces only the identity head of Pi's rendered prompt and keeps
 * the generated tail (`<tools>`, `<rules>`, `<docs>`, project context, skills,
 * cwd) byte-for-byte. Every other mechanism was rejected: SYSTEM.md drops the
 * generated sections, APPEND_SYSTEM.md leaves the default identity in charge,
 * and a prompt section cannot replace the preamble.
 *
 * No tool, no transcript entries: the extension only shapes the prompt and
 * exposes a command.
 */
export default function engineerExtension(pi: ExtensionAPI) {
	/** `/engineer on|off` for the current session; undefined means "use the file". */
	let sessionEnabled: boolean | undefined;
	/** Distinct problems already reported in this session, never one per turn. */
	const warned = new Set<string>();

	const warnOnce = (ctx: ExtensionContext, message: string): void => {
		if (warned.has(message)) return;
		warned.add(message);
		ctx.ui.notify(message, "error");
	};

	const readSettings = (ctx: ExtensionContext): EngineerSettings => {
		try {
			return loadEngineerSettings();
		} catch (error) {
			warnOnce(ctx, `${(error as Error).message} (engineer role disabled)`);
			return { ...defaultEngineerSettings(), enabled: false };
		}
	};

	const isEnabled = (settings: EngineerSettings): boolean => sessionEnabled ?? settings.enabled;

	/**
	 * The user charter when it exists and is readable, otherwise null so the
	 * caller falls back to the built-in text. A missing file is normal; an empty
	 * or unreadable one is worth one notice.
	 */
	const readCharter = (
		ctx: ExtensionContext,
		settings: EngineerSettings,
	): { text: string | null; file: string; source: "file" | "built-in" } => {
		const file = resolvePromptFile(settings, getAgentDir());
		try {
			const text = readFileSync(file, "utf8");
			if (text.trim()) return { text, file, source: "file" };
			warnOnce(ctx, `pi-toolkit: ${file} is empty; using the built-in engineer charter`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				warnOnce(
					ctx,
					`pi-toolkit: cannot read ${file}: ${(error as Error).message}; using the built-in engineer charter`,
				);
			}
		}
		return { text: null, file, source: "built-in" };
	};

	const capabilitiesFrom = (ctx: ExtensionContext): EngineerCapabilities => {
		try {
			return detectCapabilities(systemPromptOptions(ctx));
		} catch {
			return { askUser: false, subagents: false };
		}
	};

	const userPromptActive = (ctx: ExtensionContext): boolean => {
		try {
			return Boolean(systemPromptOptions(ctx)?.customPrompt?.trim());
		} catch {
			return false;
		}
	};

	const describeTools = (capabilities: EngineerCapabilities): string => {
		const names = [
			capabilities.askUser ? "ask_user" : undefined,
			capabilities.subagents ? "subagent" : undefined,
		].filter(Boolean);
		return names.length > 0 ? names.join(", ") : "none";
	};

	const updateStatus = (ctx: ExtensionContext, settings: EngineerSettings): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus("engineer", `engineer: ${isEnabled(settings) ? "role" : "off"}`);
	};

	const statusText = (ctx: ExtensionCommandContext, settings: EngineerSettings): string => {
		const source = sessionEnabled === undefined ? "settings" : "session";
		const loaded = readCharter(ctx, settings);
		const capabilities = capabilitiesFrom(ctx);
		const lines = [
			`engineer role ${isEnabled(settings) ? "on" : "off"} (${source}) · source: ${loaded.source}`,
			`file: ${loaded.file} · tools: ${describeTools(capabilities)}`,
		];
		if (userPromptActive(ctx)) lines.push("SYSTEM.md is set: the charter is appended, not replaced");
		return lines.join("\n");
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionEnabled = undefined;
		warned.clear();
		updateStatus(ctx, readSettings(ctx));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus("engineer", undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const settings = readSettings(ctx);
		if (!isEnabled(settings)) return;

		const capabilities = detectCapabilities(event.systemPromptOptions);
		const loaded = readCharter(ctx, settings);
		const charter = loaded.text ?? buildCharter(capabilities);
		const result = applyRole(event.systemPrompt, charter, {
			userPrompt: Boolean(event.systemPromptOptions.customPrompt?.trim()),
		});

		if (result.applied === "unchanged") return;
		return { systemPrompt: result.prompt };
	});

	pi.registerCommand("engineer", {
		description: "Senior-engineer orchestrator role for the system prompt (on, off, status, show, init)",
		getArgumentCompletions(prefix) {
			return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
			}));
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const action = parts[0] ?? "";
			const settings = readSettings(ctx);
			const file = resolvePromptFile(settings, getAgentDir());

			if (!action || action === "status") {
				ctx.ui.notify(statusText(ctx, settings), "info");
				return;
			}

			if (action === "on" || action === "off") {
				sessionEnabled = action === "on";
				updateStatus(ctx, settings);
				ctx.ui.notify(`engineer role ${action} for this session; takes effect on the next turn`, "info");
				return;
			}

			if (action === "show") {
				const loaded = readCharter(ctx, settings);
				const charter = loaded.text ?? buildCharter(capabilitiesFrom(ctx));
				const preview = charter.slice(0, 1200);
				const tail = charter.length > preview.length ? "\n[... truncated]" : "";
				ctx.ui.notify(`${loaded.source}: ${loaded.file}\n\n${preview}${tail}`, "info");
				return;
			}

			if (action === "init") {
				if (existsSync(file) && !parts.includes("--force")) {
					ctx.ui.notify(`${file} already exists; use /engineer init --force to overwrite it`, "error");
					return;
				}

				// The file is used verbatim, so an older host without prompt options
				// gets the complete charter and the user trims what does not apply.
				let capabilities: EngineerCapabilities = { askUser: true, subagents: true };
				try {
					capabilities = detectCapabilities(ctx.getSystemPromptOptions());
				} catch {
					// Keep the complete charter.
				}

				const charter = buildCharter(capabilities);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, charter);
				ctx.ui.notify(
					`wrote ${file} (${charter.length} chars); edit it and the change applies on the next turn`,
					"info",
				);
				return;
			}

			ctx.ui.notify(`unknown action: ${action} · use ${COMMANDS.join("|")}`, "error");
		},
	});
}
