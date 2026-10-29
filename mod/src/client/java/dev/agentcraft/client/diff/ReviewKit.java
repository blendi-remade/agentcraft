package dev.agentcraft.client.diff;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.Cast;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.Tr;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

/**
 * Paper-kit helpers shared by the review screens (diff + library): buttons with the right label
 * colours, keycap hints, agent portraits, relative times, derived tints. Everything colour-related
 * comes from {@link UiStyle} tokens (derived tints are mixes of two tokens).
 */
public final class ReviewKit {
	private static final Map<String, Boolean> HAS_PORTRAIT = new HashMap<>();
	/** Blur the world behind the review screens (vanilla menu blur) under their walnut wash. */
	public static boolean blurBehind = true;

	private ReviewKit() {
	}

	// ------------------------------------------------------------------ colours

	public static int ink() {
		return UiStyle.color("paper.text");
	}

	public static int muted() {
		return UiStyle.color("paper.muted");
	}

	public static int c(String token) {
		return UiStyle.color(token);
	}

	/** Linear mix of two opaque ARGB colours ({@code t} = 0 gives a, 1 gives b). */
	public static int mix(int a, int b, float t) {
		float u = Math.max(0, Math.min(1, t));
		int r = Math.round(((a >> 16) & 0xFF) * (1 - u) + ((b >> 16) & 0xFF) * u);
		int g = Math.round(((a >> 8) & 0xFF) * (1 - u) + ((b >> 8) & 0xFF) * u);
		int bl = Math.round((a & 0xFF) * (1 - u) + (b & 0xFF) * u);
		return 0xFF000000 | (r << 16) | (g << 8) | bl;
	}

	// ------------------------------------------------------------------ text

	public static void text(GuiGraphicsExtractor g, Font font, String s, int x, int y, int color) {
		g.text(font, s, x, y, color, false);
	}

	public static void bold(GuiGraphicsExtractor g, Font font, String s, int x, int y, int color) {
		g.text(font, Component.literal(s).withStyle(Style.EMPTY.withBold(true)), x, y, color, false);
	}

	public static int boldWidth(Font font, String s) {
		return font.width(Component.literal(s).withStyle(Style.EMPTY.withBold(true)));
	}

	/** A one-line title without inline markdown marks (`code`, **bold**), for headers and cards. */
	public static String plain(@Nullable String s) {
		if (s == null) {
			return "";
		}
		return s.replace("`", "").replace("**", "").replace("__", "");
	}

	/** Ellipsize from the left ("…/src/tags.ts"), for paths. */
	public static String ellipsizeLeft(Font font, String s, int maxWidth) {
		if (s == null) {
			return "";
		}
		if (font.width(s) <= maxWidth) {
			return s;
		}
		String e = TextUtil.ELLIPSIS;
		int ew = font.width(e);
		int i = 0;
		while (i < s.length() && font.width(s.substring(i)) + ew > maxWidth) {
			i++;
		}
		return i >= s.length() ? "" : e + s.substring(i);
	}

	// ------------------------------------------------------------------ widgets

	public enum ButtonKind {
		PRIMARY, NORMAL, DANGER
	}

	public static int buttonWidth(Font font, String label) {
		return Math.max(48, font.width(label) + 20);
	}

	/**
	 * A 20 px kit button. PRIMARY = clay call to action (cream label), NORMAL = paper, DANGER = paper
	 * with the deletion ink. {@code pressed} shows the sunk face (label +2 px).
	 */
	public static void button(GuiGraphicsExtractor g, Font font, String label, int x, int y, int w, ButtonKind kind, boolean hovered, boolean pressed,
		boolean disabled) {
		boolean primary = kind == ButtonKind.PRIMARY;
		String state = disabled ? "disabled" : pressed ? "pressed" : hovered ? "hover" : "normal";
		Panels.sprite(g, Kit.button(primary, state), x, y, w, 20);
		int color;
		if (disabled) {
			color = primary ? UiStyle.color("palette.ui.panel") : UiStyle.color("paper.disabled");
		} else if (primary) {
			color = UiStyle.color("palette.ui.panel_hi");
		} else if (kind == ButtonKind.DANGER) {
			color = UiStyle.color("paper.del_fg");
		} else {
			color = ink();
		}
		String l = TextUtil.ellipsize(font, label, w - 10);
		g.text(font, l, x + (w - font.width(l)) / 2, y + 6 + (pressed && !disabled ? 1 : 0), color, false);
	}

	/** A keycap with its label; returns its width. 12 px tall. */
	public static int keycap(GuiGraphicsExtractor g, Font font, String key, int x, int y) {
		int w = Math.max(12, font.width(key) + 7);
		Panels.sprite(g, Kit.KEYCAP, x, y, w, 12);
		g.text(font, key, x + (w - font.width(key) + 1) / 2, y + 2, ink(), false);
		return w;
	}

	public static int keycapWidth(Font font, String key) {
		return Math.max(12, font.width(key) + 7);
	}

	/** Keycap(s) + a muted verb ("j k  scroll"); keys separated by spaces become separate caps. Returns the width. */
	public static int hint(GuiGraphicsExtractor g, Font font, String keys, String verb, int x, int y) {
		int cx = x;
		for (String k : keys.split(" ")) {
			cx += keycap(g, font, k, cx, y) + 2;
		}
		g.text(font, verb, cx + 1, y + 2, muted(), false);
		return cx + 1 + font.width(verb) - x;
	}

	public static int hintWidth(Font font, String keys, String verb) {
		int w = 0;
		for (String k : keys.split(" ")) {
			w += keycapWidth(font, k) + 2;
		}
		return w + 1 + font.width(verb);
	}

