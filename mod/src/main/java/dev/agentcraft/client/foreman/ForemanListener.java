package dev.agentcraft.client.foreman;

import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.AgentSay;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.FeedItem;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.LogEntry;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.foreman.Protocol.Notify;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.Task;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * Change callbacks of {@link ForemanState}. Every method has a no-op default; implement what you
 * need. Callbacks run on the thread applying the state update: the render thread for client
 * links, or the server thread for the dedicated relay. The state is already updated. Listeners
 * must use the supplied model and must not assume a client runtime exists.
 *
 * <p>A {@code snapshot} (on every (re)connect) replaces the whole model and fires only
 * {@link #onSnapshot}: rebuild anything you derived from the state there. Upserts fire the
 * per-entity callbacks with the previous value ({@code null} when new).
 */
public interface ForemanListener {
	default void onConnection(LinkStatus status) {
	}

	default void onSnapshot(ForemanState state) {
	}

	default void onAgent(@Nullable Agent previous, Agent agent) {
	}

	default void onTask(@Nullable Task previous, Task task) {
	}

	default void onDecision(@Nullable Decision previous, Decision decision) {
	}

	default void onRepo(@Nullable Repo previous, Repo repo) {
	}

	default void onMemory(@Nullable MemoryEntry previous, MemoryEntry entry) {
	}

	default void onGoal(@Nullable Goal previous, Goal goal) {
	}

	default void onFeed(FeedItem item) {
	}

	default void onLog(String agentId, List<LogEntry> entries) {
	}

	default void onSay(AgentSay say) {
	}

	default void onNotify(Notify notify) {
	}

	default void onStatus(ForemanStatus status) {
	}

	/** Any change at all (after the specific callback). Cheap hook for "something to redraw". */
	default void onChange(long revision) {
	}
}
