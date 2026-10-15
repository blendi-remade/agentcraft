package dev.agentcraft.client.ui;

import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.resources.Identifier;

/**
 * GUI drawing with the kit (screens and HUD). All coordinates are GUI pixels; sprites are authored
 * at 1 texel = 1 GUI pixel, nine-sliced by vanilla where they ship slice metadata.
 *
 * <pre>
 * Panels.panel(g, x, y, w, h);                          // paper window background
 * Panels.text(g, font, "Kit", x, y, UiStyle.agentOnLight("kit"));
 * Panels.button(g, font, "Merge", x, y, w, true, hovered, false);
 * Panels.progress(g, x, y, w, 0.4, "teal");
 * Panels.scrollbar(g, x, y, h, scroll);                 // TextUtil.Scroll model
 * </pre>
 */
public final class Panels {
	private Panels() {
	}

	public static void sprite(GuiGraphicsExtractor g, Identifier sprite, int x, int y, int w, int h) {
		g.blitSprite(RenderPipelines.GUI_TEXTURED, sprite, x, y, w, h);
	}

	public static void sprite(GuiGraphicsExtractor g, Identifier sprite, int x, int y, int w, int h, int argb) {
		g.blitSprite(RenderPipelines.GUI_TEXTURED, sprite, x, y, w, h, argb);
	}

	/** Matte paper window (soft shadow included in the sprite). */
	public static void panel(GuiGraphicsExtractor g, int x, int y, int w, int h) {
		sprite(g, Kit.PANEL_PAPER, x, y, w, h);
	}

	/** Brass-framed window for things that need attention (decisions, merges). */
	public static void framed(GuiGraphicsExtractor g, int x, int y, int w, int h) {
		sprite(g, Kit.FRAME_BRASS, x, y, w, h);
	}

	/** Recessed well for logs, lists, diff bodies. */
	public static void inset(GuiGraphicsExtractor g, int x, int y, int w, int h) {
		sprite(g, Kit.PANEL_INSET, x, y, w, h);
	}

	/** Title strip with clay underline (14 px tall), with the title in ink. */
	public static void header(GuiGraphicsExtractor g, Font font, String title, int x, int y, int w) {
		sprite(g, Kit.HEADER, x, y, w, 14);
		Kit.Padding p = Kit.padding("header");
		text(g, font, TextUtil.ellipsize(font, title, w - p.left() - p.right()), x + p.left(), y + p.top() + 1, UiStyle.color("paper.text"));
	}

	public static void divider(GuiGraphicsExtractor g, int x, int y, int w) {
		sprite(g, Kit.DIVIDER, x, y, w, 3);
	}

	/** Flat text, no drop shadow (paper UI never uses shadows). */
	public static void text(GuiGraphicsExtractor g, Font font, String s, int x, int y, int argb) {
		g.text(font, s, x, y, argb, false);
	}

	/** A 20 px kit button with a centred label. Returns nothing; hit-test it yourself. */
	public static void button(GuiGraphicsExtractor g, Font font, String label, int x, int y, int w, boolean primary, boolean hovered,
		boolean disabled) {
		String state = disabled ? "disabled" : hovered ? "hover" : "normal";
		sprite(g, Kit.button(primary, state), x, y, w, 20);
		int color = disabled ? UiStyle.color("paper.disabled") : primary ? 0xFFFFFBF4 : UiStyle.color("paper.text"); // cream on the clay button (palette.ui.highlight is the clay itself)
		String l = TextUtil.ellipsize(font, label, w - 12);
		text(g, font, l, x + (w - font.width(l)) / 2, y + 6, color);
	}

	/** 7x7 status dot (11x11 halo when {@code halo}), top-left at x,y. */
	public static void dot(GuiGraphicsExtractor g, String family, int x, int y, boolean halo) {
		int s = halo ? 11 : 7;
		sprite(g, Kit.dot(family, halo), x, y, s, s);
	}

	/** 6 px progress bar, {@code p} in 0..1, fill tint brass|clay|red|sage|teal. */
	public static void progress(GuiGraphicsExtractor g, int x, int y, int w, double p, String tint) {
		sprite(g, Kit.PROGRESS_TRACK, x, y, w, 6);
		int fw = (int) Math.round(Math.max(0, Math.min(1, p)) * w);
		if (fw >= 4) {
			sprite(g, Kit.progressFill(tint), x, y, fw, 6);
		}
	}

	/** Pill badge with text (e.g. @agent, branch); returns its width. */
	public static int pill(GuiGraphicsExtractor g, Font font, String s, int x, int y, int textArgb) {
		Kit.Padding p = Kit.padding("pill");
		int w = font.width(s) + p.left() + p.right();
		sprite(g, Kit.PILL, x, y, w, 11);
		text(g, font, s, x + p.left(), y + p.top(), textArgb);
		return w;
	}

	/** 6 px vertical scrollbar for a scroll model (nothing drawn when everything fits). */
	public static void scrollbar(GuiGraphicsExtractor g, int x, int y, int h, TextUtil.Scroll scroll, boolean hovered) {
		if (!scroll.scrollable()) {
			return;
		}
		sprite(g, Kit.SCROLL_TRACK, x, y, 6, h);
		int thumbH = Math.max(8, (int) Math.round((double) h * scroll.view() / scroll.content()));
		int travel = h - thumbH;
		int ty = y + (int) Math.round(travel * scroll.fraction());
		sprite(g, hovered ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, x, ty, 6, thumbH);
		if (thumbH >= 10) {
			sprite(g, Kit.SCROLL_GRIP, x + 2, ty + thumbH / 2 - 1, 2, 3);
		}
	}
}
