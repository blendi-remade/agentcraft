package dev.agentcraft.client.monitor;

import dev.agentcraft.Cast;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.foreman.Protocol.FeedItem;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.LogEntry;
import dev.agentcraft.client.foreman.UsageText;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

/**
 * Everything a monitor screen draws, laid out once and cached until its inputs change (the agent's
 * log, the agent record, the screen size or look, the link): header, log rows (newest first) and the
 * static background rectangles. One instance per monitor panel (keyed by the panel origin), owned by
 * {@link MonitorFeature}; the renderer only reads it. Client (render) thread only.
 */
final class MonitorScreen {
	enum Mode {
		LIVE, FEED, OFF_SHIFT, NO_AGENT, CONNECTING
	}

	/**
	 * Side padding in blocks. The brass lip stands 1/16 block in front of the glass, so at an
	 * oblique view it hides a strip of the screen next to the bezel: 0.09 block keeps text clear of
	 * it up to about 55 degrees off-axis (a desk camera looking at the neighbouring monitors).
	 */
	static final float PAD_X_BLOCKS = 0.09f;
	static final int PAD_TOP = 4;
	static final int PAD_BOTTOM = 3;
	/** Rows newer than the previous layout slide in from below over this many ms. */
	static final float SCROLL_MS = 260f;
	static final float MAX_SHIFT = 2 * LogRows.LINE + 4;

	final BlockPos origin;
	long lastUsedNanos;

	// --- inputs of the current layout
	String agentId = "";
	@Nullable ScreenStyle style;
	int ppb;
	int panelW;
	int panelH;
	long logSeq = Long.MIN_VALUE;
	long agentSeq = Long.MIN_VALUE;
	Mode mode = Mode.CONNECTING;
	String connectText = "";
	/** Plan usage line of the feed screen, keyed by its text (fetchedAt changes every poll, the text rarely). */
	String usageText = "";

	// --- geometry (face px; origin = panel top-left)
	float bx0, by0, bx1, by1;     // inside the bezel
	float cx0, cy0, cx1, cy1;     // log rows
	float headerBottom;
	boolean narrow;
	/** Side padding in face px for the current density ({@link #PAD_X_BLOCKS}). */
	int padX = 6;
	float padTop = PAD_TOP;

	// --- header
	@Nullable FormattedCharSequence name;
	int nameColor;
	String dotFamily = "idle";
	@Nullable FormattedCharSequence activity;
	float activityX, activityY;
	@Nullable FormattedCharSequence usage;
	float usageY;
	@Nullable FormattedCharSequence pill;
	float pillX;
	int pillColor;
	boolean caret;
	@Nullable FormattedCharSequence footer;
	int footerColor;

	// --- centred message (off shift, no agent, connecting)
	final List<FormattedCharSequence> centre = new ArrayList<>(3);
	final List<Integer> centreColors = new ArrayList<>(3);
	final List<Float> centreX = new ArrayList<>(3);

	// --- rows, newest first
	List<LogRows.Row> rows = List.of();
	long newestKey;

	// --- static background (screen gradient, scanlines, header band, rule)
	final DisplayDraw.Rects bg = new DisplayDraw.Rects();
	/** Per-frame rectangles (diff tints, caret, dimming), refilled by the renderer. */
	final DisplayDraw.Rects dyn = new DisplayDraw.Rects();
	final DisplayDraw.Rects veil = new DisplayDraw.Rects();
	final DisplayDraw.Rects badge = new DisplayDraw.Rects();

	// --- scroll animation
	float shiftFrom;
	long shiftStartNanos;

	MonitorScreen(BlockPos origin) {
		this.origin = origin;
	}

	/** Current slide-in offset in px (rows are drawn this much lower, easing to 0). */
	float shift(long now) {
		if (shiftFrom <= 0) {
			return 0;
		}
		float t = (now - shiftStartNanos) / 1e6f / SCROLL_MS;
		if (t >= 1) {
			shiftFrom = 0;
			return 0;
		}
		float e = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
		return shiftFrom * (1 - e);
	}

