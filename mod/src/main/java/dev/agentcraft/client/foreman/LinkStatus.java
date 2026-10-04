package dev.agentcraft.client.foreman;

import org.jspecify.annotations.Nullable;

/**
 * Connection state of the Foreman link.
 *
 * @param phase        see {@link Phase}
 * @param url          the Foreman URL
 * @param attempt      connect attempts since the last successful sync (0 while synced)
 * @param lastError    why the last connection failed or closed (null if none)
 * @param sinceMs      wall-clock ms when the current phase began
 * @param nextRetryAtMs when {@link Phase#WAITING_RETRY}: wall-clock ms of the next attempt
 * @param everSynced   a snapshot was received at least once since the game started
 */
public record LinkStatus(Phase phase, String url, int attempt, @Nullable String lastError, long sinceMs, long nextRetryAtMs,
	boolean everSynced) {
	public enum Phase {
		/** AGENTCRAFT_FOREMAN=0: the link is off. */
		DISABLED,
		/** Opening the WebSocket. */
		CONNECTING,
		/** Socket open, hello sent, waiting for the snapshot. */
		HANDSHAKE,
		/** Snapshot received; upserts are streaming. The state model is live. */
		SYNCED,
		/** Not connected; the next attempt is scheduled (backoff). */
		WAITING_RETRY
	}

	public boolean synced() {
		return phase == Phase.SYNCED;
	}

	/** Lower-case phase name for JSON (dev.state). */
	public String phaseName() {
		return phase.name().toLowerCase(java.util.Locale.ROOT);
	}

	public LinkStatus with(Phase p, @Nullable String error, long nextRetry) {
		return new LinkStatus(p, url, p == Phase.SYNCED ? 0 : attempt, error, System.currentTimeMillis(), nextRetry, everSynced || p == Phase.SYNCED);
	}

	public LinkStatus attempt(int n) {
		return new LinkStatus(phase, url, n, lastError, sinceMs, nextRetryAtMs, everSynced);
	}
}
