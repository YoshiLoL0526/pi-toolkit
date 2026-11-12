/**
 * Turns a tool call's arguments into the short noun the activity line shows:
 * a file name, a command, a search term or a URL host.
 *
 * Pure and defensive: args arrive from the model and older sessions, so every
 * field is optional and no shape is assumed.
 */

const MAX_TARGET_LENGTH = 60;

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max = MAX_TARGET_LENGTH): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Last one or two path segments: `src/schema.ts` reads better than `schema.ts`. */
function shortPath(path: string): string {
	const parts = path.split(/[/\\]/).filter(Boolean);
	if (parts.length === 0) return path;
	return parts.slice(-2).join("/");
}

function urlHost(value: string): string | undefined {
	try {
		return new URL(value).host;
	} catch {
		return undefined;
	}
}

function questionTarget(args: Record<string, unknown>): string | undefined {
	const heading = firstString(args, ["heading", "question"]);
	if (heading) return truncate(collapse(heading));

	const questions = args.questions;
	if (!Array.isArray(questions)) return undefined;
	const first = questions[0];
	if (!first || typeof first !== "object") return undefined;
	const question = firstString(first as Record<string, unknown>, ["question"]);
	return question ? truncate(collapse(question)) : undefined;
}

function pathTarget(path: string): string {
	return truncate(collapse(shortPath(path)));
}

function commandTarget(command: string): string {
	return truncate(collapse(command.split(/\r?\n/)[0] ?? command));
}

function searchTarget(search: string): string {
	return truncate(collapse(search));
}

function urlTarget(url: string): string {
	return truncate(urlHost(url) ?? url);
}

export function describeTarget(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const data = args as Record<string, unknown>;

	if (toolName === "ask_user") return questionTarget(data);

	const path = firstString(data, [
		"file_path",
		"filePath",
		"file",
		"path",
		"notebook_path",
		"target_file",
	]);
	const command = firstString(data, ["command", "cmd", "script"]);
	const search = firstString(data, ["pattern", "query", "regex", "search", "claim"]);
	const url = firstString(data, ["url", "uri", "href"]);

	// The interesting noun depends on the tool: grep's path is a scope, its
	// pattern is the action, and a shell command beats an incidental path.
	switch (toolName) {
		case "bash":
		case "powershell":
			return command ? commandTarget(command) : path ? pathTarget(path) : undefined;
		case "grep":
		case "glob":
		case "find":
		case "web_search":
		case "source_check":
			return search ? searchTarget(search) : path ? pathTarget(path) : url ? urlTarget(url) : undefined;
		case "fetch_content":
			return url ? urlTarget(url) : search ? searchTarget(search) : path ? pathTarget(path) : undefined;
		default:
			return path
				? pathTarget(path)
				: command
					? commandTarget(command)
					: search
						? searchTarget(search)
						: url
							? urlTarget(url)
							: undefined;
	}
}
