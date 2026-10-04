package dev.agentcraft.client.ui;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.renderpearl.api.GpuFormat;
import com.mojang.renderpearl.api.pipeline.ColorTargetState;
import com.mojang.renderpearl.api.pipeline.RenderPipeline;
import dev.agentcraft.AgentCraft;
import java.util.Optional;
import net.minecraft.client.Minecraft;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.Sheets;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderSetup;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.metadata.gui.GuiMetadataSection;
import net.minecraft.client.resources.metadata.gui.GuiSpriteScaling;
import net.minecraft.data.AtlasIds;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.LightCoordsUtil;

/**
 * Kit sprites and text in the world (nameplates, speech bubbles, BER overlays). Works in "GUI pixel"
 * space: call {@link #billboard} (or set up your own pose with {@link #PX} blocks per pixel, y down)
 * and then draw with pixel coordinates exactly like in a screen.
 *
 * <pre>
 * poseStack.pushPose();
 * WorldUi.billboard(poseStack, camera, 0, 2.3, 0);          // centred above an entity origin
 * WorldUi.submitNineSlice(poseStack, collector, Kit.NAMEPLATE, -w / 2f, 0, w, 12, 0xFFFFFFFF, light);
 * WorldUi.submitText(poseStack, collector, "Kit", -tw / 2f, 2, UiStyle.agentOnDark("kit"), light);
 * poseStack.popPose();
 * </pre>
 *
 * Three layers:
 * <ul>
 *   <li>{@link Layer#SOLID}: opaque plates (the sprite's colour at full opacity; texels under 10 %
 *       alpha are cut out, so rounded/notched corners stay). Drawn in the solid pass with depth
 *       writes, so a nearer plate always hides a farther plate and its text completely, whatever
 *       order things were submitted in. <b>Use this for anything that can overlap other world UI</b>
 *       (nameplates, speech bubbles, floating labels).</li>
 *   <li>{@link Layer#BASE}: translucent backgrounds (the sprite's own alpha). Fine on a block face
 *       that nothing else overlaps; never for billboards, because translucent quads are drawn after
 *       all opaque text, so text behind them ghosts through.</li>
 *   <li>{@link Layer#OVERLAY}: icons/dots on top of a plate (polygon offset, translucent).</li>
 * </ul>
 * Text ({@link #submitText}) uses the polygon-offset display mode, so it sits on its own plate
 * without z-fighting. Fully opaque text is drawn in the solid pass. Two billboards at exactly the
 * same camera distance are coplanar, and then the polygon offset lets one plate's text win over the
 * other plate; give overlapping billboards distinct depths (see {@link #billboard(PoseStack,
 * CameraRenderState, double, double, double, float, float, double, double, double)}'s nudge).
 */
public final class WorldUi {
	/** Blocks per GUI pixel used by vanilla name tags. */
	public static final float PX = 0.025F;
	private static RenderType guiAtlasType;
	private static RenderType guiAtlasOverlayType;
	private static RenderType guiAtlasSolidType;
	/**
	 * The world text pipeline without blending and without alpha writes: the GUI atlas drawn opaque
	 * (the text shader still discards texels under 0.1 alpha). Compiled on first use.
	 */
	private static RenderPipeline solidPipeline;

	/** SOLID = opaque plates (overlap-safe); BASE = translucent backgrounds; OVERLAY = icons/dots on a plate. */
	public enum Layer {
		SOLID, BASE, OVERLAY
	}

	private WorldUi() {
	}

	public static RenderType guiAtlas() {
		if (guiAtlasType == null) {
			guiAtlasType = RenderTypes.text(Sheets.GUI_SHEET);
		}
		return guiAtlasType;
	}

	public static RenderType guiAtlasOverlay() {
		if (guiAtlasOverlayType == null) {
			guiAtlasOverlayType = RenderTypes.textPolygonOffset(Sheets.GUI_SHEET);
		}
		return guiAtlasOverlayType;
	}