	/** Rebuild when anything this screen shows changed. Returns true when it rebuilt. */
	boolean sync(@Nullable ForemanState s, String binding, ScreenStyle st, int ppb, int panelW, int panelH, long logSeq, long agentSeq, long now) {
		Mode m;
		String id = binding;
		if (s == null || !s.hasData()) {
			m = Mode.CONNECTING;
		} else if ("feed".equals(binding)) {
			m = Mode.FEED;
		} else {
			Agent a = s.agent(binding);
			m = a == null ? Mode.NO_AGENT : !a.isActive() ? Mode.OFF_SHIFT : Mode.LIVE;
		}
		String connect = m == Mode.CONNECTING ? connectText(s) : "";
		String usageLine = m == Mode.FEED ? java.util.Objects.requireNonNullElse(UsageText.summary(s, UsageText.HEADER_WINDOWS), "") : "";
		boolean same = m == mode && id.equals(agentId) && st == style && ppb == this.ppb && panelW == this.panelW && panelH == this.panelH
			&& logSeq == this.logSeq && agentSeq == this.agentSeq && connect.equals(connectText) && usageLine.equals(usageText);
		if (same) {
			return false;
		}
		boolean geometryChanged = st != style || ppb != this.ppb || panelW != this.panelW || panelH != this.panelH;
		boolean sameAgent = id.equals(agentId) && m == mode;
		this.mode = m;
		this.agentId = id;
		this.style = st;
		this.ppb = ppb;
		this.panelW = panelW;
		this.panelH = panelH;
		this.logSeq = logSeq;
		this.agentSeq = agentSeq;
		this.connectText = connect;
		this.usageText = usageLine;
		Font font = Minecraft.getInstance().font;
		geometry(font);
		header(font, s);
		long oldNewest = newestKey;
		float added = rows(font, s, oldNewest);
		if (sameAgent && !geometryChanged && added > 0 && oldNewest != 0) {
			shiftFrom = Math.min(MAX_SHIFT, shift(now) + added);
			shiftStartNanos = now;
		} else if (!sameAgent || geometryChanged) {
			shiftFrom = 0;
		}
		background();
		return true;
	}

	private static String connectText(@Nullable ForemanState s) {
		return DisplayText.noData(s);
	}

	private void geometry(Font font) {
		float b = ppb * 2f / 16f; // 2-texel bezel on the panel's outer edges
		bx0 = b;
		by0 = b;
		bx1 = panelW * ppb - b;
		by1 = panelH * ppb - b;
		padX = Math.max(6, Math.round(ppb * PAD_X_BLOCKS));
		padTop = Math.max(PAD_TOP, Math.round(ppb * 0.04f));
		cx0 = bx0 + padX;
		cx1 = bx1 - padX + 1;
		narrow = (cx1 - cx0) < 150;
	}

	private void header(Font font, @Nullable ForemanState s) {
		ScreenStyle st = style;
		name = null;
		activity = null;
		usage = null;
		pill = null;
		footer = null;
		caret = false;
		centre.clear();
		centreColors.clear();
		centreX.clear();
		float y = by0 + padTop;
		int w = (int) (cx1 - cx0);
		switch (mode) {
			case LIVE, OFF_SHIFT, NO_AGENT -> {
				Agent a = s == null ? null : s.agent(agentId);
				String n = a != null ? a.name() : agentId.isEmpty() ? "Monitor" : agentId;
				nameColor = st.name(agentId);
				dotFamily = a == null ? "idle" : mode == Mode.OFF_SHIFT ? "idle" : a.state().family();
				String task = a != null && a.taskId() != null && mode == Mode.LIVE ? a.taskId() : "";
				int pillW = task.isEmpty() ? 0 : font.width(task) + 6;
				name = LogRows.seq(TextUtil.ellipsize(font, n, w - 10 - pillW));
				pill = task.isEmpty() ? null : LogRows.seq(task);
				pillX = cx1 - font.width(task);
				pillColor = st.muted();
				String act = mode == Mode.LIVE ? activityOf(a) : "";
				float nameEnd = cx0 + 10 + font.width(name);
				if (act.isEmpty()) {
					activity = null;
					headerBottom = y + 10;
				} else if (!narrow && font.width(act) <= cx1 - pillW - nameEnd - 8) {
					activity = LogRows.seq(act);
					activityX = nameEnd + 6;
					activityY = y;
					headerBottom = y + 10;
				} else {
					activity = LogRows.seq(TextUtil.ellipsize(font, act, w));
					activityX = cx0;
					activityY = y + LogRows.LINE;
					headerBottom = y + LogRows.LINE + 10;
				}
				if (mode == Mode.LIVE && a != null) {
					String fam = a.state().family();
					caret = fam.equals("working") || fam.equals("thinking");
					if (fam.equals("waiting")) {
						footer = LogRows.seq(TextUtil.ellipsize(font, font.width("Waiting for you") <= w ? "Waiting for you" : "Needs you", w));
						footerColor = st.attention();
					} else if (a.isPaused()) {
						footer = LogRows.seq("Paused");
						footerColor = st.muted();
					}
				}
				if (mode != Mode.LIVE) {
					String line = mode == Mode.OFF_SHIFT ? "Off shift" : "Not on the team";
					String sub = mode == Mode.OFF_SHIFT ? "in the lounge" : "binding: " + agentId;
					addCentre(font, line, st.text());
					addCentre(font, TextUtil.ellipsize(font, sub, w), st.muted());
				}
			}
			case FEED -> {
				Goal g = s == null ? null : s.goal();
				nameColor = st.text();
				dotFamily = g == null ? "idle" : "working";
				name = LogRows.seq(TextUtil.ellipsize(font, "Team activity", w - 30));
				if (g != null) {
					String p = Math.round(g.progress() * 100) + "%";
					pill = LogRows.seq(p);
					pillX = cx1 - font.width(p);
					pillColor = st.muted();
					activity = LogRows.seq(TextUtil.ellipsize(font, g.text(), w));
				} else {
					activity = LogRows.seq("no goal yet");
				}
				activityX = cx0;
				activityY = y + LogRows.LINE;
				headerBottom = y + LogRows.LINE + 10;
				if (!usageText.isEmpty() && !narrow) {
					// account-wide plan windows, the console header's wording
					usage = LogRows.seq(TextUtil.ellipsize(font, usageText, w));
					usageY = y + 2 * LogRows.LINE;
					headerBottom = y + 2 * LogRows.LINE + 10;
				}
			}
			case CONNECTING -> {
				// keep whose screen this is (from the cast, no Foreman needed), then why it is empty
				dotFamily = "idle";
				nameColor = st.text();
				if ("feed".equals(agentId)) {
					name = LogRows.seq(TextUtil.ellipsize(font, "Team activity", w - 10));
				} else if (!agentId.isEmpty()) {
					Cast.Member cm = Cast.get(agentId);
					nameColor = st.name(agentId);
					name = LogRows.seq(TextUtil.ellipsize(font, cm != null ? cm.name() : agentId, w - 10));
				}
				headerBottom = name != null ? y + 10 : by0 + padTop;
				List<String> lines = TextUtil.wrapPlain(font, connectText, w);
				for (int i = 0; i < Math.min(2, lines.size()); i++) {
					String l = lines.get(i);
					if (i == 1 && lines.size() > 2) {
						l = l + " " + String.join(" ", lines.subList(2, lines.size()));
					}
					addCentre(font, TextUtil.ellipsize(font, l, w), st.muted());
				}
			}
		}
		cy0 = headerBottom + 3;
		cy1 = by1 - PAD_BOTTOM - (caret || footer != null ? LogRows.LINE : 0);
	}