	/** Small rounded badge (kit pill) with text; returns its width. 11 px tall. */
	public static int pill(GuiGraphicsExtractor g, Font font, String s, int x, int y, int textColor) {
		int w = font.width(s) + 8;
		Panels.sprite(g, Kit.PILL, x, y, w, 11);
		g.text(font, s, x + 4, y + 2, textColor, false);
		return w;
	}

	public static int pillWidth(Font font, String s) {
		return font.width(s) + 8;
	}

	/** A flat tinted chip (no sprite): fill + text, 11 px tall. Returns its width. */
	public static int chip(GuiGraphicsExtractor g, Font font, String s, int x, int y, int bg, int fg) {
		int w = font.width(s) + 6;
		g.fill(x, y, x + w, y + 11, bg);
		g.text(font, s, x + 3, y + 2, fg, false);
		return w;
	}

	/** Thin 1 px outline rectangle. */
	public static void outline(GuiGraphicsExtractor g, int x, int y, int w, int h, int color) {
		g.fill(x, y, x + w, y + 1, color);
		g.fill(x, y + h - 1, x + w, y + h, color);
		g.fill(x, y + 1, x + 1, y + h - 1, color);
		g.fill(x + w - 1, y + 1, x + w, y + h - 1, color);
	}

	// ------------------------------------------------------------------ agents

	public static String agentName(@Nullable String id) {
		if (id == null || id.isEmpty()) {
			return "";
		}
		if ("user".equals(id)) {
			return Tr.t("You");
		}
		Protocol.Agent a = Foreman.state() == null ? null : Foreman.state().agent(id);
		if (a != null) {
			return a.name();
		}
		Cast.Member m = Cast.get(id);
		return m != null ? m.name() : Character.toUpperCase(id.charAt(0)) + id.substring(1);
	}

	/** Agent name colour on paper (ink for unknown ids / "user"). */
	public static int agentInk(@Nullable String id) {
		return id == null || id.isEmpty() || "user".equals(id) ? ink() : UiStyle.agentOnLight(id);
	}

	/** Identity colour (scarf/badge) of an agent; idle grey when unknown. */
	public static int agentIdentity(@Nullable String id) {
		if (id != null) {
			int c = UiStyle.color("agents." + id + ".color", 0);
			if (c != 0) {
				return c;
			}
			Cast.Member m = Cast.get(id);
			if (m != null) {
				return 0xFF000000 | m.color();
			}
		}
		return UiStyle.status("idle");
	}

	private static boolean hasPortrait(String id) {
		return HAS_PORTRAIT.computeIfAbsent(id, k -> Minecraft.getInstance().getResourceManager()
			.getResource(AgentCraft.id("textures/gui/portrait/" + k + ".png")).isPresent());
	}

	/** The agent's 8x8 face scaled to {@code size} (8, 16, ...); a tinted initial for unknown agents. */
	public static void face(GuiGraphicsExtractor g, Font font, @Nullable String id, int x, int y, int size) {
		if (id != null && hasPortrait(id)) {
			Identifier tex = AgentCraft.id("textures/gui/portrait/" + id + ".png");
			g.blit(RenderPipelines.GUI_TEXTURED, tex, x, y, 0, 0, size, size, 8, 8, 8, 8);
			return;
		}
		g.fill(x, y, x + size, y + size, agentIdentity(id));
		String i = id == null || id.isEmpty() ? "?" : id.substring(0, 1).toUpperCase();
		g.text(font, i, x + (size - font.width(i) + 1) / 2, y + (size - 8) / 2 + 1, UiStyle.color("palette.ui.panel_hi"), false);
	}

	/** The 20x20 framed portrait (brass rim + identity ring). */
	public static void framedFace(GuiGraphicsExtractor g, Font font, @Nullable String id, int x, int y) {
		if (id != null && hasPortrait(id)) {
			Identifier tex = AgentCraft.id("textures/gui/portrait/" + id + "_framed.png");
			g.blit(RenderPipelines.GUI_TEXTURED, tex, x, y, 0, 0, 20, 20, 20, 20, 20, 20);
			return;
		}
		g.fill(x, y, x + 20, y + 20, UiStyle.BRASS);
		face(g, font, id, x + 2, y + 2, 16);
	}

	// ------------------------------------------------------------------ time

	/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
	public static String ago(long ts) {
		if (ts <= 0) {
			return "";
		}
		long s = Math.max(0, (System.currentTimeMillis() - ts) / 1000);
		if (s < 10) {
			return Tr.t("just now");
		}
		if (s < 60) {
			return s + Tr.t("s ago");
		}
		if (s < 3600) {
			return (s / 60) + Tr.t("m ago");
		}
		if (s < 86400) {
			return (s / 3600) + Tr.t("h ago");
		}
		return (s / 86400) + Tr.t("d ago");
	}

	// ------------------------------------------------------------------ CI

	/** Status family of a CI result (done / error / thinking / idle). */
	public static String ciFamily(Protocol.CiStatus ci) {
		return switch (ci) {
			case PASS -> "done";
			case FAIL -> "error";
			case RUNNING -> "thinking";
			default -> "idle";
		};
	}

	public static String ciLabel(Protocol.CiStatus ci) {
		return switch (ci) {
			case PASS -> Tr.t("tests pass");
			case FAIL -> Tr.t("tests failing");
			case RUNNING -> Tr.t("tests running");
			default -> Tr.t("no test run");
		};
	}

	/** Ink-safe text colour for a CI label on paper (status colours are too light for text). */
	public static int ciInk(Protocol.CiStatus ci) {
		return switch (ci) {
			case PASS -> UiStyle.color("paper.add_fg");
			case FAIL -> UiStyle.color("paper.del_fg");
			case RUNNING -> UiStyle.color("paper.path");
			default -> muted();
		};
	}
}
