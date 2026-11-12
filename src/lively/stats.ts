/**
 * Session usage totals for the footer.
 *
 * `getEntries()` copies the whole session, so totals are scanned once per
 * invalidation (turn end, compact, model change), never on every animated
 * frame. The cache lives in the extension, not in this module, so two sessions
 * cannot leak into each other.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Cache-read share of the latest prompt, when the provider reports it. */
	latestCacheHitRate?: number;
}

export interface StatsCache {
	get(ctx: ExtensionContext): TokenTotals;
	invalidate(): void;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: TokenTotals, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const data = usage as Record<string, unknown>;
	totals.input += number(data.input);
	totals.output += number(data.output);
	totals.cacheRead += number(data.cacheRead);
	totals.cacheWrite += number(data.cacheWrite);

	const cost = data.cost;
	if (cost && typeof cost === "object") {
		totals.cost += number((cost as Record<string, unknown>).total);
	}
}

/** Sums every usage-bearing entry, including the ones older than a compaction. */
export function collectTokenTotals(ctx: ExtensionContext): TokenTotals {
	const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				addUsage(totals, (message as { usage?: unknown }).usage);

				// The latest assistant message decides the hit rate, not the sum.
				const usage = (message as { usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } })
					.usage;
				if (usage) {
					const prompt =
						number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
					if (prompt > 0) totals.latestCacheHitRate = (number(usage.cacheRead) / prompt) * 100;
				}
			} else if (message.role === "toolResult") {
				addUsage(totals, (message as { usage?: unknown }).usage);
			}
		} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(totals, (entry as { usage?: unknown }).usage);
		}
	}

	return totals;
}

export function createStatsCache(): StatsCache {
	let cached: TokenTotals | undefined;

	return {
		get(ctx) {
			cached ??= collectTokenTotals(ctx);
			return cached;
		},
		invalidate() {
			cached = undefined;
		},
	};
}
