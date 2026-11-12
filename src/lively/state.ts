/**
 * The activity state machine, kept free of timers and UI.
 *
 * The extension feeds events in and renders the result; tests can walk the whole
 * lifecycle without a terminal. Every function is pure and returns a new object,
 * so a render always reads one coherent snapshot.
 */

export type LivelyPhase = "idle" | "working" | "settled";
export type RunOutcome = "done" | "error" | "aborted";
/** What the model itself is doing; tools override this while one is active. */
export type ModelPhase = "waiting" | "thinking" | "responding" | "tools";

export interface ActiveTool {
	id: string;
	name: string;
	target?: string;
	startedAt: number;
}

export interface LastRun {
	outcome: RunOutcome;
	durationMs: number;
	tools: number;
}

export interface LivelyState {
	phase: LivelyPhase;
	/** Spinner frame index; advanced by the extension's animation timer. */
	frame: number;
	/** The latest assistant stream event, not a guess from the tool activity. */
	modelPhase: ModelPhase;
	runStartedAt?: number;
	runEndedAt?: number;
	outcome?: RunOutcome;
	/** Tools started in the current (or just finished) run. */
	tools: number;
	/** Parallel tool calls currently executing, in start order. */
	active: ActiveTool[];
	prompting: boolean;
	/** When the current blocking prompt opened, for a waiting-specific clock. */
	promptStartedAt?: number;
	/** Kept after the closing line clears, so an idle footer can show the last run. */
	lastRun?: LastRun;
}

export function initialState(): LivelyState {
	return {
		phase: "idle",
		frame: 0,
		modelPhase: "waiting",
		tools: 0,
		active: [],
		prompting: false,
	};
}

/** Starts a fresh run; the previous summary survives for the idle footer. */
export function startRun(state: LivelyState, now: number): LivelyState {
	return {
		phase: "working",
		frame: 0,
		modelPhase: "waiting",
		runStartedAt: now,
		tools: 0,
		active: [],
		prompting: false,
		...(state.lastRun ? { lastRun: state.lastRun } : {}),
	};
}

export function startTool(
	state: LivelyState,
	tool: { id: string; name: string; target?: string },
	now: number,
): LivelyState {
	return {
		...state,
		tools: state.tools + 1,
		active: [
			...state.active,
			{
				id: tool.id,
				name: tool.name,
				...(tool.target ? { target: tool.target } : {}),
				startedAt: now,
			},
		],
	};
}

/** Only the latest assistant stream event decides the label; same phase is a no-op. */
export function setModelPhase(state: LivelyState, modelPhase: ModelPhase): LivelyState {
	return state.modelPhase === modelPhase ? state : { ...state, modelPhase };
}

/** Opens or closes the waiting state; the clock starts on the first prompt only. */
export function setPrompting(state: LivelyState, prompting: boolean, now: number): LivelyState {
	if (!prompting) {
		const { promptStartedAt: _unused, ...rest } = state;
		return { ...rest, prompting: false };
	}

	return {
		...state,
		prompting: true,
		...(state.promptStartedAt === undefined ? { promptStartedAt: now } : {}),
	};
}

/** Removes a tool whether or not it was still active; parallel calls end out of order. */
export function endTool(state: LivelyState, id: string): LivelyState {
	return { ...state, active: state.active.filter((entry) => entry.id !== id) };
}

export function endRun(state: LivelyState, outcome: RunOutcome, now: number): LivelyState {
	const durationMs = state.runStartedAt === undefined ? 0 : Math.max(0, now - state.runStartedAt);
	const { promptStartedAt: _unused, ...rest } = state;

	return {
		...rest,
		phase: "settled",
		runEndedAt: now,
		outcome,
		active: [],
		prompting: false,
		lastRun: { outcome, durationMs, tools: state.tools },
	};
}

/** The closing line is gone; the footer falls back to its ready state. */
export function finishFlourish(state: LivelyState): LivelyState {
	if (state.phase !== "settled") return state;

	return {
		phase: "idle",
		frame: state.frame,
		modelPhase: "waiting",
		tools: 0,
		active: [],
		prompting: false,
		...(state.lastRun ? { lastRun: state.lastRun } : {}),
	};
}

export function tickFrame(state: LivelyState): LivelyState {
	return { ...state, frame: state.frame + 1 };
}

/** Frozen at the settled time, so the footer does not keep counting after a run. */
export function elapsedMs(state: LivelyState, now: number): number {
	if (state.runStartedAt === undefined) return state.lastRun?.durationMs ?? 0;
	return Math.max(0, (state.runEndedAt ?? now) - state.runStartedAt);
}

/**
 * The clock for the activity line: the current prompt, then the current tool,
 * then the whole run while the model is thinking.
 */
export function activeElapsedMs(state: LivelyState, now: number): number {
	if (state.prompting && state.promptStartedAt !== undefined) {
		return Math.max(0, now - state.promptStartedAt);
	}

	const active = currentTool(state);
	if (active) return Math.max(0, now - active.startedAt);
	return elapsedMs(state, now);
}

/** A tool prompt and a host dialog both mean the user, not the model, is the blocker. */
export function isWaiting(state: LivelyState): boolean {
	return state.prompting || state.active.some((tool) => tool.name === "ask_user");
}

/** Parallel tools are shown one at a time; the most recently started wins. */
export function currentTool(state: LivelyState): ActiveTool | undefined {
	return state.active[state.active.length - 1];
}
