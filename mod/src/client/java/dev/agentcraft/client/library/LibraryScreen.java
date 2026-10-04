package dev.agentcraft.client.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.diff.ReviewKit;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * The memory library: every memory entry (shared + per agent) in a two-pane reader. Left: the list
 * (the lead's plan pinned on top, then newest first; title, author face + name, scope, age, a clay
 * dot on fresh notes) under scope tabs; right: the selected entry rendered as markdown (headings,
 * lists, code, tables, quotes) with live task-status dots after task ids in the plan.
 *
 * <pre>
 * keys: Up/Down entry · Tab / 1-9 scope · j k / wheel / PgUp PgDn scroll · c copy markdown · Esc close
 * </pre>
 */
public final class LibraryScreen extends Screen {
	private static final int ROW_H = 39;

	private String scope;
	private @Nullable String selectedId;
	private List<MemoryEntry> entries = List.of();
	private long seenRevision = -1;
	private @Nullable MdLayout body;
	private @Nullable String bodyKey;
	private float scroll;
	private float scrollTarget;
	private float listScroll;
	private long lastNanos;
	private boolean dragThumb;
	private double dragOffset;
	private @Nullable String flash;
	private long flashUntil;
	private final List<int[]> tabRects = new ArrayList<>();
	private final List<String> tabScopes = new ArrayList<>();

	// layout
	private int px;
	private int py;
	private int pw;
	private int ph;
	private int ix;
	private int iy;
	private int iw;
	private int ih;
	private int bodyY;
	private int bodyBottom;
	private int listW;
	private int readerX;
	private int readerW;
	private int textX;
	private int textW;
	private int textY;
	private int textH;

