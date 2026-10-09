package dev.agentcraft.client.foreman;

import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import dev.agentcraft.client.foreman.Protocol.Usage;
import dev.agentcraft.client.foreman.Protocol.UsageWindow;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * Words for the plan usage the Foreman reports ({@code foreman.status.usage}, see
 * docs/design/usage-display.md), shared by the console header, {@code /status}, the HUD pill and
 * the feed monitor so they all say the same thing. Window ids and labels are opaque: the label is
 * rendered, the id only picks a noun. Countdowns use the client clock at call time.
 */
public final class UsageText {
	/** Most windows the console header shows. */
	public static final int HEADER_WINDOWS = 4;
	/** Utilization (percent) from which a window reads as a warning / an error. */
	public static final double WARN_AT = 80;
	public static final double ERROR_AT = 95;

	private UsageText() {
	}

	public static @Nullable Usage usage(@Nullable ForemanState s) {
		ForemanStatus fs = s == null ? null : s.status();
		return fs == null ? null : fs.usage();
	}

	/** True when the Foreman runs on a claude.ai subscription (costUsd is notional there). */
	public static boolean isSubscription(@Nullable ForemanState s) {
		Usage u = usage(s);
		return u != null && u.isSubscription();
	}

	/** True when there are windows to show (subscription mode only; an unknown mode reads as api). */
	public static boolean hasWindows(@Nullable Usage u) {
		return u != null && u.isSubscription() && !u.windows().isEmpty();
	}

	/**
	 * "5h 62% · 7d 34% · Fable 43%" for the first {@code max} windows, " (stale)" appended when the
	 * last poll failed; null when there is nothing to show. The text only changes when a shown number
	 * does, so callers can key layout on it (fetchedAt changes every poll).
	 */
	public static @Nullable String summary(@Nullable ForemanState s, int max) {
		Usage u = usage(s);
		if (!hasWindows(u)) {
			return null;
		}
		StringBuilder b = new StringBuilder();
		int n = 0;
		for (UsageWindow w : u.windows()) {
			if (n >= max) {
				break;
			}
			String label = w == null || w.label() == null ? "" : w.label().strip();
			if (label.isEmpty()) {
				continue;
			}
			if (n > 0) {
				b.append(" · ");
			}
			b.append(label).append(' ').append(percent(w.utilization()));
			n++;
		}
		if (n == 0) {
			return null;
		}
		if (u.isStale()) {
			b.append(" (stale)");
		}
		return b.toString();
	}

	/** "62%" (rounded), "?" when unknown. */
	public static String percent(@Nullable Double utilization) {
		return utilization == null ? "?" : Math.round(utilization) + "%";
	}

	/** 0 normal, 1 warning (from 80 %), 2 error (from 95 %). */
	public static int severity(@Nullable Double utilization) {
		if (utilization == null) {
			return 0;
		}
		return utilization >= ERROR_AT ? 2 : utilization >= WARN_AT ? 1 : 0;
	}

	/** "session" / "weekly" noun for a window id; empty for anything else. */
	public static String kindNoun(UsageWindow w) {
		if (w.id().equals("session")) {
			return "session";
		}
		if (w.id().equals("weekly") || w.id().startsWith("weekly:")) {
			return "weekly";
		}
		return "";
	}

	/** "resets in 3h 12m" / "resets in 4d 2h" / "resets in 12m" / "resetting now"; "resets at ?" when unknown. */
	public static String resets(@Nullable String resetsAt, long nowMs) {
		Long at = parseInstant(resetsAt);
		if (at == null) {
			return "resets at ?";
		}
		long ms = at - nowMs;
		if (ms <= 0) {
			return "resetting now";
		}
		return "resets in " + duration(ms);
	}

	/** "4d 2h", "3h 12m", "12m", "<1m". */
	public static String duration(long ms) {
		long mins = ms / 60_000;
		if (mins < 1) {
			return "<1m";
		}
		long hours = mins / 60;
		long days = hours / 24;
		if (days > 0) {
			return days + "d " + (hours % 24) + "h";
		}
		if (hours > 0) {
			return hours + "h " + (mins % 60) + "m";
		}
		return mins + "m";
	}

	/** "Max" for "max"; null for a missing plan. */
	public static @Nullable String planName(@Nullable String plan) {
		if (plan == null || plan.isBlank()) {
			return null;
		}
		String p = plan.strip();
		return p.substring(0, 1).toUpperCase(Locale.ROOT) + p.substring(1);
	}

	/** "$3.20" for USD (or no currency), "3.20 EUR" otherwise. */
	public static String money(double amount, @Nullable String currency) {
		String num = String.format(Locale.ROOT, "%.2f", amount);
		return currency == null || currency.isBlank() || currency.equalsIgnoreCase("USD") ? "$" + num : num + " " + currency;
	}

	private static @Nullable Long parseInstant(@Nullable String iso) {
		if (iso == null || iso.isBlank()) {
			return null;
		}
		try {
			return Instant.parse(iso.strip()).toEpochMilli();
		} catch (DateTimeParseException e) {
			try {
				return java.time.OffsetDateTime.parse(iso.strip()).toInstant().toEpochMilli();
			} catch (DateTimeParseException e2) {
				return null;
			}
		}
	}
}