	private void addCentre(Font font, String text, int color) {
		FormattedCharSequence seq = LogRows.seq(text);
		centre.add(seq);
		centreColors.add(color);
		centreX.add((bx0 + bx1 - font.width(seq)) / 2f);
	}

	private static String activityOf(@Nullable Agent a) {
		if (a == null) {
			return "";
		}
		String act = a.activity().isBlank() ? a.state().wire().replace('_', ' ') : LogRows.plainProse(a.activity());
		return a.isPaused() ? "paused: " + act : act;
	}

	/** Lays out rows newest first; returns the px height of rows newer than {@code oldNewest}. */
	private float rows(Font font, @Nullable ForemanState s, long oldNewest) {
		int width = (int) (cx1 - cx0);
		float need = (cy1 - cy0) + MAX_SHIFT + LogRows.TOOL_LINE;
		List<LogRows.Row> out = new ArrayList<>();
		float h = 0;
		float added = 0;
		boolean seenOld = false;
		newestKey = 0;
		if (s != null && mode == Mode.LIVE) {
			List<LogEntry> logs = s.logs(agentId);
			for (int i = logs.size() - 1; i >= 0 && h < need; i--) {
				LogEntry e = logs.get(i);
				long key = key(e);
				if (newestKey == 0) {
					newestKey = key;
				}
				if (key == oldNewest) {
					seenOld = true;
				}
				List<LogRows.Row> rs = LogRows.of(font, e, width, style);
				for (int k = rs.size() - 1; k >= 0; k--) {
					out.add(rs.get(k));
					h += rs.get(k).height();
					if (!seenOld) {
						added += rs.get(k).height();
					}
				}
			}
		} else if (s != null && mode == Mode.FEED) {
			Iterator<FeedItem> it = s.feed().reversed().iterator();
			int i = 0;
			while (it.hasNext() && h < need) {
				FeedItem f = it.next();
				long key = f.ts() * 31 + f.text().hashCode();
				if (newestKey == 0) {
					newestKey = key;
				}
				if (key == oldNewest) {
					seenOld = true;
				}
				List<LogRows.Row> rs = feedRows(font, s, f, width);
				for (int k = rs.size() - 1; k >= 0; k--) {
					out.add(rs.get(k));
					h += rs.get(k).height();
					if (!seenOld) {
						added += rs.get(k).height();
					}
				}
				i++;
			}
		}
		rows = out;
		return seenOld ? added : 0;
	}

