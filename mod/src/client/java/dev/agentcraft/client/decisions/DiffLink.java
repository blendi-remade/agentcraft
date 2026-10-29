package dev.agentcraft.client.decisions;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Diff;
import dev.agentcraft.client.foreman.Protocol.DiffFile;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

/**
 * The bridge from decisions/console to the diff review screen owned by the diff feature, which
 * installs a precise opener ({@link #setOpener}, in {@code DiffFeature.init}) that takes the exact
 * repo/worktree/decision. There is deliberately no fallback to the DevBridge {@code "diff"} screen:
 * that one opens the <i>oldest</i> open merge decision, so reviewing one merge could show (and
 * approve) another. Without an opener a summary is fetched with {@code Foreman.requestDiff} instead.
 */
public final class DiffLink {
	/** Opens the diff screen for a target; returns the screen to show (or null when it cannot). */
	public interface Opener {
		@Nullable Screen open(String repoId, String worktree, @Nullable Decision decision, @Nullable Screen parent);
	}

	private static @Nullable Opener opener;

	private DiffLink() {
	}

	/** Install a precise opener (the diff feature does, see {@code DiffFeature.init}). */
	public static void setOpener(@Nullable Opener o) {
		opener = o;
	}

	public static boolean hasDiffScreen() {
		return opener != null;
	}

	/** Open the diff screen for this worktree; false when there is none (use {@link #summary}). */
	public static boolean open(String repoId, String worktree, @Nullable Decision decision, @Nullable Screen parent) {
		Minecraft mc = Minecraft.getInstance();
		try {
			Opener o = opener;
			if (o != null) {
				Screen s = o.open(repoId, worktree, decision, parent);
				if (s != null) {
					mc.gui.setScreen(s);
					return true;
				}
			}
		} catch (Exception e) {
			AgentCraft.LOGGER.warn("Could not open the diff screen for {}/{}", repoId, worktree, e);
		}
		return false;
	}

	/** One line of a diff summary. */
	public record SummaryLine(String text, boolean header, boolean error, int additions, int deletions) {
	}

	/** Fetch the diff and summarise it: a header with the totals, then one line per file. */
	public static CompletableFuture<List<SummaryLine>> summary(String repoId, String worktree) {
		return Foreman.requestDiff(repoId, worktree).handle((diff, err) -> {
			List<SummaryLine> out = new ArrayList<>();
			if (err != null || diff == null) {
				String msg = err == null ? Tr.t("no diff") : err.getCause() != null ? err.getCause().getMessage() : err.getMessage();
				out.add(new SummaryLine("diff " + worktree + ": " + msg, false, true, 0, 0));
				return out;
			}
			if (diff.error() != null) {
				out.add(new SummaryLine("diff " + worktree + ": " + diff.error(), false, true, 0, 0));
				return out;
			}
			out.add(new SummaryLine(header(diff), true, false, diff.stats().additions(), diff.stats().deletions()));
			for (DiffFile f : diff.files()) {
				out.add(new SummaryLine(fileLine(f), false, false, f.additions(), f.deletions()));
			}
			if (diff.truncated()) {
				out.add(new SummaryLine(Tr.t("(large diff: some hunks were cut)"), false, false, 0, 0));
			}
			return out;
		});
	}

	public static String header(Diff diff) {
		String br = diff.branch() != null ? diff.branch() : diff.worktree();
		return br + (diff.base() != null ? " → " + diff.base() : "") + ": " + diff.stats().files() + (diff.stats().files() == 1 ? Tr.t(" file") : Tr.t(" files"))
			+ ", +" + diff.stats().additions() + " −" + diff.stats().deletions();
	}

	public static String fileLine(DiffFile f) {
		String st = switch (f.status()) {
			case ADDED -> Tr.t("new ");
			case DELETED -> Tr.t("deleted ");
			case RENAMED -> Tr.t("renamed ");
			default -> "";
		};
		return st + f.path() + (f.binary() ? Tr.t(" (binary)") : "");
	}
}
