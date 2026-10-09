package dev.agentcraft.client.console;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.FeedItem;
import dev.agentcraft.client.foreman.Protocol.FeedKind;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * What the console shows: the Foreman feed (live, oldest first) merged by time with the console's
 * own lines (help, status, errors, diff summaries) and the input history (persisted in
 * {@code <game dir>/agentcraft/console-history.txt}, last 200 entries).
 */
public final class ConsoleLog {
	/** Tone of a local line. */
	public enum Tone {
		INFO, OK, WARN, ERROR, ECHO, HEADER, HELP, FILE
	}

	/** One display line: a feed item or a local line. */
	public record Line(long ts, @Nullable String agentId, @Nullable String to, @Nullable FeedKind kind, String text, Tone tone, boolean local) {
	}

	private static final int LOCAL_MAX = 300;
	private static final int HISTORY_MAX = 200;
	private static final Deque<Line> LOCAL = new ArrayDeque<>();
	private static final List<String> HISTORY = new ArrayList<>();
	private static long localRevision;
	private static boolean historyLoaded;
	private static long lastLocalTs;

	private static long cachedFeedRev = -1;
	private static long cachedLocalRev = -1;
	private static List<Line> cached = List.of();

	private ConsoleLog() {
	}

	// ------------------------------------------------------------------ local lines

	public static void add(Tone tone, String text) {
		add(tone, text, null);
	}

	public static void add(Tone tone, String text, @Nullable String agentId) {
		// keep local lines strictly ordered even when several are added in the same millisecond
		long ts = Math.max(System.currentTimeMillis(), lastLocalTs + 1);
		lastLocalTs = ts;
		LOCAL.addLast(new Line(ts, agentId, null, null, text, tone, true));
		while (LOCAL.size() > LOCAL_MAX) {
			LOCAL.removeFirst();
		}
		localRevision++;
	}

	public static void clearLocal() {
		LOCAL.clear();
		clearedAt = System.currentTimeMillis();
		localRevision++;
	}

	private static long clearedAt;

	public static long revision() {
		ForemanState s = Foreman.state();
		return localRevision * 1_000_003L + (s == null ? 0 : s.revision());
	}

	/** Feed + local lines, oldest first (client thread; cached). */
	public static List<Line> lines() {
		ForemanState s = Foreman.state();
		long fr = s == null ? -1 : s.revision();
		if (fr == cachedFeedRev && localRevision == cachedLocalRev) {
			return cached;
		}
		List<Line> feed = new ArrayList<>();
		if (s != null) {
			for (FeedItem f : s.feed()) {
				if (f.ts() >= clearedAt) {
					feed.add(new Line(f.ts(), f.agentId(), f.to(), f.kind(), f.text(), f.kind() == FeedKind.ERROR ? Tone.ERROR : Tone.INFO, false));
				}
			}
		}
		// merge (both are sorted by ts)
		List<Line> out = new ArrayList<>(feed.size() + LOCAL.size());
		int i = 0;
		List<Line> local = new ArrayList<>(LOCAL);
		int j = 0;
		while (i < feed.size() || j < local.size()) {
			if (j >= local.size() || i < feed.size() && feed.get(i).ts() <= local.get(j).ts()) {
				out.add(feed.get(i++));
			} else {
				out.add(local.get(j++));
			}
		}
		cached = List.copyOf(out);
		cachedFeedRev = fr;
		cachedLocalRev = localRevision;
		return cached;
	}

	// ------------------------------------------------------------------ unsent draft

	private static String draft = "";
	private static int draftCursor;

	/** What was typed but not sent when the console closed (restored on the next open; this session only). */
	public static String draft() {
		return draft;
	}

	public static int draftCursor() {
		return Math.max(0, Math.min(draftCursor, draft.length()));
	}

	public static void keepDraft(String text, int cursor) {
		draft = text == null ? "" : text;
		draftCursor = cursor;
	}

	// ------------------------------------------------------------------ history

	public static List<String> history() {
		loadHistory();
		return HISTORY;
	}

	public static void remember(String input) {
		loadHistory();
		String v = input.strip();
		if (v.isEmpty()) {
			return;
		}
		HISTORY.remove(v);
		HISTORY.add(v);
		while (HISTORY.size() > HISTORY_MAX) {
			HISTORY.remove(0);
		}
		saveHistory();
	}

	private static @Nullable Path historyFile() {
		Minecraft mc = Minecraft.getInstance();
		if (mc == null || mc.gameDirectory == null) {
			return null;
		}
		return mc.gameDirectory.toPath().resolve("agentcraft").resolve("console-history.txt");
	}

	private static void loadHistory() {
		if (historyLoaded) {
			return;
		}
		historyLoaded = true;
		Path p = historyFile();
		if (p == null || !Files.isRegularFile(p)) {
			return;
		}
		try {
			for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
				if (!line.isBlank()) {
					// multi-line entries are stored with escaped newlines
					HISTORY.add(line.replace("\\n", "\n").replace("\\\\", "\\"));
				}
			}
			while (HISTORY.size() > HISTORY_MAX) {
				HISTORY.remove(0);
			}
		} catch (IOException e) {
			AgentCraft.LOGGER.warn("Console: could not read {}", p, e);
		}
	}

	private static void saveHistory() {
		Path p = historyFile();
		if (p == null) {
			return;
		}
		List<String> lines = new ArrayList<>();
		for (String h : HISTORY) {
			lines.add(h.replace("\\", "\\\\").replace("\n", "\\n"));
		}
		try {
			Files.createDirectories(p.getParent());
			Files.write(p, lines, StandardCharsets.UTF_8);
		} catch (IOException e) {
			AgentCraft.LOGGER.warn("Console: could not write {}", p, e);
		}
	}
}
