package dev.agentcraft.client.permissions;

import dev.agentcraft.client.decisions.DecisionQueue;
import dev.agentcraft.client.decisions.DecisionScreen;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.foreman.Protocol.DecisionStatus;
import java.util.List;

/**
 * Permission prompts. A permission decision (an agent's risky tool call, held until the user answers)
 * is shown by the decision screen with {@link PermissionBody}: the tool and exact command, the
 * Foreman's reason with a colour-coded risk chip ({@link PermissionInfo#classify}), the working
 * directory and what "Always allow for this team" covers; buttons Allow once / Always allow /
 * Deny (keys 1-3). Permission prompts go first in the queue (the agent is blocked mid-call), the HUD
 * rings the bell and shows a toast, and {@code J} opens it.
 *
 * <p>QA: {@code dev.screen {open:"permission"}} opens the oldest open permission decision; when none
 * is open it shows a clearly marked preview of a sample prompt (nothing is sent).
 */
public final class PermissionsFeature {
	private PermissionsFeature() {
	}

	public static void init() {
		DevBridge.registerScreen("permission", mc -> {
			Decision d = DecisionQueue.firstOfKind(DecisionKind.PERMISSION);
			return d != null ? new DecisionScreen(d.id(), null) : DecisionScreen.preview(sample());
		});
	}

	/** A representative permission prompt (the sim's "npm install" one), for previews. */
	public static Decision sample() {
		String worktree = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")
			? "C:\\Users\\you\\.agentcraft\\claude\\worktrees\\pocket-notes\\wren-t4"
			: "/Users/you/.agentcraft/claude/worktrees/pocket-notes/wren-t4";
		String ctx = "npm install downloads packages (network) and changes dependencies\n"
			+ "cwd: " + worktree + "\n"
			+ "\"" + Protocol.ALWAYS_ALLOW + "\" covers: `npm install` inside this agent's worktree (paths outside still ask); network access to "
			+ "registry.npmjs.org";
		return new Decision("preview-permission", "wren", DecisionKind.PERMISSION, "Wren wants to run Bash: npm install chalk@5", List.of(
			Protocol.ALLOW_ONCE, Protocol.ALWAYS_ALLOW, Protocol.DENY), ctx, DecisionStatus.OPEN, null, "t4", null, null, "Bash", System
				.currentTimeMillis() - 40_000);
	}
}
