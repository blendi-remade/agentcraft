package dev.agentcraft.client.hud;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.Cast;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.resources.Identifier;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * Small paper/ink widgets shared by the console, decision, permission and HUD features: agent
 * portraits, keycap hints, kit buttons with the right label colours, chips and relative times.
 * Everything is GUI-pixel space and asks {@link UiStyle} for colours.
 */
public final class UiBits {
	private static final DateTimeFormatter HHMM = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);
	/**
	 * Check mark that the vanilla bitmap font has (U+2714, a crisp 6x7 pixel tick in
	 * nonlatin_european). U+2713 is not in it and falls back to a thin, tiny unifont glyph.
	 */
	public static final String CHECK = "✔";
	/** Cross that the vanilla bitmap font has (U+2718); U+2717 is missing too. */
	public static final String CROSS = "✘";
	/** Primary (clay) button bodies are tinted to Clay-dark so the cream label reads (4.7:1 instead of 3.0:1). */
	private static final int PRIMARY_TINT = 0xFFD3B6AA;
	/** Mouse-hover tint of a primary button: a touch lighter than {@link #PRIMARY_TINT} (cream label 4.3:1). */
	private static final int PRIMARY_HOVER_TINT = 0xFFDEC3B6;
	/** Pressed primary (the pressed sprite, #C96B4C, tinted to about #A04A33). */
	private static final int PRIMARY_PRESSED_TINT = 0xFFCBB0AB;

	private UiBits() {
	}

	// ------------------------------------------------------------------ colours

	public static int ink() {
		return UiStyle.color("paper.text", UiStyle.INK);
	}

	public static int muted() {
		return UiStyle.color("paper.muted", 0xFF655E55);
	}

	public static int cream() {
		return UiStyle.color("palette.ui.panel", UiStyle.CREAM);
	}

	public static int panelHi() {
		return UiStyle.color("palette.ui.panel_hi", 0xFFFFFBF4);
	}

	public static int activityOnInk() {
		return UiStyle.color("ink_ui.activity", 0xFFC4BDB2);
	}

	/** Error text on paper (darker than the status red, 5.6:1 on cream). */
	public static int errorText() {
		return UiStyle.color("monitor.error", 0xFF9A2F2B);
	}

	/** Warning text on paper (a usage window past 80 %): the amber {@code paper.warn_fg}, clay-dark if the token is missing. */
	public static int warnText() {
		return UiStyle.color("paper.warn_fg", UiStyle.CLAY_DARK);
	}

	/** Positive text on paper ("sent", "pass"). */
	public static int okText() {
		return UiStyle.color("paper.add_fg", 0xFF455746);
	}

	/** Agent name colour on paper; the user ("user"/"you") in clay-dark. */
	public static int nameOnLight(@Nullable String agentId) {
		if (agentId == null || agentId.isEmpty()) {
			return ink();
		}
		if (isUser(agentId)) {
			return UiStyle.CLAY_DARK;
		}
		return UiStyle.agentOnLight(agentId);
	}

	public static int nameOnDark(@Nullable String agentId) {
		if (agentId == null || agentId.isEmpty()) {
			return cream();
		}
		if (isUser(agentId)) {
			return UiStyle.CLAY;
		}
		return UiStyle.agentOnDark(agentId);
	}

	public static boolean isUser(@Nullable String id) {
		return id != null && (id.equals("user") || id.equals("you") || id.equalsIgnoreCase(userName()));
	}

	/**
	 * The person the team works for, as the Foreman reports it (foreman.status userName, set with
	 * --user-name / AGENTCRAFT_USER_NAME; default the OS account name). "You" before the first status.
	 */
	public static String userName() {
		var st = Foreman.state().status();
		String n = st == null ? null : st.userName();
		return n == null || n.isBlank() ? "You" : n;
	}

	/** Display name of an agent id (Foreman name, then cast name, then the id). */
	public static String agentName(@Nullable String agentId) {
		if (agentId == null || agentId.isEmpty()) {
			return "";
		}
		if (isUser(agentId)) {
			return "You";
		}
		if (agentId.equals("all")) {
			return "everyone";
		}
		Agent a = Foreman.state() == null ? null : Foreman.state().agent(agentId);
		if (a != null) {
			return a.name();
		}
		Cast.Member m = Cast.get(agentId);
		if (m != null) {
			return m.name();
		}
		return Character.toUpperCase(agentId.charAt(0)) + agentId.substring(1);
	}

	// ------------------------------------------------------------------ portraits

	private static Identifier portraitTexture(String agentId, boolean framed) {
		return AgentCraft.id("textures/gui/portrait/" + agentId + (framed ? "_framed" : "") + ".png");
	}

	public static boolean hasPortrait(@Nullable String agentId) {
		return agentId != null && Cast.get(agentId) != null;
	}

	/**
	 * The agent's 8x8 face at {@code scale} (1 = 8 px). Unknown agents (or the user) get a small
	 * round placeholder in their colour so rows stay aligned.
	 */
	public static void face(GuiGraphicsExtractor g, @Nullable String agentId, int x, int y, int scale) {
		int s = 8 * Math.max(1, scale);
		if (hasPortrait(agentId)) {
			g.blit(RenderPipelines.GUI_TEXTURED, portraitTexture(agentId, false), x, y, 0, 0, s, s, 8, 8, 8, 8);
			return;
		}
		// placeholder: a status-style dot centred in the face box
		int d = Math.min(7, s);
		Panels.sprite(g, Kit.dot(isUser(agentId) ? "waiting" : "idle", false), x + (s - d) / 2, y + (s - d) / 2, 7, 7);
	}

	/** The 20x20 framed portrait (brass rim + identity ring) at {@code scale}. */
	public static void framedPortrait(GuiGraphicsExtractor g, @Nullable String agentId, int x, int y, int scale) {
		int s = 20 * Math.max(1, scale);
		if (hasPortrait(agentId)) {
			g.blit(RenderPipelines.GUI_TEXTURED, portraitTexture(agentId, true), x, y, 0, 0, s, s, 20, 20, 20, 20);
			return;
		}
		Panels.sprite(g, Kit.PANEL_INSET, x, y, s, s);
		face(g, agentId, x + (s - 8 * scale) / 2, y + (s - 8 * scale) / 2, scale);
	}

	// ------------------------------------------------------------------ keycaps, buttons, chips

	/** A keycap with its label; returns the width drawn. */
	public static int keycap(GuiGraphicsExtractor g, Font font, String key, int x, int y) {
		Kit.Padding p = Kit.padding("keycap");
		int w = Math.max(12, font.width(key) + p.left() + p.right());
		Panels.sprite(g, Kit.KEYCAP, x, y, w, 12);
		g.text(font, key, x + (w - font.width(key)) / 2, y + p.top(), UiStyle.color("palette.ui.text", 0xFF34312E), false);
		return w;
	}

	public static int keycapWidth(Font font, String key) {
		Kit.Padding p = Kit.padding("keycap");
		return Math.max(12, font.width(key) + p.left() + p.right());
	}

	/**
	 * A row of "[key] verb" hints; returns the total width. {@code onDark} picks the verb colour for
	 * ink surfaces (tooltips, HUD).
	 */
	public static int hints(GuiGraphicsExtractor g, Font font, int x, int y, boolean onDark, String... keyThenVerb) {
		int cx = x;
		for (int i = 0; i + 1 < keyThenVerb.length; i += 2) {
			cx += keycap(g, font, keyThenVerb[i], cx, y) + 3;
			String verb = keyThenVerb[i + 1];
			g.text(font, verb, cx, y + 2, onDark ? activityOnInk() : muted(), false);
			cx += font.width(verb) + 9;
		}
		return cx - x - 9;
	}

	public static int hintsWidth(Font font, String... keyThenVerb) {
		int w = 0;
		for (int i = 0; i + 1 < keyThenVerb.length; i += 2) {
			w += keycapWidth(font, keyThenVerb[i]) + 3 + font.width(keyThenVerb[i + 1]) + 9;
		}
		return Math.max(0, w - 9);
	}

	/** Button visual state. */
	public enum ButtonState {
		NORMAL, HOVER, PRESSED, DISABLED
	}

	/**
	 * A 20 px kit button. {@code number} (1-9, or 0 for none) is drawn as a small muted prefix so the
	 * keyboard shortcut is discoverable; {@code danger} tints the label with the error colour.
	 */
	public static void button(GuiGraphicsExtractor g, Font font, String label, int number, int x, int y, int w, boolean primary, ButtonState st,
		boolean danger) {
		button(g, font, label, number, x, y, w, primary, st, danger, false);
	}

	/**
	 * A 20 px kit button; {@code focused} = the keyboard highlight (what Enter fires): a 2 px brass
	 * ring around the button, stronger than any fill, so it reads even next to the clay primary.
	 * Primary bodies are drawn in Clay-dark (cream label 4.7:1); hover lightens them only slightly.
	 */
	public static void button(GuiGraphicsExtractor g, Font font, String label, int number, int x, int y, int w, boolean primary, ButtonState st,
		boolean danger, boolean focused) {
		if (focused && st != ButtonState.DISABLED) {
			focusRing(g, x, y, w, 20);
		}
		if (primary) {
			switch (st) {
				case DISABLED -> Panels.sprite(g, Kit.button(true, "disabled"), x, y, w, 20);
				case PRESSED -> Panels.sprite(g, Kit.button(true, "pressed"), x, y, w, 20, PRIMARY_PRESSED_TINT);
				case HOVER -> Panels.sprite(g, Kit.button(true, "normal"), x, y, w, 20, PRIMARY_HOVER_TINT);
				default -> Panels.sprite(g, Kit.button(true, "normal"), x, y, w, 20, PRIMARY_TINT);
			}
		} else {
			String state = switch (st) {
				case HOVER -> "hover";
				case PRESSED -> "pressed";
				case DISABLED -> "disabled";
				default -> focused ? "hover" : "normal";
			};
			Panels.sprite(g, Kit.button(false, state), x, y, w, 20);
		}
		int dy = st == ButtonState.PRESSED ? 2 : 0;
		int labelColor;
		int numColor;
		if (st == ButtonState.DISABLED) {
			labelColor = primary ? cream() : UiStyle.color("paper.disabled", 0xFFA39B8E);
			numColor = labelColor;
		} else if (primary) {
			labelColor = panelHi();
			numColor = UiStyle.withAlpha(panelHi(), 200);
		} else {
			labelColor = danger ? errorText() : ink();
			numColor = muted();
		}
		String num = number > 0 ? Integer.toString(number) : "";
		int numW = num.isEmpty() ? 0 : font.width(num) + 5;
		String l = TextUtil.ellipsize(font, label, w - 12 - numW);
		int total = numW + font.width(l);
		int tx = x + (w - total) / 2;
		if (!num.isEmpty()) {
			g.text(font, num, tx, y + 6 + dy, numColor, false);
		}
		g.text(font, l, tx + numW, y + 6 + dy, labelColor, false);
	}

	/** A 2 px brass focus ring just outside a w x h rect (corners left open, so it reads as rounded), with a walnut hairline outside it. */
	public static void focusRing(GuiGraphicsExtractor g, int x, int y, int w, int h) {
		int brass = UiStyle.BRASS;
		int edge = UiStyle.withAlpha(UiStyle.WALNUT, 150);
		// walnut hairline (outermost), then the 2 px brass band
		g.fill(x - 2, y - 4, x + w + 2, y - 3, edge);
		g.fill(x - 2, y + h + 3, x + w + 2, y + h + 4, edge);
		g.fill(x - 4, y - 2, x - 3, y + h + 2, edge);
		g.fill(x + w + 3, y - 2, x + w + 4, y + h + 2, edge);
		g.fill(x - 2, y - 3, x + w + 2, y - 1, brass);
		g.fill(x - 2, y + h + 1, x + w + 2, y + h + 3, brass);
		g.fill(x - 3, y - 2, x - 1, y + h + 2, brass);
		g.fill(x + w + 1, y - 2, x + w + 3, y + h + 2, brass);
	}

	public static int buttonWidth(Font font, String label, int number) {
		int numW = number > 0 ? font.width(Integer.toString(number)) + 5 : 0;
		return Math.max(52, font.width(label) + numW + 16);
	}

	/** A pill chip with a status dot and text; returns the width. */
	public static int dotPill(GuiGraphicsExtractor g, Font font, String family, String text, int x, int y, int textArgb) {
		Kit.Padding p = Kit.padding("pill");
		int w = p.left() + 7 + 3 + font.width(text) + p.right();
		Panels.sprite(g, Kit.PILL, x, y, w, 11);
		Panels.sprite(g, Kit.dot(family, false), x + p.left() - 1, y + 2, 7, 7);
		g.text(font, text, x + p.left() + 9, y + p.top(), textArgb, false);
		return w;
	}

	public static int dotPillWidth(Font font, String text) {
		Kit.Padding p = Kit.padding("pill");
		return p.left() + 7 + 3 + font.width(text) + p.right();
	}

	/** A status dot with a pulsing halo (the waiting pulse: alpha 0..110 over 1200 ms, ease in-out). */
	public static void pulsingDot(GuiGraphicsExtractor g, String family, int x, int y) {
		float t = pulse();
		Panels.sprite(g, Kit.dot(family, true), x - 2, y - 2, 11, 11, ((int) (110 * t + 40) << 24) | 0xFFFFFF);
		Panels.sprite(g, Kit.dot(family, false), x, y, 7, 7);
	}

	/** 0..1 ease-in-out pulse with the ui-style period. */
	public static float pulse() {
		int period = UiStyle.metric("metrics.pulse_ms", 1200);
		double ph = (Util.getMillis() % period) / (double) period;
		return (float) (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
	}

	public static boolean caretOn(long sinceMs) {
		int blink = UiStyle.metric("metrics.caret_blink_ms", 500);
		return ((Util.getMillis() - sinceMs) / blink) % 2 == 0;
	}

	// ------------------------------------------------------------------ text

	/** "now", "12s", "4m", "2h", "3d" ago. */
	public static String ago(long ts) {
		long d = Math.max(0, System.currentTimeMillis() - ts) / 1000;
		if (d < 10) {
			return "just now";
		}
		if (d < 60) {
			return d + "s ago";
		}
		if (d < 3600) {
			return d / 60 + "m ago";
		}
		if (d < 86400) {
			return d / 3600 + "h ago";
		}
		return d / 86400 + "d ago";
	}

	public static String clock(long ts) {
		return LocalTime.ofInstant(Instant.ofEpochMilli(ts), ZoneId.systemDefault()).format(HHMM);
	}

	/** First line, collapsed whitespace. */
	public static String oneLine(@Nullable String s) {
		if (s == null) {
			return "";
		}
		return s.replace('\n', ' ').replace('\r', ' ').replaceAll("\\s{2,}", " ").trim();
	}

	public static String plural(int n, String one, String many) {
		return n + " " + (n == 1 ? one : many);
	}
}
