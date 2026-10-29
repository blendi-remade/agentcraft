package dev.agentcraft.client.decisions;

import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The order in which open decisions are put in front of the user (HUD badge, J key, podium, decision
 * screen): permission prompts first (an agent is blocked mid-tool-call), then questions (planning
 * waits on them), then merges (work is done and can wait), oldest first within a kind.
 */
public final class DecisionQueue {
	private static long cachedRevision = -1;
	private static List<Decision> cached = List.of();

	private DecisionQueue() {
	}

	public static int rank(DecisionKind k) {
		return switch (k) {
			case PERMISSION -> 0;
			case QUESTION -> 1;
			case MERGE -> 2;
			default -> 3;
		};
	}

	/** Open decisions in queue order (client thread; cached per Foreman revision). */
	public static List<Decision> open() {
		ForemanState s = Foreman.state();
		if (s == null) {
			return List.of();
		}
		if (s.revision() != cachedRevision) {
			List<Decision> out = new ArrayList<>(s.openDecisions());
			out.sort(Comparator.comparingInt((Decision d) -> rank(d.kind())).thenComparingLong(Decision::createdAt).thenComparing(Decision::id));
			cached = List.copyOf(out);
			cachedRevision = s.revision();
		}
		return cached;
	}

	public static int count() {
		return open().size();
	}

	public static @Nullable Decision first() {
		List<Decision> l = open();
		return l.isEmpty() ? null : l.get(0);
	}

	public static @Nullable Decision firstOfKind(DecisionKind kind) {
		for (Decision d : open()) {
			if (d.kind() == kind) {
				return d;
			}
		}
		return null;
	}

	public static int indexOf(String decisionId) {
		List<Decision> l = open();
		for (int i = 0; i < l.size(); i++) {
			if (l.get(i).id().equals(decisionId)) {
				return i;
			}
		}
		return -1;
	}

	/** Human label of a kind: "question", "permission", "merge review". */
	public static String kindLabel(DecisionKind k) {
		return switch (k) {
			case PERMISSION -> "permission";
			case MERGE -> Tr.t("merge review");
			case QUESTION -> "question";
			default -> "decision";
		};
	}
}