	public LibraryScreen(@Nullable String scope, @Nullable String memoryId) {
		super(Component.literal("Memory library"));
		this.scope = scope == null ? MemoryIndex.ALL : scope;
		this.selectedId = memoryId;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	public String scope() {
		return scope;
	}

	// ------------------------------------------------------------------ model

	private void refresh() {
		ForemanState s = Foreman.state();
		long rev = s == null ? 0 : s.revision();
		if (rev == seenRevision) {
			return;
		}
		seenRevision = rev;
		entries = MemoryIndex.entries(scope);
		if (selectedId == null || entries.stream().noneMatch(e -> e.id().equals(selectedId))) {
			MemoryEntry plan = null;
			for (MemoryEntry e : entries) {
				if (MemoryIndex.isPlan(e)) {
					plan = e;
					break;
				}
			}
			selectedId = plan != null ? plan.id() : entries.isEmpty() ? null : entries.get(0).id();
		}
	}

	private @Nullable MemoryEntry selected() {
		if (selectedId == null) {
			return null;
		}
		for (MemoryEntry e : entries) {
			if (e.id().equals(selectedId)) {
				return e;
			}
		}
		return null;
	}

	private int selectedIndex() {
		for (int i = 0; i < entries.size(); i++) {
			if (entries.get(i).id().equals(selectedId)) {
				return i;
			}
		}
		return -1;
	}

	private void ensureBody() {
		MemoryEntry e = selected();
		if (e == null) {
			body = null;
			bodyKey = null;
			return;
		}
		// task ids in a note ("t3") get a live status dot: the plan reads as a progress report
		Set<String> taskIds = new HashSet<>();
		if (Foreman.state() != null) {
			taskIds.addAll(Foreman.state().tasks().keySet());
		}
		String key = e.id() + "@" + e.updated() + "#" + textW + ":" + taskIds.size();
		if (key.equals(bodyKey)) {
			return;
		}
		boolean sameEntry = bodyKey != null && bodyKey.startsWith(e.id() + "@");
		List<Markdown.Block> blocks = Markdown.parse(e.body());
		// the first heading usually repeats the title: the reader shows the title already
		if (!blocks.isEmpty() && blocks.get(0).type == Markdown.Type.H1 && norm(Markdown.plain(blocks.get(0).text)).equals(norm(e.title()))) {
			blocks = blocks.subList(1, blocks.size());
		}
		body = MdLayout.build(font, blocks, textW, taskIds);
		bodyKey = key;
		if (!sameEntry) {
			scroll = scrollTarget = 0;
		}
	}

	private final java.util.Map<String, String> excerpts = new java.util.HashMap<>();

	/** First line of prose of an entry (headings skipped), plain text, for the list. */
	private String excerpt(MemoryEntry e) {
		return excerpts.computeIfAbsent(e.id() + "@" + e.updated(), k -> {
			for (Markdown.Block b : Markdown.parse(e.body())) {
				switch (b.type) {
					case PARA, BULLET, NUMBER, TASK, QUOTE -> {
						String t = Markdown.plain(b.text).replaceAll("\\s+", " ").trim();
						if (!t.isEmpty() && !norm(t).equals(norm(e.title()))) {
							return t;
						}
					}
					default -> {
					}
				}
			}
			return "";
		});
	}

	private static String norm(String s) {
		return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9#]+", " ").trim();
	}

	private void select(int index) {
		if (entries.isEmpty()) {
			return;
		}
		int i = Math.max(0, Math.min(entries.size() - 1, index));
		selectedId = entries.get(i).id();
		int y = i * ROW_H;
		int lh = bodyBottom - bodyY;
		if (y < listScroll) {
			listScroll = y;
		} else if (y + ROW_H > listScroll + lh) {
			listScroll = y + ROW_H - lh;
		}
	}

	private void setScope(String s) {
		scope = s;
		seenRevision = -1;
		listScroll = 0;
		refresh();
	}

	// ------------------------------------------------------------------ layout

	@Override
	protected void init() {
		int margin = width >= 900 ? 16 : width >= 560 ? 10 : 6;
		pw = Math.min(width - 2 * margin, 1000);
		ph = Math.min(height - 2 * Math.max(6, margin - 2), 620);
		px = (width - pw) / 2;
		py = (height - ph) / 2;
		ix = px + 8;
		iy = py + 8;
		iw = pw - 16;
		ih = ph - 17;
		bodyY = iy + 42;
		bodyBottom = iy + ih - 17;
		listW = Math.max(120, Math.min(290, Math.round(iw * 0.33f)));
		readerX = ix + listW + 6;
		readerW = ix + iw - readerX;
		textX = readerX + 11;
		// a comfortable measure: about 100 characters at most, however wide the screen
		textW = Math.min(readerW - 22 - 6, 600);
		textY = bodyY + 38;
		textH = bodyBottom - 6 - textY;
		bodyKey = null;
	}

	private int maxScroll() {
		return body == null ? 0 : Math.max(0, body.height - textH);
	}

	// ------------------------------------------------------------------ frame

	private void animate() {
		long now = System.nanoTime();
		float dt = lastNanos == 0 ? 0.016f : Math.min(0.1f, (now - lastNanos) / 1e9f);
		lastNanos = now;
		float k = 1 - (float) Math.exp(-dt * 16);
		scrollTarget = Math.max(0, Math.min(scrollTarget, maxScroll()));
		scroll += (scrollTarget - scroll) * k;
		if (Math.abs(scrollTarget - scroll) < 0.25f) {
			scroll = scrollTarget;
		}
	}

	private float snap(float v) {
		int s = Math.max(1, minecraft.getWindow().getGuiScale());
		return Math.round(v * s) / (float) s;
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		if (ReviewKit.blurBehind) {
			extractBlurredBackground(g);
		}
		g.fill(0, 0, width, height, UiStyle.withAlpha(UiStyle.WALNUT, 0x7A));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		refresh();
		ensureBody();
		animate();
		Panels.panel(g, px, py, pw, ph);
		drawHeader(g);
		drawTabs(g, mx, my);
		drawList(g, mx, my);
		drawReader(g, mx, my);
		drawFooter(g);
		super.extractRenderState(g, mx, my, a);
	}

	private void drawHeader(GuiGraphicsExtractor g) {
		Panels.sprite(g, Kit.HEADER, ix, iy, iw, 14);
		Panels.sprite(g, Kit.icon("memory"), ix + 4, iy + 1, 12, 12);
		ReviewKit.bold(g, font, "Memory library", ix + 20, iy + 3, ReviewKit.ink());
		int n = MemoryIndex.count(MemoryIndex.ALL);
		long newest = MemoryIndex.newest(MemoryIndex.ALL);
		String right = n == 0 ? "empty" : n + (n == 1 ? " note" : " notes") + (newest > 0 ? " · updated " + ReviewKit.ago(newest) : "");
		ForemanState s = Foreman.state();
		if (s != null && s.isStale()) {
			right = "Foreman offline, last known · " + right;
		}
		g.text(font, right, ix + iw - 5 - font.width(right), iy + 3, ReviewKit.muted(), false);
	}

	private void drawTabs(GuiGraphicsExtractor g, int mx, int my) {
		tabRects.clear();
		tabScopes.clear();
		int y = iy + 18;
		int x = ix;
		int edge = UiStyle.color("palette.ui.panel_edge");
		g.fill(ix, y + 19, ix + iw, y + 20, edge);
		List<String> scopes = new ArrayList<>();
		scopes.add(MemoryIndex.ALL);
		scopes.addAll(MemoryIndex.scopes());
		if (!scopes.contains(scope)) {
			scopes.add(scope);
		}
		for (String sc : scopes) {
			boolean active = sc.equals(scope);
			String label = MemoryIndex.scopeLabel(sc);
			String count = String.valueOf(MemoryIndex.count(sc));
			boolean agent = !sc.isEmpty() && !sc.equals("shared");
			int w = 12 + (agent ? 11 : 0) + font.width(label) + 5 + font.width(count);
			if (x + w > ix + iw) {
				break;
			}
			int ty = active ? y : y + 2;
			Panels.sprite(g, active ? Kit.TAB_ACTIVE : Kit.TAB_INACTIVE, x, ty, w, active ? 20 : 18);
			int tx = x + 6;
			int textY0 = y + 7;
			if (agent) {
				ReviewKit.face(g, font, sc, tx, textY0 - 1, 8);
				tx += 11;
			}
			int labelColor = active ? (agent ? ReviewKit.agentInk(sc) : ReviewKit.ink()) : ReviewKit.muted();
			g.text(font, label, tx, textY0, labelColor, false);
			tx += font.width(label) + 5;
			g.text(font, count, tx, textY0, active ? ReviewKit.muted() : UiStyle.color("paper.disabled"), false);
			tabRects.add(new int[] {x, y, w, 20});
			tabScopes.add(sc);
			x += w + 2;
		}
	}

	private void drawList(GuiGraphicsExtractor g, int mx, int my) {
		int x = ix;
		int w = listW;
		int top = bodyY;
		int h = bodyBottom - bodyY;
		int content = entries.size() * ROW_H;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, content - h)));
		int muted = ReviewKit.muted();
		if (entries.isEmpty()) {
			String m = scope.isEmpty() ? "No notes yet" : "No notes in this scope";
			g.text(font, m, x + 6, top + 8, muted, false);
			return;
		}
		g.enableScissor(x, top, x + w, top + h);
		for (int i = 0; i < entries.size(); i++) {
			MemoryEntry e = entries.get(i);
			int y = top + i * ROW_H - Math.round(listScroll);
			if (y + ROW_H < top || y > top + h) {
				continue;
			}
			boolean sel = e.id().equals(selectedId);
			boolean hov = mx >= x && mx < x + w && my >= y && my < y + ROW_H && my >= top && my < top + h;
			if (sel) {
				g.fill(x, y, x + w, y + ROW_H - 1, UiStyle.color("palette.ui.panel_hi"));
				g.fill(x, y, x + 2, y + ROW_H - 1, UiStyle.CLAY);
			} else if (hov) {
				g.fill(x, y, x + w, y + ROW_H - 1, UiStyle.color("palette.ui.panel_shade"));
			}
			int tx = x + 7;
			int right = x + w - 5;
			if (MemoryIndex.isUnread(e) && !sel) {
				// written since you last read it: a quiet clay "NEW" tab (not a status dot)
				String nw = "NEW";
				int nwW = font.width(nw) + 6;
				ReviewKit.chip(g, font, nw, right - nwW, y + 3, ReviewKit.mix(UiStyle.color("palette.ui.panel"), UiStyle.CLAY, 0.2f), UiStyle.color(
					"paper.link"));
				right -= nwW + 4;
			}
			if (MemoryIndex.isPlan(e)) {
				int cw = ReviewKit.chip(g, font, "PLAN", tx, y + 3, ReviewKit.mix(UiStyle.color("palette.ui.panel"), UiStyle.BRASS, 0.32f), UiStyle.color(
					"paper.path"));
				tx += cw + 4;
			}
			g.text(font, TextUtil.ellipsize(font, e.title(), right - tx), tx, y + 5, ReviewKit.ink(), false);
			// author face + name · scope · age
			String author = e.author() != null ? e.author() : e.scope().equals("shared") ? null : e.scope();
			int ay = y + 16;
			int ax = x + 7;
			if (author != null) {
				ReviewKit.face(g, font, author, ax, ay - 1, 8);
				ax += 11;
				String name = ReviewKit.agentName(author);
				g.text(font, name, ax, ay, ReviewKit.agentInk(author), false);
				ax += font.width(name);
			}
			StringBuilder meta = new StringBuilder();
			if (scope.isEmpty()) {
				meta.append(author != null ? " · " : "").append(e.scope().equals("shared") ? "shared" : "private");
			}
			String age = ReviewKit.ago(e.updated());
			if (!age.isEmpty()) {
				meta.append(meta.isEmpty() && author == null ? "" : " · ").append(age);
			}
			g.text(font, TextUtil.ellipsize(font, meta.toString(), x + w - 5 - ax), ax, ay, muted, false);
			g.text(font, TextUtil.ellipsize(font, excerpt(e), w - 13), x + 7, y + 27, muted, false);
			g.fill(x + 4, y + ROW_H - 1, x + w - 4, y + ROW_H, UiStyle.color("palette.ui.panel_shade"));
		}
		g.disableScissor();
		if (content > h) {
			int thumbH = Math.max(10, h * h / content);
			int ty = top + Math.round((h - thumbH) * (listScroll / Math.max(1, content - h)));
			g.fill(x + w - 2, ty, x + w, ty + thumbH, UiStyle.color("palette.ui.thumb"));
		}
	}

	private void drawReader(GuiGraphicsExtractor g, int mx, int my) {
		int x = readerX;
		int y = bodyY;
		int w = readerW;
		int h = bodyBottom - bodyY;
		// a sheet of paper: highlight paper, hairline edge, soft bottom shadow
		g.fill(x, y, x + w, y + h, UiStyle.color("palette.ui.panel_hi"));
		ReviewKit.outline(g, x, y, w, h, UiStyle.color("palette.ui.panel_edge"));
		g.fill(x + 1, y + h, x + w, y + h + 1, UiStyle.withAlpha(UiStyle.color("palette.ui.paper_deep"), 0xA0));
		MemoryEntry e = selected();
		int muted = ReviewKit.muted();
		if (e != null) {
			MemoryIndex.markSeen(e);
		}
		if (e == null) {
			String m1 = "No memory yet";
			String m2 = "The lead writes the plan here when you give the team a goal.";
			g.text(font, m1, x + (w - font.width(m1)) / 2, y + h / 2 - 10, ReviewKit.ink(), false);
			String m = TextUtil.ellipsize(font, m2, w - 20);
			g.text(font, m, x + (w - font.width(m)) / 2, y + h / 2 + 2, muted, false);
			return;
		}
		// title + meta (fixed), then the scrolling body
		int tx = textX;
		int ty = y + 8;
		String title = e.title();
		int titleW = textW;
		String scopeText = e.scope().equals("shared") ? "shared" : "private to " + ReviewKit.agentName(e.scope());
		ReviewKit.bold(g, font, TextUtil.ellipsize(font, title, titleW), tx, ty, ReviewKit.ink());
		int my0 = ty + 13;
		int ax = tx;
		if (e.author() != null) {
			ReviewKit.face(g, font, e.author(), ax, my0 - 1, 8);
			ax += 11;
			String name = ReviewKit.agentName(e.author());
			g.text(font, name, ax, my0, ReviewKit.agentInk(e.author()), false);
			ax += font.width(name) + 4;
		}
		String meta = "updated " + ReviewKit.ago(e.updated()) + " · " + scopeText;
		g.text(font, TextUtil.ellipsize(font, meta, tx + textW - ax), ax, my0, muted, false);
		Panels.divider(g, tx, my0 + 11, textW + 6);
		if (body == null) {
			return;
		}
		float sy = snap(scroll);
		int base = (int) Math.floor(sy);
		float frac = sy - base;
		g.enableScissor(tx - 4, textY, x + w - 8, textY + textH);
		g.pose().pushMatrix();
		g.pose().translate(0, -frac);
		body.draw(g, font, tx, textY, base, textH, this::taskFamily);
		g.pose().popMatrix();
		g.disableScissor();
		// soft paper fades where the text runs under the edges
		int hi = UiStyle.color("palette.ui.panel_hi");
		if (scroll > 0.5f) {
			g.fillGradient(tx - 4, textY, x + w - 9, textY + 7, hi, UiStyle.withAlpha(hi, 0));
		}
		if (scroll < maxScroll() - 0.5f) {
			g.fillGradient(tx - 4, textY + textH - 9, x + w - 9, textY + textH, UiStyle.withAlpha(hi, 0), hi);
		}
		if (body.height > textH) {
			int sbx = x + w - 8;
			Panels.sprite(g, Kit.SCROLL_TRACK, sbx, textY, 6, textH);
			int thumbH = Math.max(10, textH * textH / body.height);
			int thy = textY + Math.round((textH - thumbH) * (scroll / Math.max(1, maxScroll())));
			boolean hov = mx >= sbx && mx < sbx + 6 && my >= textY && my < textY + textH;
			Panels.sprite(g, hov || dragThumb ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, sbx, thy, 6, thumbH);
			if (thumbH >= 10) {
				Panels.sprite(g, Kit.SCROLL_GRIP, sbx + 2, thy + thumbH / 2 - 1, 2, 3);
			}
		}
	}

	private @Nullable String taskFamily(String taskId) {
		ForemanState s = Foreman.state();
		Protocol.Task t = s == null ? null : s.task(taskId);
		if (t == null) {
			return null;
		}
		return dev.agentcraft.client.ui.StatusMap.task(s, t);
	}

	private void drawFooter(GuiGraphicsExtractor g) {
		int y = iy + ih - 12;
		long now = System.currentTimeMillis();
		if (flash != null && now < flashUntil) {
			g.text(font, flash, ix + iw - font.width(flash), y + 2, UiStyle.color("paper.add_fg"), false);
		}
		String[][] hints = {{"↑ ↓", "note"}, {"Tab", "scope"}, {"j k", "scroll"}, {"c", "copy"}, {"Esc", "close"}};
		int x = ix;
		int limit = flash != null && now < flashUntil ? ix + iw - font.width(flash) - 10 : ix + iw;
		for (String[] h : hints) {
			int w = ReviewKit.hintWidth(font, h[0], h[1]);
			if (x + w > limit) {
				break;
			}
			ReviewKit.hint(g, font, h[0], h[1], x, y);
			x += w + 10;
		}
	}

	// ------------------------------------------------------------------ input

	private void scrollBy(float px) {
		scrollTarget = Math.max(0, Math.min(maxScroll(), scrollTarget + px));
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		int k = e.input();
		if (e.isEscape()) {
			onClose();
			return true;
		}
		boolean shift = e.hasShiftDown();
		int page = Math.max(MdLayout.LINE_H, textH - 2 * MdLayout.LINE_H);
		switch (k) {
			case InputConstants.KEY_DOWN -> select(selectedIndex() + 1);
			case InputConstants.KEY_UP -> select(selectedIndex() - 1);
			case InputConstants.KEY_J -> scrollBy(MdLayout.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_K -> scrollBy(-MdLayout.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_PAGEDOWN -> scrollBy(page);
			case InputConstants.KEY_PAGEUP -> scrollBy(-page);
			case InputConstants.KEY_SPACE -> scrollBy(shift ? -page : page);
			case InputConstants.KEY_HOME -> scrollTarget = 0;
			case InputConstants.KEY_END -> scrollTarget = maxScroll();
			case InputConstants.KEY_G -> scrollTarget = shift ? maxScroll() : 0;
			case InputConstants.KEY_TAB -> cycleScope(shift ? -1 : 1);
			case InputConstants.KEY_C -> copy();
			default -> {
				if (k >= InputConstants.KEY_1 && k <= InputConstants.KEY_1 + 8) {
					int i = k - InputConstants.KEY_1;
					List<String> all = new ArrayList<>();
					all.add(MemoryIndex.ALL);
					all.addAll(MemoryIndex.scopes());
					if (i < all.size()) {
						setScope(all.get(i));
					}
					return true;
				}
				return super.keyPressed(e);
			}
		}
		return true;
	}

	private void cycleScope(int dir) {
		List<String> all = new ArrayList<>();
		all.add(MemoryIndex.ALL);
		all.addAll(MemoryIndex.scopes());
		int i = Math.max(0, all.indexOf(scope));
		setScope(all.get(Math.floorMod(i + dir, all.size())));
	}

	private void copy() {
		MemoryEntry e = selected();
		if (e == null) {
			return;
		}
		minecraft.keyboardHandler.setClipboard(e.body());
		flash = "Copied \"" + TextUtil.ellipsize(font, e.title(), 140) + "\" as markdown";
		flashUntil = System.currentTimeMillis() + 2500;
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		double mx = e.x();
		double my = e.y();
		if (e.button() == InputConstants.MOUSE_BUTTON_LEFT) {
			for (int i = 0; i < tabRects.size(); i++) {
				int[] r = tabRects.get(i);
				if (mx >= r[0] && mx < r[0] + r[2] && my >= r[1] && my < r[1] + r[3]) {
					setScope(tabScopes.get(i));
					return true;
				}
			}
			if (mx >= ix && mx < ix + listW && my >= bodyY && my < bodyBottom) {
				int i = (int) ((my - bodyY + listScroll) / ROW_H);
				if (i >= 0 && i < entries.size()) {
					select(i);
				}
				return true;
			}
			int sbx = readerX + readerW - 8;
			if (body != null && body.height > textH && mx >= sbx && mx < sbx + 6 && my >= textY && my < textY + textH) {
				int thumbH = Math.max(10, textH * textH / body.height);
				float thy = textY + (textH - thumbH) * (scroll / Math.max(1, maxScroll()));
				if (my >= thy && my < thy + thumbH) {
					dragThumb = true;
					dragOffset = my - thy;
				} else {
					scrollTarget = (float) ((my - textY - thumbH / 2.0) / Math.max(1, textH - thumbH)) * maxScroll();
				}
				return true;
			}
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseReleased(MouseButtonEvent e) {
		dragThumb = false;
		return super.mouseReleased(e);
	}

	@Override
	public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) {
		if (dragThumb && body != null) {
			int thumbH = Math.max(10, textH * textH / body.height);
			float f = (float) ((e.y() - dragOffset - textY) / Math.max(1, textH - thumbH));
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), f * maxScroll()));
			return true;
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		if (mx >= ix && mx < ix + listW && my >= bodyY && my < bodyBottom) {
			listScroll -= (float) (sy * ROW_H);
			return true;
		}
		scrollBy((float) (-sy * MdLayout.LINE_H * 3));
		return true;
	}

	// ------------------------------------------------------------------ dev / QA

	JsonObject stateJson() {
		refresh();
		ensureBody();
		JsonObject o = new JsonObject();
		o.addProperty("scope", scope);
		o.addProperty("selected", selectedId);
		o.addProperty("entries", entries.size());
		o.addProperty("scroll", scroll);
		o.addProperty("maxScroll", maxScroll());
		o.addProperty("bodyHeight", body == null ? 0 : body.height);
		JsonArray list = new JsonArray();
		for (MemoryEntry e : entries) {
			JsonObject j = new JsonObject();
			j.addProperty("id", e.id());
			j.addProperty("title", e.title());
			j.addProperty("scope", e.scope());
			j.addProperty("plan", MemoryIndex.isPlan(e));
			list.add(j);
		}
		o.add("list", list);
		JsonArray scopes = new JsonArray();
		MemoryIndex.scopes().forEach(scopes::add);
		o.add("scopes", scopes);
		return o;
	}

	void applyDev(@Nullable String scopeOpt, @Nullable String memoryId, @Nullable Float scrollPx) {
		if (scopeOpt != null) {
			setScope(scopeOpt.equals("all") ? MemoryIndex.ALL : scopeOpt);
		}
		if (memoryId != null) {
			selectedId = memoryId;
			seenRevision = -1;
			refresh();
		}
		ensureBody();
		if (scrollPx != null) {
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), scrollPx));
		}
	}
}