	private List<LogRows.Row> feedRows(Font font, ForemanState s, FeedItem f, int width) {
		ScreenStyle st = style;
		List<LogRows.Row> out = new ArrayList<>(2);
		String who = "";
		int whoColor = st.muted();
		String id = f.agentId();
		if (id != null && !id.equals("user")) {
			Agent a = s.agent(id);
			who = a != null ? a.name() : id;
			whoColor = st.name(id);
		} else if ("user".equals(id) || f.kind() == dev.agentcraft.client.foreman.Protocol.FeedKind.USER) {
			who = "You";
			whoColor = st.text();
		}
		int color = switch (f.kind()) {
			case ERROR -> st.error();
			case CI -> f.text().toLowerCase(Locale.ROOT).contains("fail") ? st.error() : st.result();
			case MERGE -> st.result();
			case DECISION -> st.attention();
			default -> st.text();
		};
		String text = LogRows.plainProse(f.text()).strip();
		// feed texts often start with the actor's name ("Marlow needs you..."): colour it instead of repeating it
		String lead = who;
		if (!who.isEmpty() && (text.startsWith(who + " ") || text.startsWith(who + ":"))) {
			text = text.substring(who.length()).stripLeading();
			if (text.startsWith(":")) {
				text = text.substring(1).stripLeading();
			}
		} else if (who.equals("You") && text.startsWith(UiBits.userName() + " ")) {
			text = text.substring(UiBits.userName().length() + 1);
		}
		int whoW = lead.isEmpty() ? 0 : font.width(lead + " ");
		int indent = 8;
		// first line after the name, the rest with a small hanging indent
		List<String> first = TextUtil.wrapPlain(font, text, Math.max(20, width - whoW));
		String l0 = first.isEmpty() ? "" : first.get(0);
		String rest = text.length() > l0.length() ? text.substring(Math.min(text.length(), l0.length())).strip() : "";
		if (!lead.isEmpty()) {
			out.add(new LogRows.Row(LogRows.LINE, Component.literal(lead + " ").withColor(whoColor & 0xFFFFFF)
				.append(Component.literal(l0).withColor(color & 0xFFFFFF)).getVisualOrderText(), color, 0, null, 0));
		} else {
			out.add(new LogRows.Row(LogRows.LINE, LogRows.seq(l0), color, 0, null, 0));
		}
		if (!rest.isEmpty()) {
			out.add(new LogRows.Row(LogRows.LINE, LogRows.seq(TextUtil.ellipsize(font, rest, width - indent)), color, indent, null, 0));
		}
		return out;
	}

	private static long key(LogEntry e) {
		return (e.ts() * 31 + e.text().hashCode()) * 31 + e.kind().ordinal() + 1;
	}

	/** Screen gradient + scanlines (one dark texel row in two, like the block texture) + header band + rule. */
	private void background() {
		ScreenStyle st = style;
		int light = dev.agentcraft.client.ui.WorldUi.uiLight();
		bg.clear();
		float z0 = 0;
		float zBand = 3 * DisplayDraw.Z_STEP;
		float texel = ppb / 16f;
		float x0 = bx0 - 0.5f;
		float x1 = bx1 + 0.5f;
		float y0 = by0 - 0.5f;
		float y1 = by1 + 0.5f;
		bg.add(x0, y0, x1, y1, z0, st.bgTop(), st.bgBottom(), light);
		boolean band = mode != Mode.CONNECTING || name != null;
		float bandBottom = band ? headerBottom + 2 : y0;
		for (float y = 0; y < panelH * ppb; y += 2 * texel) {
			float sy0 = Math.max(y + texel, y0);
			float sy1 = Math.min(y + 2 * texel, y1);
			if (sy1 <= sy0) {
				continue;
			}
			bg.add(x0, sy0, x1, sy1, z0 + DisplayDraw.Z_STEP * 0.5f, st.scanline(), light);
			// the same scanline on the header band, which hides rows that scroll under it
			float hy0 = sy0;
			float hy1 = Math.min(sy1, bandBottom);
			if (hy1 > hy0) {
				bg.add(x0, hy0, x1, hy1, zBand + DisplayDraw.Z_STEP * 0.5f, st.scanline(), light);
			}
		}
		if (band) {
			bg.add(x0, y0, x1, bandBottom, zBand, st.headerBg(), light);
			if (mode == Mode.LIVE || mode == Mode.FEED || mode == Mode.CONNECTING) {
				bg.add(cx0, headerBottom, cx1, headerBottom + 1, zBand + DisplayDraw.Z_STEP * 0.7f, st.rule(), light);
			}
		}
	}
}
