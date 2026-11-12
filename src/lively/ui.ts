/**
 * Thin components over the pure renderers.
 *
 * They own no state: the extension keeps one `LivelyState` and passes getters,
 * so the footer and the activity line can never disagree about the current run.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderActivityLine, renderFooterLines } from "./format.js";
import type { LivelySettings } from "./settings.js";
import type { StatsCache } from "./stats.js";
import type { LivelyState } from "./state.js";

export interface ActivityDeps {
	getState(): LivelyState;
	getSettings(): LivelySettings;
}

export function createActivityWidget(theme: Theme, deps: ActivityDeps): Component {
	return {
		render(width: number): string[] {
			const line = renderActivityLine(
				deps.getState(),
				theme,
				width,
				Date.now(),
				deps.getSettings().spinner,
			);
			return line ? [line] : [];
		},
		invalidate(): void {},
	};
}

export interface FooterDeps {
	getState(): LivelyState;
	getSettings(): LivelySettings;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	stats: StatsCache;
	getAutoCompact(): boolean;
	getActivityVisible(): boolean;
}

export function createFooter(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	deps: FooterDeps,
): Component & { dispose?(): void } {
	return {
		render(width: number): string[] {
			const state = deps.getState();
			const thinking =
				typeof deps.pi.getThinkingLevel === "function" ? deps.pi.getThinkingLevel() : deps.ctx.thinkingLevel;

			return renderFooterLines(
				{
					state,
					now: Date.now(),
					theme,
					style: deps.getSettings().spinner,
					totals: deps.stats.get(deps.ctx),
					context: deps.ctx.getContextUsage(),
					cwd: deps.ctx.cwd,
					home: process.env.HOME ?? process.env.USERPROFILE,
					branch: footerData.getGitBranch(),
					sessionName: typeof deps.pi.getSessionName === "function" ? deps.pi.getSessionName() : undefined,
					model: deps.ctx.model,
					thinking,
					providerCount: footerData.getAvailableProviderCount(),
					autoCompact: deps.getAutoCompact(),
					activity: deps.getActivityVisible(),
					statuses: footerData.getExtensionStatuses(),
				},
				width,
			);
		},
		invalidate(): void {},
	};
}