	/** The GUI atlas drawn opaque in the solid pass ({@link Layer#SOLID}). */
	public static RenderType guiAtlasSolid() {
        // Iris overrides vanilla text pipelines, but cannot map our custom solid pipeline.
        // Falling through to it corrupts world geometry during the shadow pass in 26.3.
        if (FabricLoader.getInstance().isModLoaded("iris")) return guiAtlas();
        if (guiAtlasSolidType == null) {
			solidPipeline = RenderPipeline.builder(RenderPipelines.WORLD_TEXT_SNIPPET)
				.withLocation(AgentCraft.id("pipeline/world_ui_solid"))
				.withColorTargetState(new ColorTargetState(Optional.empty(), GpuFormat.RGBA8_UNORM, ColorTargetState.WRITE_COLOR))
				.build();
			guiAtlasSolidType = RenderType.create("agentcraft_world_ui_solid",
				RenderSetup.builder(solidPipeline).withTexture("Sampler0", Sheets.GUI_SHEET).useLightmap().createRenderSetup());
		}
		return guiAtlasSolidType;
	}

	private static RenderType type(Layer layer) {
		return switch (layer) {
			case SOLID -> guiAtlasSolid();
			case BASE -> guiAtlas();
			case OVERLAY -> guiAtlasOverlay();
		};
	}

	private static int order(Layer layer) {
		return layer == Layer.OVERLAY ? 1 : 0;
	}

	public static TextureAtlasSprite sprite(Identifier id) {
		return Minecraft.getInstance().getAtlasManager().getAtlasOrThrow(AtlasIds.GUI).getSprite(id);
	}

	/** Translate to (x,y,z) (relative to the current pose), face the camera, switch to pixel units (y down). */
	public static void billboard(PoseStack poseStack, CameraRenderState camera, double x, double y, double z) {
		poseStack.translate(x, y, z);
		poseStack.rotate(camera.orientation);
		poseStack.scale(PX, -PX, PX);
	}

	/**
	 * {@link #billboard(PoseStack, CameraRenderState, double, double, double)} with a size factor and
	 * a depth nudge. {@code (ox, oy, oz)} is the current pose origin relative to the camera (for an
	 * entity: its render position minus {@code camera.pos}). {@code nudge} (0..0.5) pulls the billboard
	 * that fraction of its distance towards the camera and shrinks it by the same factor, so it looks
	 * exactly the same on screen but sorts in front of billboards with a smaller nudge (use it to
	 * order overlapping plates that are at the same distance).
	 */
	public static void billboard(PoseStack poseStack, CameraRenderState camera, double x, double y, double z, float scale, float nudge, double ox,
		double oy, double oz) {
		float t = Math.max(0f, Math.min(0.5f, nudge));
		// anchor' = camera + (1 - t) * (anchor - camera), expressed relative to the current origin
		poseStack.translate((1 - t) * x - t * ox, (1 - t) * y - t * oy, (1 - t) * z - t * oz);
		poseStack.rotate(camera.orientation);
		float s = PX * scale * (1 - t);
		poseStack.scale(s, -s, s);
	}

	/** Full-bright light so UI stays legible at night. */
	public static int uiLight() {
		return LightCoordsUtil.FULL_BRIGHT;
	}

	// ------------------------------------------------------------------ submit helpers

	/** An icon/dot on top of a plate ({@link Layer#OVERLAY}), drawn at its given size (no slicing). */
	public static void submitSprite(PoseStack poseStack, SubmitNodeCollector collector, Identifier id, float x, float y, float w, float h, int argb,
		int light) {
		submitSprite(poseStack, collector, Layer.OVERLAY, id, x, y, w, h, argb, light);
	}

	public static void submitSprite(PoseStack poseStack, SubmitNodeCollector collector, Layer layer, Identifier id, float x, float y, float w,
		float h, int argb, int light) {
		submitSprite(poseStack, collector, layer, id, x, y, w, h, 0f, argb, light);
	}

	/**
	 * {@code z} lifts the sprite towards the viewer (pixel units; +z faces the camera in billboard
	 * space): use small steps (0.1) to stack overlays that overlap each other, e.g. a dot on its halo.
	 */
	public static void submitSprite(PoseStack poseStack, SubmitNodeCollector collector, Layer layer, Identifier id, float x, float y, float w,
		float h, float z, int argb, int light) {
		TextureAtlasSprite s = sprite(id);
		collector.order(order(layer)).submitCustomGeometry(poseStack, type(layer), (pose, vc) -> quad(pose, vc, x, y, x + w, y + h, z, s.getU0(),
			s.getV0(), s.getU1(), s.getV1(), argb, light));
	}

	/** A nine-sliced background plate ({@link Layer#BASE}, translucent; prefer {@link Layer#SOLID} for billboards). */
	public static void submitNineSlice(PoseStack poseStack, SubmitNodeCollector collector, Identifier id, float x, float y, float w, float h,
		int argb, int light) {
		submitNineSlice(poseStack, collector, Layer.BASE, id, x, y, w, h, argb, light);
	}

