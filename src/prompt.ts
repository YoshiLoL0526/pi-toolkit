/**
 * Prompt metadata. Guidelines are appended flat to the system prompt's rules
 * section, so every bullet has to name `ask_user` explicitly.
 */
export const promptSnippet =
	"Ask the user a question with selectable options when a decision needs their input";

export const promptGuidelines = [
	"Use ask_user when a decision changes what you build (architecture, dependencies, destructive or irreversible actions, scope) and the repository does not answer it, or when requirements are ambiguous or contradict each other.",
	"Do not use ask_user to confirm obvious next steps, to ask for information you can find with read/grep/find, or to repeat something the user already answered earlier in the conversation.",
	"Put the evidence for the decision in ask_user's `context` field and keep `question` to one sentence; offer 2-5 concrete options with the trade-off in each `description`.",
	"After ask_user returns, proceed with the chosen answer without asking again; if the user cancelled, do not re-ask the same question.",
];
