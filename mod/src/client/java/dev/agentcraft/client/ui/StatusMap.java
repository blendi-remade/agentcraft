package dev.agentcraft.client.ui;

import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import org.jspecify.annotations.Nullable;

/**
 * The one status mapping of the Warm Studio UI (docs/visual-bar.md "Status colors"): every surface
 * that shows a task's state (Task Wall cards and headers, task screen, memory library, console,
 * HUD) asks here, so one task never shows in two colours.
 *
 * <ul>
 *   <li>todo: {@code idle} grey</li>
 *   <li>doing: {@code working} teal</li>
 *   <li>review, or any open task with an open decision on it (a merge waiting for the user, a
 *       question about it): {@code waiting} clay, pulsing; review without a decision (an agent is
 *       still reviewing): {@code thinking} brass</li>
 *   <li>blocked: {@code error} red</li>
 *   <li>done: {@code done} sage; cancelled: {@code cancelled} (a faded idle dot)</li>
 * </ul>
 */
public final class StatusMap {
	private StatusMap() {
	}

	/** The open decision that waits on the user for this task (merge, question or permission tied to it), or null. */
	public static @Nullable Decision decisionFor(@Nullable ForemanState s, Task t) {
		if (s == null) {
			return null;
		}
		for (Decision d : s.openDecisions()) {
			if (t.id().equals(d.taskId())) {
				return d;
			}
			if (t.worktree() != null && t.worktree().equals(d.worktree())) {
				return d;
			}
		}
		return null;
	}

	/** True while this task waits on the user (an open decision on it). */
	public static boolean needsYou(@Nullable ForemanState s, Task t) {
		return t.status() != TaskStatus.DONE && t.status() != TaskStatus.CANCELLED && t.status() != TaskStatus.BLOCKED
			&& decisionFor(s, t) != null;
	}

	/** Status family of a task: idle, working, thinking, waiting, error, done or cancelled. */
	public static String task(@Nullable ForemanState s, Task t) {
		if (needsYou(s, t)) {
			return "waiting";
		}
		return switch (t.status()) {
			case DOING -> "working";
			case REVIEW -> "thinking";
			case DONE -> "done";
			case BLOCKED -> "error";
			case CANCELLED -> "cancelled";
			default -> "idle";
		};
	}

	/**
	 * Status family of an agent, the same rule as its nameplate and desk lamp: a worker whose finished
	 * task waits on an open decision (merge) is {@code waiting}, not idle.
	 */
	public static String agent(@Nullable ForemanState s, dev.agentcraft.client.foreman.Protocol.Agent a) {
		String f = a.state().family();
		if (s != null && (f.equals("idle") || f.equals("done"))) {
			for (Decision d : s.openDecisions()) {
				if (a.id().equals(d.agentId())) {
					return "waiting";
				}
			}
		}
		return f;
	}

	/** Short, user-facing reason a task waits on the user ("your merge", "your answer"), or null. */
	public static @Nullable String needsYouLabel(@Nullable ForemanState s, Task t) {
		if (!needsYou(s, t)) {
			return null;
		}
		Decision d = decisionFor(s, t);
		if (d == null) {
			return null;
		}
		return switch (d.kind()) {
			case MERGE -> Tr.t("your merge");
			case PERMISSION -> Tr.t("your OK");
			default -> Tr.t("your answer");
		};
	}

	/** Colour of a family (cancelled: idle). */
	public static int color(String family) {
		return UiStyle.status("cancelled".equals(family) ? "idle" : family);
	}

	/** 0..1 pulse for "waiting" (one cycle per metrics.pulse_ms), the same phase on every surface. */
	public static float pulse(long nanos) {
		int period = UiStyle.metric("metrics.pulse_ms", 1200);
		double ph = ((nanos / 1_000_000L) % period) / (double) period;
		return (float) (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
	}
}