	public static void submitNineSlice(PoseStack poseStack, SubmitNodeCollector collector, Layer layer, Identifier id, float x, float y, float w,
		float h, int argb, int light) {
		TextureAtlasSprite s = sprite(id);
		collector.order(order(layer)).submitCustomGeometry(poseStack, type(layer), (pose, vc) -> nineSlice(pose, vc, s, x, y, w, h, argb, light));
	}

	/** Flat text (no shadow) on top of anything submitted with the helpers above. */
	public static void submitText(PoseStack poseStack, SubmitNodeCollector collector, String text, float x, float y, int argb, int light) {
		submitText(poseStack, collector, Component.literal(text).getVisualOrderText(), x, y, argb, light);
	}

	public static void submitText(PoseStack poseStack, SubmitNodeCollector collector, FormattedCharSequence text, float x, float y, int argb,
		int light) {
		collector.order(1).submitText(poseStack, x, y, text, false, Font.DisplayMode.POLYGON_OFFSET, light, argb, 0, 0);
	}

	/**
	 * A flat opaque-or-translucent colour rectangle (font white glyph, depth-tested, drawn with the
	 * text). Handy for thin rules and leader lines; use an alpha of 255 to keep it overlap-safe.
	 */
	public static void submitFill(PoseStack poseStack, SubmitNodeCollector collector, float x0, float y0, float x1, float y1, int argb, int light) {
		collector.order(1).submitTextBackground(poseStack, x0, y0, x1, y1, argb, Font.DisplayMode.NORMAL, light);
	}

	// ------------------------------------------------------------------ geometry

	/** One textured quad in pixel space (top-left, bottom-left, bottom-right, top-right; vanilla glyph winding). */
	public static void quad(PoseStack.Pose pose, VertexConsumer vc, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1,
		int argb, int light) {
		quad(pose, vc, x0, y0, x1, y1, 0f, u0, v0, u1, v1, argb, light);
	}

	public static void quad(PoseStack.Pose pose, VertexConsumer vc, float x0, float y0, float x1, float y1, float z, float u0, float v0, float u1,
		float v1, int argb, int light) {
		vc.addVertex(pose, x0, y0, z).setUv(u0, v0).setColor(argb).setLight(light);
		vc.addVertex(pose, x0, y1, z).setUv(u0, v1).setColor(argb).setLight(light);
		vc.addVertex(pose, x1, y1, z).setUv(u1, v1).setColor(argb).setLight(light);
		vc.addVertex(pose, x1, y0, z).setUv(u1, v0).setColor(argb).setLight(light);
	}

	/** Nine-slice a kit sprite (border from its gui.scaling metadata; plain stretch if it has none). */
	public static void nineSlice(PoseStack.Pose pose, VertexConsumer vc, TextureAtlasSprite s, float x, float y, float w, float h, int argb,
		int light) {
		GuiSpriteScaling scaling = s.contents().<GuiMetadataSection>getAdditionalMetadata(GuiMetadataSection.TYPE)
			.orElse(GuiMetadataSection.DEFAULT).scaling();
		if (!(scaling instanceof GuiSpriteScaling.NineSlice ns)) {
			quad(pose, vc, x, y, x + w, y + h, s.getU0(), s.getV0(), s.getU1(), s.getV1(), argb, light);
			return;
		}
		float sw = ns.width();
		float sh = ns.height();
		float l = Math.min(ns.border().left(), w / 2);
		float r = Math.min(ns.border().right(), w / 2);
		float t = Math.min(ns.border().top(), h / 2);
		float b = Math.min(ns.border().bottom(), h / 2);
		float[] xs = {x, x + l, x + w - r, x + w};
		float[] ys = {y, y + t, y + h - b, y + h};
		float[] us = {0, ns.border().left() / sw, 1 - ns.border().right() / sw, 1};
		float[] vs = {0, ns.border().top() / sh, 1 - ns.border().bottom() / sh, 1};
		for (int i = 0; i < 3; i++) {
			for (int j = 0; j < 3; j++) {
				if (xs[i + 1] - xs[i] <= 0 || ys[j + 1] - ys[j] <= 0) {
					continue;
				}
				quad(pose, vc, xs[i], ys[j], xs[i + 1], ys[j + 1], s.getU(us[i]), s.getV(vs[j]), s.getU(us[i + 1]), s.getV(vs[j + 1]), argb, light);
			}
		}
	}
}
