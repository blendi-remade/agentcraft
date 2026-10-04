package dev.agentcraft.client.console;

/** Keeps keyboard selection inside the visible completion rows, including wraparound. */
final class CompletionViewport {
	private CompletionViewport() {}

	static int start(int previous, int selected, int total, int visible) {
		if (total <= 0 || visible <= 0) return 0;
		int first = Math.clamp(previous, 0, Math.max(0, total - visible));
		int target = Math.clamp(selected, 0, total - 1);
		if (target < first) return target;
		if (target >= first + visible) return target - visible + 1;
		return first;
	}
}
