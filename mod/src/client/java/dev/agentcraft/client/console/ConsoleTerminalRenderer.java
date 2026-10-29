package dev.agentcraft.client.console;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.Cast;
import dev.agentcraft.block.entity.ConsoleTerminalBlockEntity;
import dev.agentcraft.client.decisions.DecisionsFeature;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.FeedItem;
import dev.agentcraft.client.hud.Keys;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.resources.Identifier;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * Console terminal BER: the leaning paper screen is a small live console. A title band ("Console",
 * and a pulsing clay dot with the count while decisions wait), a news card (the newest feed item:
 * the agent's colour stripe, face and name, then the message on two lines; after a few seconds it
 * pages through the last {@value #FEED_ITEMS} items), and the prompt: your unsent draft or "Enter to
 * type" with a blinking caret. Text is 1/128 block per pixel. Drawn full-bright over the screen face
 * (model: 12x7 px plane at z 9.5/16, tilted 22.5 degrees back about (8, 9, 11)).
 */
public class ConsoleTerminalRenderer extends StationRenderer<ConsoleTerminalBlockEntity, ConsoleTerminalRenderer.State> {
	private static final float PPB = 128f;
	/** Screen size in text px (12 x 7 model px at 128 px per block). */
	private static final int SW = 96;
	private static final int SH = 56;
	private static final int FEED_ITEMS = 3;
	/** The newest item stays this long, then the card pages every {@link #PAGE_MS}. */
	private static final long NEWEST_MS = 8000;
	private static final long PAGE_MS = 4500;

	private long cachedRevision = Long.MIN_VALUE;
	private List<FeedRow> cachedRows = List.of();
	private long newestTs = Long.MIN_VALUE;
	private long newestSince;
	private @Nullable String cachedDraftRaw;
	private String cachedDraft = "";

	/** One feed item, laid out for the card: name line + up to two message lines. */
	public record FeedRow(@Nullable String agentId, int stripe, String name, int nameColor, List<String> lines, int color, long ts) {
	}

	public static class State extends StationRenderState {
		public @Nullable FeedRow card;
		public int page;
		public int pages;
		public String draft = "";
		public int waiting;
		public boolean stale;
		public boolean live;
		public String key = "Enter";
		public String decisionsKey = "J";
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	/** A flat opaque rectangle in the colour {@code argb}: the bubble sprite's centre texel, tinted, on the solid layer. */
	private static void solidRect(PoseStack poseStack, SubmitNodeCollector collector, float x0, float y0, float x1, float y1, int argb, int light) {
		TextureAtlasSprite sp = WorldUi.sprite(Kit.BUBBLE);
		float u = sp.getU(0.5f);
		float v = sp.getV(0.5f);
		int tint = tintFor(argb, 0xFFFBF4);
		collector.order(0).submitCustomGeometry(poseStack, WorldUi.guiAtlasSolid(), (pose, vc) -> WorldUi.quad(pose, vc, x0, y0, x1, y1, u, v, u, v, tint,
			light));
	}

	/** The tint that turns {@code base} (0xRRGGBB) into {@code want} when multiplied. */
	private static int tintFor(int want, int base) {
		int r = Math.min(255, ((want >> 16) & 0xFF) * 255 / Math.max(1, (base >> 16) & 0xFF));
		int g = Math.min(255, ((want >> 8) & 0xFF) * 255 / Math.max(1, (base >> 8) & 0xFF));
		int b = Math.min(255, (want & 0xFF) * 255 / Math.max(1, base & 0xFF));
		return 0xFF000000 | r << 16 | g << 8 | b;
	}

	@Override
	protected void extractStation(ConsoleTerminalBlockEntity be, State s, float partialTicks) {
		ForemanState st = Foreman.state();
		s.live = st != null && st.hasData();
		s.stale = st == null || st.isStale();
		s.waiting = DecisionsFeature.waitingCount();
		s.key = Keys.terminal == null ? "Enter" : Keys.label(Keys.terminal);
		s.decisionsKey = Keys.decisions == null ? "J" : Keys.label(Keys.decisions);
		Font font = Minecraft.getInstance().font;
		if (st != null && st.revision() != cachedRevision) {
			cachedRevision = st.revision();
			cachedRows = feedRows(st, font);
		}
		List<FeedRow> rows = st == null ? List.of() : cachedRows;
		long now = Util.getMillis();
		if (rows.isEmpty()) {
			s.card = null;
			s.page = 0;
			s.pages = 0;
		} else {
			FeedRow newest = rows.get(rows.size() - 1);
			if (newest.ts() != newestTs) {
				newestTs = newest.ts();
				newestSince = now;
			}
			// the newest item first, then page back through the last few, newest first
			long age = now - newestSince;
			int back = age < NEWEST_MS ? 0 : (int) (((age - NEWEST_MS) / PAGE_MS + 1) % rows.size());
			s.card = rows.get(rows.size() - 1 - back);
			s.page = back;
			s.pages = rows.size();
		}
		String draft = ConsoleLog.draft();
		if (!draft.equals(cachedDraftRaw)) {
			cachedDraftRaw = draft;
			cachedDraft = draft.isEmpty() ? "" : TextUtil.ellipsize(font, draft.replace('\n', ' '), SW - 12 - 6);
		}
		s.draft = cachedDraft;
	}

	/** The newest feed items (oldest of them first), laid out for the card. */
	private static List<FeedRow> feedRows(ForemanState st, Font font) {
		// copy what is kept: the feed is a live read-only view
		List<FeedItem> feed = new ArrayList<>(FEED_ITEMS);
		for (var it = st.feed().reversed().iterator(); it.hasNext() && feed.size() < FEED_ITEMS;) {
			feed.add(0, it.next());
		}
		List<FeedRow> out = new ArrayList<>();
		int ink = UiStyle.color("monitor.text", 0xFF1F1E1D);
		int textW = SW - 8;
		for (FeedItem f : feed) {
			String agent = f.agentId();
			String text = UiBits.oneLine(f.text());
			String name;
			int nameColor;
			if (agent == null) {
				name = Tr.t("Foreman");
				nameColor = UiStyle.color("monitor.muted", 0xFF655E55);
			} else if (UiBits.isUser(agent)) {
				name = Tr.t("You");
				nameColor = UiStyle.CLAY_DARK;
			} else {
				name = UiBits.agentName(agent);
				nameColor = UiBits.nameOnLight(agent);
			}
			// "Kit: tests fail" / "<user> answered" -> the name line already says who
			for (String who : new String[] {name, UiBits.userName()}) {
				if (text.startsWith(who + ": ")) {
					text = text.substring(who.length() + 2);
				} else if (text.startsWith(who + " ")) {
					text = text.substring(who.length() + 1);
				}
			}
			if (!f.kind().equals(dev.agentcraft.client.foreman.Protocol.FeedKind.MESSAGE) && !text.isEmpty()) {
				text = Character.toUpperCase(text.charAt(0)) + text.substring(1);
			}
			int color = switch (f.kind()) {
				case ERROR -> UiStyle.color("monitor.error", 0xFF9A2F2B);
				case MERGE -> UiStyle.color("monitor.result", 0xFF485A48);
				case CI -> text.contains("fail") && !text.contains("fail 0") ? UiStyle.color("monitor.error", 0xFF9A2F2B) : UiStyle.color("monitor.result",
					0xFF485A48);
				case DECISION -> text.contains("needs you") ? UiStyle.CLAY_DARK : ink;
				default -> ink;
			};
			List<String> wrapped = TextUtil.wrapPlain(font, text, textW);
			List<String> lines = new ArrayList<>(wrapped.subList(0, Math.min(2, wrapped.size())));
			if (wrapped.size() > 2) {
				lines.set(1, TextUtil.ellipsize(font, lines.get(1) + " " + wrapped.get(2), textW));
			}
			String nm = TextUtil.ellipsize(font, name, SW - 14 - 26);
			out.add(new FeedRow(agent != null && Cast.get(agent) != null ? agent : null, identity(agent, st), nm, nameColor, List.copyOf(lines), color,
				f.ts()));
		}
		return List.copyOf(out);
	}

	private static int identity(@Nullable String agentId, ForemanState st) {
		if (agentId == null) {
			return 0;
		}
		if (UiBits.isUser(agentId)) {
			return UiStyle.CLAY;
		}
		Agent a = st.agent(agentId);
		int c = Cast.parseColor(a != null ? a.color() : null, -1);
		if (c == -1) {
			Cast.Member m = Cast.get(agentId);
			return m != null ? 0xFF000000 | m.color() : 0;
		}
		return 0xFF000000 | c;
	}

	@Override
	public void submit(State s, PoseStack poseStack, SubmitNodeCollector collector, CameraRenderState camera) {
		int light = WorldUi.uiLight();
		poseStack.pushPose();
		poseStack.translate(0.5f, 0.5f, 0.5f);
		poseStack.rotateDegrees(Axis.YP, -modelRotation(s.facing));
		poseStack.translate(-0.5f, -0.5f, -0.5f);
		poseStack.translate(8 / 16f, 9 / 16f, 11 / 16f);
		poseStack.rotateDegrees(Axis.XP, 22.5f);
		poseStack.translate(-8 / 16f, -9 / 16f, -11 / 16f);
		poseStack.translate(14 / 16f, 17 / 16f, 9.5f / 16f - 0.0025f);
		poseStack.scale(-1f / PPB, -1f / PPB, 1f);

		// the warm e-ink paper with its scanlines and a title band, drawn opaque in the solid pass (like
		// nameplates) a hair behind the text plane, so text, faces and dots always win the depth test
		int bg = UiStyle.color("monitor.bg", 0xFFEDE5D7);
		int scan = UiStyle.color("monitor.scanline", 0xFFE7DECE);
		int band = UiStyle.color("palette.ui.panel_shade", 0xFFE3DACB);
		int rule = UiStyle.color("monitor.rule", 0xFFCFC2AC);
		poseStack.pushPose();
		poseStack.translate(0, 0, 0.0012f);
		solidRect(poseStack, collector, 0, 0, SW, SH, bg, light);
		for (int y = 13; y < SH; y += 2) {
			solidRect(poseStack, collector, 0, y, SW, y + 1, scan, light);
		}
		solidRect(poseStack, collector, 0, 0, SW, 11, band, light);
		solidRect(poseStack, collector, 0, 11, SW, 12, rule, light);
		poseStack.popPose();

		Font font = Minecraft.getInstance().font;
		int ink = UiStyle.color("monitor.text", 0xFF1F1E1D);
		int muted = UiStyle.color("monitor.muted", 0xFF655E55);

		// title band: while decisions wait it says so (pulsing clay dot, "2 waiting", the key); else
		// "Console" with a status dot (sage = live, grey + "offline")
		if (s.live && !s.stale && s.waiting > 0) {
			float pulse = 0.5f - 0.5f * (float) Math.cos((s.timeSeconds % 1.2f) / 1.2f * Math.PI * 2);
			int haloA = (int) (60 + 150 * pulse);
			WorldUi.submitSprite(poseStack, collector, WorldUi.Layer.OVERLAY, Kit.dot("waiting", true), 2, 0, 11, 11, 0f, (haloA << 24) | 0xFFFFFF, light);
			WorldUi.submitSprite(poseStack, collector, WorldUi.Layer.OVERLAY, Kit.dot("waiting", false), 4, 2, 7, 7, -0.0002f, 0xFFFFFFFF, light);
			WorldUi.submitText(poseStack, collector, s.waiting + Tr.t(" waiting"), 14, 2, UiStyle.CLAY_DARK, light);
			String key = s.decisionsKey;
			float kw = font.width(key) + 6;
			float kx = SW - 3 - kw;
			poseStack.pushPose();
			poseStack.translate(0, 0, 0.0006f);
			WorldUi.submitNineSlice(poseStack, collector, WorldUi.Layer.SOLID, Kit.KEYCAP, kx, 0.5f, kw, 10, 0xFFFFFFFF, light);
			poseStack.popPose();
			WorldUi.submitText(poseStack, collector, key, kx + 3, 2, UiStyle.color("palette.ui.text", 0xFF1F1E1D), light);
		} else {
			WorldUi.submitText(poseStack, collector, Tr.t("Console"), 4, 2, ink, light);
			String right = s.live && s.stale ? "offline" : "";
			float rx = SW - 4 - font.width(right);
			if (!right.isEmpty()) {
				WorldUi.submitText(poseStack, collector, right, rx, 2, muted, light);
			}
			float dx = right.isEmpty() ? SW - 4 - 7 : rx - 9;
			WorldUi.submitSprite(poseStack, collector, WorldUi.Layer.OVERLAY, Kit.dot(s.live && !s.stale ? "done" : "idle", false), dx, 2, 7, 7, -0.0002f,
				0xFFFFFFFF, light);
		}

		// the news card: stripe + face + name, then the message on two lines
		FeedRow r = s.card;
		float y = 15;
		if (r == null) {
			WorldUi.submitText(poseStack, collector, s.live ? Tr.t("No news yet") : Tr.t("Start the Foreman"), 4, y + 10, muted, light);
		} else {
			if (r.stripe() != 0) {
				int stripe = r.stripe();
				WorldUi.submitFill(poseStack, collector, 1, y - 1, 3, y + 28, stripe, light);
			}
			float nx = 5;
			if (r.agentId() != null) {
				Identifier tex = AgentCraft.id("textures/gui/portrait/" + r.agentId() + ".png");
				float fy = y;
				collector.order(1).submitCustomGeometry(poseStack, RenderTypes.textPolygonOffset(tex), (pose, vc) -> WorldUi.quad(pose, vc, 5, fy, 13,
					fy + 8, 0, 0, 1, 1, 0xFFFFFFFF, light));
				nx = 16;
			}
			WorldUi.submitText(poseStack, collector, r.name(), nx, y, r.nameColor(), light);
			// page dots on the right: which of the last few is showing
			if (s.pages > 1) {
				float px = SW - 4 - (s.pages * 4 - 1);
				for (int i = 0; i < s.pages; i++) {
					int c = i == s.pages - 1 - s.page ? ink : UiStyle.color("monitor.rule", 0xFFCFC2AC);
					WorldUi.submitFill(poseStack, collector, px + i * 4, y + 3, px + i * 4 + 3, y + 6, c, light);
				}
			}
			float ly = y + 10;
			for (String line : r.lines()) {
				WorldUi.submitText(poseStack, collector, line, 5, ly, r.color(), light);
				ly += 10;
			}
		}

		// prompt: your draft, or how to start typing here
		float py = SH - 10;
		WorldUi.submitText(poseStack, collector, ">", 4, py, UiStyle.color("monitor.tool", 0xFF624E16), light);
		float cx = 12;
		if (!s.draft.isEmpty()) {
			WorldUi.submitText(poseStack, collector, s.draft, cx, py, ink, light);
			cx += font.width(s.draft) + 1;
		} else {
			String hint = s.key + Tr.t(" to type");
			WorldUi.submitText(poseStack, collector, hint, cx, py, muted, light);
			cx += font.width(hint) + 2;
		}
		if ((int) (s.timeSeconds * 2) % 2 == 0) {
			WorldUi.submitFill(poseStack, collector, cx, py - 1, cx + 1, py + 8, ink, light);
		}
		poseStack.popPose();
	}
}
