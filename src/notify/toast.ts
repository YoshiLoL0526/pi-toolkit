/**
 * Windows toast delivery.
 *
 * Windows PowerShell 5.1 is used on purpose: `pwsh` has no WinRT projection, so
 * `ToastNotificationManager` is not reachable from PowerShell 7. The call is
 * fire and forget — a notification must never delay or fail an event handler —
 * and every failure is swallowed, because a terminal without notifications is
 * not an error worth interrupting the agent for.
 */

import { execFile } from "node:child_process";
import { TOAST_SCRIPT, toastEnv, type Notification } from "./payload.js";

export function spawnWindowsToast(notification: Notification): void {
	try {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT],
			{
				windowsHide: true,
				timeout: 8000,
				env: { ...process.env, ...toastEnv(notification) },
			},
			() => {
				/* best effort */
			},
		);
	} catch {
		/* best effort */
	}
}
