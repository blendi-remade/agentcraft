package dev.agentcraft.client.library;

import dev.agentcraft.Cast;
import dev.agentcraft.client.diff.ReviewKit;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The memory entries as the library shows them: the lead's plan pinned first, then newest first;
 * scopes ("shared" first, then agents in cast order). Cached by Foreman revision (client thread).
 */
public final class MemoryIndex {
	public static final String ALL = "";

	private static long revision = -1;
	private static List<MemoryEntry> all = List.of();
	private static Map<String, Integer> counts = Map.of();
	/** Unread tracking: entry id -> the {@code updated} the player has seen (or that existed at the first snapshot). */
	private static final Map<String, Long> SEEN = new java.util.HashMap<>();
	private static boolean seenInitialised;

	private MemoryIndex() {
	}

	/** Wire the unread model: notes that exist at the first snapshot of the session count as read. */
	static void init() {
		Foreman.addListener(new dev.agentcraft.client.foreman.ForemanListener() {
			@Override
			public void onSnapshot(ForemanState state) {
				if (!seenInitialised) {
					seenInitialised = true;
					for (MemoryEntry e : state.memory().values()) {
						SEEN.put(e.id(), e.updated());
					}
				}
			}
		});
	}

	/** Written or changed since the player last read it (or since the session's first snapshot). */
	public static boolean isUnread(MemoryEntry e) {
		Long s = SEEN.get(e.id());
		return seenInitialised && (s == null || s < e.updated());
	}

	public static void markSeen(MemoryEntry e) {
		SEEN.put(e.id(), e.updated());
	}

	public static int unread(@Nullable String scope) {
		int n = 0;
		for (MemoryEntry e : entries(scope)) {
			if (isUnread(e)) {
				n++;
			}
		}
		return n;
	}

	private static void refresh() {
		ForemanState s = Foreman.state();
		if (s == null) {
			all = List.of();
			counts = Map.of();
			return;
		}
		if (s.revision() == revision) {
			return;
		}
		revision = s.revision();
		List<MemoryEntry> list = new ArrayList<>(s.memory().values());
		list.sort(Comparator.comparingInt((MemoryEntry e) -> isPlan(e) ? 0 : 1).thenComparing(Comparator.comparingLong(MemoryEntry::updated)
			.reversed()));
		all = List.copyOf(list);
		Map<String, Integer> c = new LinkedHashMap<>();
		c.put("shared", 0);
		for (String id : Cast.ids()) {
			c.put(id, 0);
		}
		for (MemoryEntry e : list) {
			c.merge(e.scope(), 1, Integer::sum);
		}
		c.values().removeIf(v -> v == 0);
		counts = Map.copyOf(c);
		orderedScopes = new ArrayList<>(c.keySet());
	}

	private static List<String> orderedScopes = List.of();

	/** The lead's plan: id {@code shared/plan}, or a shared/lead entry titled "Plan...". */
	public static boolean isPlan(MemoryEntry e) {
		if (e.id().equals("shared/plan")) {
			return true;
		}
		String t = e.title().toLowerCase(Locale.ROOT);
		if (!t.startsWith("plan")) {
			return false;
		}
		if ("shared".equals(e.scope())) {
			return true;
		}
		ForemanState s = Foreman.state();
		Protocol.Agent a = s == null || e.author() == null ? null : s.agent(e.author());
		return a != null && a.role() == Protocol.AgentRole.LEAD;
	}

	/** Entries of a scope ({@link #ALL} = every scope), plan first, then newest first. */
	public static List<MemoryEntry> entries(@Nullable String scope) {
		refresh();
		if (scope == null || scope.isEmpty()) {
			return all;
		}
		List<MemoryEntry> out = new ArrayList<>();
		for (MemoryEntry e : all) {
			if (scope.equals(e.scope())) {
				out.add(e);
			}
		}
		return out;
	}

	/**
	 * Shelf order of a scope: the plan first, then the Foreman's order (creation order), so a note
	 * keeps its place on the archive shelf when it is updated.
	 */
	public static List<MemoryEntry> shelf(@Nullable String scope) {
		ForemanState s = Foreman.state();
		if (s == null) {
			return List.of();
		}
		if (s.revision() != shelfRevision) {
			SHELVES.clear();
			shelfRevision = s.revision();
		}
		return SHELVES.computeIfAbsent(scope == null ? "" : scope, k -> buildShelf(s, k));
	}

	private static final Map<String, List<MemoryEntry>> SHELVES = new java.util.HashMap<>();
	private static long shelfRevision = -1;

	private static List<MemoryEntry> buildShelf(ForemanState s, String scope) {
		List<MemoryEntry> out = new ArrayList<>();
		for (MemoryEntry e : s.memory().values()) {
			if (scope.isEmpty() || scope.equals(e.scope())) {
				out.add(e);
			}
		}
		out.sort(Comparator.comparingInt((MemoryEntry e) -> isPlan(e) ? 0 : 1));
		return List.copyOf(out);
	}

	/** Scopes that have entries: shared first, then agents in cast order, then anything else. */
	public static List<String> scopes() {
		refresh();
		return orderedScopes;
	}

	public static int count(@Nullable String scope) {
		refresh();
		if (scope == null || scope.isEmpty()) {
			return all.size();
		}
		return counts.getOrDefault(scope, 0);
	}

	public static @Nullable MemoryEntry plan() {
		refresh();
		for (MemoryEntry e : all) {
			if (isPlan(e)) {
				return e;
			}
		}
		return null;
	}

	/** Newest update time in a scope (0 = none). */
	public static long newest(@Nullable String scope) {
		long n = 0;
		for (MemoryEntry e : entries(scope)) {
			n = Math.max(n, e.updated());
		}
		return n;
	}

	public static String scopeLabel(@Nullable String scope) {
		if (scope == null || scope.isEmpty()) {
			return Tr.t("All");
		}
		if (scope.equals("shared")) {
			return Tr.t("Shared");
		}
		return ReviewKit.agentName(scope);
	}
}
