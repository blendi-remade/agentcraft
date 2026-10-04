package dev.agentcraft.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.platform.Window;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.ClientEnv;
import dev.agentcraft.client.dev.DevBridge.DevException;
import dev.agentcraft.client.mixin.ClientLevelAccessor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.SharedConstants;
import net.minecraft.client.Camera;
import net.minecraft.client.CameraType;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.inventory.CreativeModeInventoryScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.SectionPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.LevelBasedPermissionSet;
import net.minecraft.util.Mth;
import net.minecraft.util.Util;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.border.WorldBorder;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.Vec3;

/** Built-in DevBridge commands. See mod/DEV.md for the reference. */
final class DevCommands {
	/** Radius meaning "the whole render distance" (clamped to renderDistance-1). */
	static final int FULL_RADIUS = 64;
	/** dev.camera: how close (blocks / degrees) the rendered camera must get to the request. */
	static final double CAMERA_POS_TOLERANCE = 0.01;
	static final double CAMERA_ROT_TOLERANCE = 0.05;

	private static final AtomicBoolean QUITTING = new AtomicBoolean(false);

	private DevCommands() {
	}

	static void registerBuiltins() {
		DevBridge.register("dev.ping", 5_000,
			"{} -> {pong, frame, msSinceLastFrame, stalled, quitting}. Answered on the socket thread, so it works while the game loads or hangs;"
				+ " stalled:true means the render thread has not finished a frame for 5 s",
			(req, mc) -> {
				JsonObject o = new JsonObject();
				o.addProperty("pong", true);
				o.addProperty("frame", FrameScheduler.frame());
				o.addProperty("msSinceLastFrame", FrameScheduler.msSinceLastFrame());
				o.addProperty("stalled", FrameScheduler.stalled());
				o.addProperty("quitting", QUITTING.get());
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.help", 5_000, "{} -> {commands, screens}", (req, mc) -> CompletableFuture.completedFuture(DevBridge.help()));
		DevBridge.register("dev.state", 10_000, "{} -> {inWorld, ready, paused, player, camera, screen, fps, window, fov, ...}",
			(req, mc) -> DevBridge.onClient(mc, () -> state(mc)));
		DevBridge.register("dev.camera", 20_000,
			"{x,y,z, yaw,pitch | lookAt:{x,y,z} | anchor:name, fov?:30-110 (default: the player's FOV option), mode?:spectator|creative|keep,"
				+ " feet?:false, hideHud?, closePause?:true} - put the camera (eye) exactly there; fails if it can't."
				+ " anchor fills x/y/z/yaw/pitch from dev.anchors (cam_* = eye, others = feet)",
			DevCommands::camera);
		DevBridge.register("dev.release", 10_000,
			"{mode?:creative|keep} - give the view back to the player: clears the FOV pin, shows the HUD, spectator -> creative (flying)",
			DevCommands::release);
		DevBridge.register("dev.screenshot", req -> {
			Fields f = Fields.of(req);
			long chunkWait = f.optBool("waitChunks", true) ? f.optLong("chunkTimeoutMs", 30_000, 0, 600_000) : 0;
			return chunkWait + f.optInt("frames", 3, 1, 600) * 50L + 60_000;
		},
			"{name, hideHud?:true, frames?:3 (1-600), waitChunks?:true, chunkRadius?:renderDistance-1, chunkTimeoutMs?:30000} -> {path,width,height,stats}",
			DevCommands::screenshot);
		DevBridge.register("dev.time", 10_000, "{ticks: 0..2147483647} - set the day time (6000 noon, 12000 golden hour, 18000 night, 23300 sunrise)",
			(req, mc) -> {
				long ticks = Fields.of(req).integer("ticks", 0, Integer.MAX_VALUE);
				return serverCommand(mc, "time set " + ticks).thenCompose(r -> FrameScheduler.afterFrames(2).thenApply(v -> r));
			});
		// Note: the field is 'weather', not 'type' ('type' is the message type).
		DevBridge.register("dev.weather", 10_000, "{clear?:true} or {weather: clear|rain|thunder}", (req, mc) -> {
			Fields f = Fields.of(req);
			String type = f.has("weather") ? f.str("weather").toLowerCase(Locale.ROOT) : f.optBool("clear", true) ? "clear" : "rain";
			if (!Set.of("clear", "rain", "thunder").contains(type)) {
				throw new DevException("field 'weather' must be clear|rain|thunder (got '" + type + "')");
			}
			return serverCommand(mc, "weather " + type);
		});
		DevBridge.register("dev.command", 30_000, "{cmd} - run a command as the player with full permissions -> {messages[], success, result}",
			(req, mc) -> serverCommand(mc, Fields.of(req).nonBlank("cmd")));
		DevBridge.register("dev.screen", 10_000, "{open: name|null} - open a screen (title|pause|chat|inventory|options|<registered>) or close it",
			DevCommands::screen);
		DevBridge.register("dev.key", 10_000, "{key:'escape'|'key.keyboard.f3', modifiers?} or {mapping:'key.chat'} - press a key (to the open screen, else key mappings)",
			DevCommands::key);
		DevBridge.register("dev.type", 10_000, "{text} - type text into the focused widget of the open screen", DevCommands::type);
		DevBridge.register("dev.hud", 10_000, "{hidden: bool} - hide/show the HUD (like F1)", (req, mc) -> {
			boolean hidden = Fields.of(req).bool("hidden");
			return DevBridge.onClient(mc, () -> {
				if (mc.gui.hud.isHidden() != hidden) {
					mc.gui.hud.toggle();
				}
				JsonObject o = new JsonObject();
				o.addProperty("hudHidden", mc.gui.hud.isHidden());
				return o;
			});
		});
		DevBridge.register("dev.waitChunks", req -> 35_000,
			"{timeoutMs?:30000, radius?:renderDistance-1} - block until chunks around the camera are loaded+built",
			(req, mc) -> {
				Fields f = Fields.of(req);
				long timeout = f.optLong("timeoutMs", 30_000, 1, DevBridge.MAX_TIMEOUT_MS);
				int radius = f.optInt("radius", FULL_RADIUS, 0, FULL_RADIUS);
				long start = System.currentTimeMillis();
				return waitChunks(mc, radius, Math.max(1, timeout - 500)).thenApply(v -> {
					JsonObject o = new JsonObject();
					o.addProperty("waitedMs", System.currentTimeMillis() - start);
					return o;
				});
			});
		DevBridge.register("dev.wait", req -> {
			Fields f = Fields.of(req);
			return f.optLong("ms", 0, 0, 600_000) + f.optInt("frames", 0, 0, 36_000) * 50L + 30_000;
		}, "{frames?:0-36000, ms?:0-600000} - wait for rendered frames and/or wall time", (req, mc) -> {
			Fields f = Fields.of(req);
			int frames = f.optInt("frames", 0, 0, 36_000);
			long ms = f.optLong("ms", 0, 0, 600_000);
			CompletableFuture<Void> fut = frames > 0 ? FrameScheduler.afterFrames(frames) : CompletableFuture.completedFuture(null);
			if (ms > 0) {
				fut = fut.thenCompose(v -> CompletableFuture.runAsync(() -> {
				}, CompletableFuture.delayedExecutor(ms, TimeUnit.MILLISECONDS)));
			}
			return fut.thenApply(v -> {
				JsonObject o = new JsonObject();
				o.addProperty("frame", FrameScheduler.frame());
				return o;
			});
		});
		DevBridge.register("dev.quit", 10_000,
			"{forceAfterMs?:15000} - save and quit. If the render thread is hung and never runs the stop, the world is saved on the"
				+ " server thread and the JVM is halted (exit code 3) after forceAfterMs",
			DevCommands::quit);

		if (ClientEnv.flag("AGENTCRAFT_DEV_TEST", false)) {
			// Test hook (only with AGENTCRAFT_DEV_TEST=1): block the render thread to simulate a hung game,
			// so the stall detection and the dev.quit watchdog can be verified for real.
			DevBridge.register("dev.test.stall", 5_000, "{ms: 1-600000} - TEST ONLY: block the render thread for ms", (req, mc) -> {
				long ms = Fields.of(req).integer("ms", 1, 600_000);
				mc.execute(() -> {
					AgentCraft.LOGGER.warn("dev.test.stall: blocking the render thread for {} ms", ms);
					sleepQuietly(ms);
				});
				JsonObject o = new JsonObject();
				o.addProperty("stalling", ms);
				return CompletableFuture.completedFuture(o);
			});
		}

		dev.agentcraft.client.dev.play.PlayCommands.register();

		DevBridge.registerScreen("title", mc -> new TitleScreen());
		DevBridge.registerScreen("pause", mc -> new PauseScreen(true));
		DevBridge.registerScreen("options", mc -> new OptionsScreen(mc.gui.screen(), mc.options));
		DevBridge.registerScreen("inventory", mc -> {
			LocalPlayer p = needPlayer(mc);
			return p.isCreative() && mc.getConnection() != null
				? new CreativeModeInventoryScreen(p, p.connection.enabledFeatures(), mc.options.operatorItemsTab().get())
				: new InventoryScreen(p);
		});
	}

	// ------------------------------------------------------------------ helpers

	static LocalPlayer needPlayer(Minecraft mc) {
		if (mc.player == null || mc.level == null) {
			throw new DevException("not in a world yet");
		}
		return mc.player;
	}

	static net.minecraft.client.server.IntegratedServer needServer(Minecraft mc) {
		needPlayer(mc);
		var server = mc.getSingleplayerServer();
		if (server == null) {
			throw new DevException("needs a singleplayer (integrated server) world");
		}
		return server;
	}

	static String fmt3(double d) {
		return String.format(Locale.ROOT, "%.3f", d);
	}

	// ------------------------------------------------------------------ dev.state

	static JsonObject state(Minecraft mc) {
		JsonObject o = new JsonObject();
		boolean inWorld = mc.level != null && mc.player != null;
		o.addProperty("inWorld", inWorld);
		o.addProperty("minecraft", SharedConstants.getCurrentVersion().name());
		o.addProperty("frame", FrameScheduler.frame());
		o.addProperty("fps", mc.getFps());
		o.addProperty("loading", mc.gui.overlay() != null);
		Screen screen = mc.gui.screen();
		// ready = in a world, nothing loading: safe to move the camera and shoot.
		o.addProperty("ready", inWorld && mc.gui.overlay() == null && !isLoadingScreen(screen));
		// paused = a pausing screen is open in singleplayer: the integrated server stops (no chunk loading).
		o.addProperty("paused", mc.isPaused());
		if (screen != null) {
			JsonObject s = new JsonObject();
			s.addProperty("class", screen.getClass().getName());
			s.addProperty("title", screen.getTitle().getString());
			o.add("screen", s);
		} else {
			o.add("screen", JsonNull.INSTANCE);
		}
		Window w = mc.getWindow();
		JsonObject win = new JsonObject();
		win.addProperty("width", w.getScreenWidth());
		win.addProperty("height", w.getScreenHeight());
		win.addProperty("framebufferWidth", w.getWidth());
		win.addProperty("framebufferHeight", w.getHeight());
		RenderTarget target = mc.gameRenderer.mainRenderTarget();
		win.addProperty("renderWidth", target.width);
		win.addProperty("renderHeight", target.height);
		win.addProperty("guiScale", w.getGuiScale());
		// SDL's focus flag; can say true even when another app is the OS foreground window.
		win.addProperty("focused", w.isFocused());
		// Real OS foreground check (Windows only; null elsewhere).
		win.addProperty("osForeground", WinFocus.isForeground(w));
		win.addProperty("iconified", w.isIconified());
		o.add("window", win);
		JsonObject mouse = new JsonObject();
		mouse.addProperty("x", mc.mouseHandler.xpos());
		mouse.addProperty("y", mc.mouseHandler.ypos());
		mouse.addProperty("guiX", mc.mouseHandler.getScaledXPos(w));
		mouse.addProperty("guiY", mc.mouseHandler.getScaledYPos(w));
		mouse.addProperty("grabbed", mc.mouseHandler.isMouseGrabbed());
		o.add("mouse", mouse);
		o.addProperty("hudHidden", mc.gui.hud.isHidden());
		// fov = what the last frame was rendered with; fovOption = the player's setting; fovPin = dev.camera's pin (null = none).
		o.addProperty("fov", mc.gameRenderer.mainCamera().getFov());
		o.addProperty("fovOption", mc.options.fov().get());
		o.addProperty("fovPin", DevCamera.fovPin());
		o.addProperty("cameraType", mc.options.getCameraType().name().toLowerCase(Locale.ROOT));
		JsonObject audio = new JsonObject();
		audio.addProperty("master", mc.options.getSoundSourceVolume(net.minecraft.sounds.SoundSource.MASTER));
		audio.addProperty("music", mc.options.getSoundSourceVolume(net.minecraft.sounds.SoundSource.MUSIC));
		o.add("audio", audio);
		if (inWorld) {
			LocalPlayer p = mc.player;
			JsonObject pl = new JsonObject();
			pl.addProperty("name", p.getGameProfile().name());
			pl.addProperty("x", p.getX());
			pl.addProperty("y", p.getY());
			pl.addProperty("z", p.getZ());
			pl.addProperty("eyeY", p.getEyeY());
			pl.addProperty("yaw", p.getYRot());
			pl.addProperty("pitch", p.getXRot());
			pl.addProperty("flying", p.getAbilities().flying);
			pl.addProperty("gameMode", mc.gameMode != null ? mc.gameMode.getPlayerMode().getName() : null);
			o.add("player", pl);
			o.add("camera", cameraJson(mc));
			ClientLevel level = mc.level;
			JsonObject wo = new JsonObject();
			var server = mc.getSingleplayerServer();
			wo.addProperty("name", server != null ? server.getWorldData().getLevelName() : null);
			wo.addProperty("dimension", level.dimension().identifier().toString());
			wo.addProperty("time", level.getDefaultClockTime());
			wo.addProperty("raining", level.isRaining());
			wo.addProperty("thundering", level.isThundering());
			o.add("world", wo);
			JsonObject ch = new JsonObject();
			ch.addProperty("renderedAll", mc.levelRenderer.hasRenderedAllSections());
			ch.addProperty("lightQueue", ((ClientLevelAccessor) level).agentcraft$getLightUpdateQueue().size());
			ch.addProperty("loadedAll", chunksLoaded(mc, FULL_RADIUS));
			ch.addProperty("renderDistance", mc.options.getEffectiveRenderDistance());
			o.add("chunks", ch);
		} else {
			o.add("player", JsonNull.INSTANCE);
			o.add("camera", JsonNull.INSTANCE);
			o.add("world", JsonNull.INSTANCE);
			o.add("chunks", JsonNull.INSTANCE);
		}
		// Replaced by the Foreman feature's contributor (dev.agentcraft.client.foreman.ForemanFeature).
		o.add("foreman", JsonNull.INSTANCE);
		for (var contributor : DevBridge.stateContributors()) {
			try {
				contributor.accept(mc, o);
			} catch (Throwable t) {
				AgentCraft.LOGGER.warn("dev.state contributor failed", t);
			}
		}
		return o;
	}

	static JsonObject cameraJson(Minecraft mc) {
		Camera cam = mc.gameRenderer.mainCamera();
		Vec3 cp = cam.position();
		JsonObject c = new JsonObject();
		c.addProperty("x", cp.x);
		c.addProperty("y", cp.y);
		c.addProperty("z", cp.z);
		c.addProperty("yaw", cam.yRot());
		c.addProperty("pitch", cam.xRot());
		c.addProperty("fov", cam.getFov());
		return c;
	}

	static String screenName(Minecraft mc) {
		Screen s = mc.gui.screen();
		return s == null ? "no screen" : s.getClass().getSimpleName();
	}

	static boolean isLoadingScreen(Screen screen) {
		if (screen == null) {
			return false;
		}
		String n = screen.getClass().getSimpleName();
		return n.equals("LevelLoadingScreen") || n.equals("GenericMessageScreen") || n.equals("ProgressScreen")
			|| n.equals("ConnectScreen") || n.equals("ReceivingLevelScreen");
	}

	// ------------------------------------------------------------------ chunks

	static boolean chunksLoaded(Minecraft mc, int radius) {
		ClientLevel level = mc.level;
		if (level == null || mc.player == null) {
			return false;
		}
		Vec3 pos = mc.player.position();
		int cx = SectionPos.blockToSectionCoord(pos.x);
		int cz = SectionPos.blockToSectionCoord(pos.z);
		int r = Math.max(0, Math.min(radius, mc.options.getEffectiveRenderDistance() - 1));
		for (int dz = -r; dz <= r; dz++) {
			for (int dx = -r; dx <= r; dx++) {
				if (dx * dx + dz * dz > r * r) {
					continue;
				}
				if (level.getChunk(cx + dx, cz + dz, ChunkStatus.FULL, false) == null) {
					return false;
				}
			}
		}
		return true;
	}

	static boolean chunksBuilt(Minecraft mc) {
		ClientLevel level = mc.level;
		return level != null
			&& ((ClientLevelAccessor) level).agentcraft$getLightUpdateQueue().isEmpty()
			&& mc.levelRenderer.hasRenderedAllSections();
	}

	/** Loaded + light queue empty + all sections compiled, stable for 5 frames (min 6 frames). */
	static CompletableFuture<Void> waitChunks(Minecraft mc, int radius, long timeoutMs) {
		return FrameScheduler.when(() -> chunksLoaded(mc, radius) && chunksBuilt(mc), 6, 5, timeoutMs, "chunks to load and build")
			.exceptionally(t -> {
				if (mc.isPaused()) {
					throw new DevException("chunks did not load: the game is paused (" + screenName(mc) + " open); close it with dev.screen {open:null}");
				}
				throw t instanceof RuntimeException re ? re : new java.util.concurrent.CompletionException(t);
			});
	}

	// ------------------------------------------------------------------ dev.camera

	/** Validated dev.camera request. Every number is finite and within the engine's limits. */
	private record CameraRequest(double x, double y, double z, float yaw, float pitch, Float fov, String mode, boolean feet,
		Boolean hideHud, boolean closePause) {
	}

	/**
	 * {@code anchor:"name"} fills x/y/z/yaw/pitch from the published layout (fields given explicitly
	 * still win). {@code cam_*} anchors are eye positions; other anchors are feet positions, so the
	 * camera stands there ({@code feet:true}) unless {@code feet} is given.
	 */
	static JsonObject resolveAnchor(JsonObject json) {
		Fields f = Fields.of(json);
		if (!f.has("anchor")) {
			return json;
		}
		String name = f.nonBlank("anchor");
		dev.agentcraft.layout.Anchor a = dev.agentcraft.layout.Anchors.get(name);
		if (a == null) {
			throw new DevException("unknown anchor '" + name + "' (layout '" + dev.agentcraft.layout.Anchors.current().name()
				+ "' has " + dev.agentcraft.layout.Anchors.current().anchors().size() + " anchors; see dev.anchors; build one with /agentcraft hq)");
		}
		JsonObject out = json.deepCopy();
		out.remove("anchor");
		if (!out.has("x")) {
			out.addProperty("x", a.x());
		}
		if (!out.has("y")) {
			out.addProperty("y", a.y());
		}
		if (!out.has("z")) {
			out.addProperty("z", a.z());
		}
		if (!out.has("lookAt")) {
			if (!out.has("yaw")) {
				out.addProperty("yaw", a.yaw());
			}
			if (!out.has("pitch")) {
				out.addProperty("pitch", a.pitch());
			}
		}
		if (!out.has("feet") && !name.startsWith(dev.agentcraft.layout.AnchorNames.CAM_PREFIX)) {
			out.addProperty("feet", true);
		}
		return out;
	}

	static CameraRequest parseCamera(JsonObject rawJson) {
		JsonObject json = resolveAnchor(rawJson);
		Fields f = Fields.of(json);
		double x = f.num("x");
		// Same vertical limits as vanilla /tp (Level.isInSpawnableBounds). x/z are checked against the
		// world border on the server thread. Non-finite numbers are refused by Fields: a NaN camera
		// would spin the render thread forever in Frustum.offsetToFullyIncludeCameraCube.
		double y = f.num("y", Level.MIN_ENTITY_SPAWN_Y, Level.MAX_ENTITY_SPAWN_Y - 1);
		double z = f.num("z");
		if (Math.abs(x) >= Level.MAX_LEVEL_SIZE || Math.abs(z) >= Level.MAX_LEVEL_SIZE) {
			throw new DevException("x/z must be within the world (|x|,|z| < " + Level.MAX_LEVEL_SIZE + "; got x=" + Fields.fmt(x) + ", z=" + Fields.fmt(z) + ")");
		}
		// yaw/pitch are validated even when lookAt (which wins) is given too.
		double yawDeg = f.optNum("yaw", 0, -Double.MAX_VALUE, Double.MAX_VALUE);
		double pitchDeg = f.optNum("pitch", 0, -90, 90);
		Fields look = f.optObj("lookAt");
		if (look != null) {
			// Aim the eye at a target point instead of giving yaw/pitch.
			double dx = look.num("x") - x;
			double dy = look.num("y") - y;
			double dz = look.num("z") - z;
			double horiz = Math.sqrt(dx * dx + dz * dz);
			if (horiz < 1e-6 && Math.abs(dy) < 1e-6) {
				throw new DevException("field 'lookAt' is the camera position itself; there is no direction to look in");
			}
			yawDeg = Math.toDegrees(Math.atan2(-dx, dz));
			pitchDeg = -Math.toDegrees(Math.atan2(dy, horiz));
		}
		// Wrap in double precision first: casting a huge yaw to float would give Infinity.
		float yaw = (float) Mth.wrapDegrees(yawDeg);
		float pitch = (float) pitchDeg;
		if (!Float.isFinite(yaw) || !Float.isFinite(pitch)) {
			throw new DevException("camera rotation is not finite (yaw " + yawDeg + ", pitch " + pitchDeg + ")");
		}
		String mode = f.optStr("mode", "spectator").toLowerCase(Locale.ROOT);
		if (!Set.of("spectator", "creative", "keep").contains(mode)) {
			throw new DevException("field 'mode' must be spectator|creative|keep (got '" + mode + "')");
		}
		Double fov = f.optNum("fov");
		if (fov != null && (fov < 30 || fov > 110)) {
			throw new DevException("field 'fov' must be within [30, 110] (got " + Fields.fmt(fov) + ")");
		}
		return new CameraRequest(x, y, z, yaw, pitch, fov == null ? null : fov.floatValue(), mode, f.optBool("feet", false),
			f.optBool("hideHud"), f.optBool("closePause", true));
	}

	static CompletableFuture<JsonObject> camera(JsonObject json, Minecraft mc) {
		CameraRequest r = parseCamera(json);
		AtomicBoolean closedPause = new AtomicBoolean(false);
		double[] eye = new double[1];

		return DevBridge.onClient(mc, () -> {
			var server = needServer(mc);
			// Refuse before any side effect (the server re-checks its own border before teleporting).
			checkBorder(mc.level.getWorldBorder(), r);
			LocalPlayer player = mc.player;
			UUID uuid = player.getUUID();
			double eyeHeight = player.getEyeHeight(Pose.STANDING);
			double feetY = r.feet() ? r.y() : r.y() - eyeHeight;
			eye[0] = feetY + eyeHeight;
			if (r.closePause() && mc.gui.screen() instanceof PauseScreen) {
				mc.gui.setScreen(null);
				closedPause.set(true);
			}
			// A precise camera is first person, from the player's own eyes.
			if (mc.options.getCameraType() != CameraType.FIRST_PERSON) {
				mc.options.setCameraType(CameraType.FIRST_PERSON);
			}
			if (mc.getCameraEntity() != player) {
				mc.setCameraEntity(player);
			}
			// Every camera call fully defines the view: the FOV is the request's, else the player's option.
			DevCamera.pinFov(r.fov() != null ? r.fov() : mc.options.fov().get().floatValue());
			if (r.hideHud() != null && mc.gui.hud.isHidden() != r.hideHud()) {
				mc.gui.hud.toggle();
			}
			return new Object[] {server, uuid, feetY};
		}).thenCompose(arr -> {
			var server = (net.minecraft.client.server.IntegratedServer) arr[0];
			UUID uuid = (UUID) arr[1];
			double feetY = (double) arr[2];
			return server.submit(() -> {
				ServerPlayer sp = server.getPlayerList().getPlayer(uuid);
				if (sp == null) {
					throw new DevException("server player not found");
				}
				checkBorder(sp.level().getWorldBorder(), r);
				if (sp.getCamera() != sp) {
					sp.setCamera(sp); // stop spectating another entity
				}
				if (r.mode().equals("spectator") && sp.gameMode() != GameType.SPECTATOR) {
					sp.setGameMode(GameType.SPECTATOR);
				} else if (r.mode().equals("creative")) {
					if (sp.gameMode() != GameType.CREATIVE) {
						sp.setGameMode(GameType.CREATIVE);
					}
					sp.getAbilities().flying = true;
					sp.onUpdateAbilities();
				}
				sp.teleportTo(sp.level(), r.x(), feetY, r.z(), Set.of(), r.yaw(), r.pitch(), true);
				return feetY;
			});
		}).thenCompose(feetY -> {
			// Wait for the teleport to reach the client, then pin position + rotation with no interpolation.
			return FrameScheduler.when(() -> {
				LocalPlayer p = mc.player;
				return p != null && Math.abs(p.getX() - r.x()) < 1e-3 && Math.abs(p.getY() - feetY) < 1e-3 && Math.abs(p.getZ() - r.z()) < 1e-3
					&& (!r.mode().equals("spectator") || p.isSpectator());
			}, 1, 1, 10_000, "teleport to reach the client").thenApply(v -> feetY);
		}).thenCompose(feetY -> {
			LocalPlayer p = mc.player;
			p.setDeltaMovement(Vec3.ZERO);
			if (r.mode().equals("creative")) {
				p.getAbilities().flying = true;
			}
			p.snapTo(r.x(), feetY, r.z(), r.yaw(), r.pitch());
			p.setYHeadRot(r.yaw());
			p.yHeadRotO = r.yaw();
			p.setYBodyRot(r.yaw());
			p.yBodyRotO = r.yaw();
			if (r.mode().equals("keep")) {
				// Mode 'keep' may leave the player walking (gravity, collisions): report where it ended up.
				return FrameScheduler.afterFrames(2);
			}
			// Do not report success until a rendered frame actually used the requested camera.
			return FrameScheduler.when(() -> cameraMatches(mc, r, eye[0]), 2, 2, 3_000, "camera")
				.exceptionally(t -> {
					Throwable c = t instanceof java.util.concurrent.CompletionException && t.getCause() != null ? t.getCause() : t;
					if (c instanceof TimeoutException) {
						Camera cam = mc.gameRenderer.mainCamera();
						Vec3 cp = cam.position();
						throw new DevException("camera did not reach the request: wanted eye (" + fmt3(r.x()) + ", " + fmt3(eye[0]) + ", " + fmt3(r.z())
							+ ") yaw " + fmt3(r.yaw()) + " pitch " + fmt3(r.pitch()) + ", got (" + fmt3(cp.x) + ", " + fmt3(cp.y) + ", " + fmt3(cp.z)
							+ ") yaw " + fmt3(cam.yRot()) + " pitch " + fmt3(cam.xRot()));
					}
					throw c instanceof RuntimeException re ? re : new java.util.concurrent.CompletionException(c);
				});
		}).thenApply(v -> {
			JsonObject o = new JsonObject();
			o.add("camera", cameraJson(mc));
			o.addProperty("gameMode", mc.gameMode != null ? mc.gameMode.getPlayerMode().getName() : null);
			if (closedPause.get()) {
				o.addProperty("closedPauseScreen", true);
			}
			return o;
		});
	}

	/** The camera would be clamped (and not where asked) outside the world border. */
	private static void checkBorder(WorldBorder border, CameraRequest r) {
		if (!border.isWithinBounds(r.x(), r.z())) {
			throw new DevException("x/z (" + Fields.fmt(r.x()) + ", " + Fields.fmt(r.z()) + ") is outside the world border (x "
				+ Fields.fmt(border.getMinX()) + ".." + Fields.fmt(border.getMaxX()) + ", z " + Fields.fmt(border.getMinZ()) + ".."
				+ Fields.fmt(border.getMaxZ()) + ")");
		}
	}

	static boolean cameraMatches(Minecraft mc, CameraRequest r, double eyeY) {
		Camera cam = mc.gameRenderer.mainCamera();
		Vec3 cp = cam.position();
		Float pin = DevCamera.fovPin();
		return Math.abs(cp.x - r.x()) < CAMERA_POS_TOLERANCE && Math.abs(cp.y - eyeY) < CAMERA_POS_TOLERANCE && Math.abs(cp.z - r.z()) < CAMERA_POS_TOLERANCE
			&& Math.abs(Mth.wrapDegrees(cam.yRot() - r.yaw())) < CAMERA_ROT_TOLERANCE && Math.abs(cam.xRot() - r.pitch()) < CAMERA_ROT_TOLERANCE
			&& pin != null && Math.abs(cam.getFov() - pin) < 0.01;
	}

	// ------------------------------------------------------------------ dev.release

	static CompletableFuture<JsonObject> release(JsonObject json, Minecraft mc) {
		String mode = Fields.of(json).optStr("mode", "creative").toLowerCase(Locale.ROOT);
		if (!Set.of("creative", "keep").contains(mode)) {
			throw new DevException("field 'mode' must be creative|keep (got '" + mode + "')");
		}
		return DevBridge.onClient(mc, () -> {
			DevCamera.releaseFov();
			if (mc.gui.hud.isHidden()) {
				mc.gui.hud.toggle();
			}
			var server = mc.player != null ? mc.getSingleplayerServer() : null;
			return server == null ? null : new Object[] {server, mc.player.getUUID()};
		}).thenCompose(arr -> {
			if (arr == null || mode.equals("keep")) {
				return CompletableFuture.completedFuture(null);
			}
			var server = (net.minecraft.client.server.IntegratedServer) arr[0];
			UUID uuid = (UUID) arr[1];
			return server.submit(() -> {
				ServerPlayer sp = server.getPlayerList().getPlayer(uuid);
				if (sp != null && sp.gameMode() == GameType.SPECTATOR) {
					sp.setGameMode(GameType.CREATIVE);
					sp.getAbilities().flying = true; // don't drop out of the sky
					sp.onUpdateAbilities();
				}
				return null;
			});
		}).thenCompose(v -> FrameScheduler.afterFrames(2)).thenApply(v -> {
			JsonObject o = new JsonObject();
			o.addProperty("fovPin", DevCamera.fovPin());
			o.addProperty("hudHidden", mc.gui.hud.isHidden());
			o.addProperty("gameMode", mc.gameMode != null ? mc.gameMode.getPlayerMode().getName() : null);
			return o;
		});
	}

	// ------------------------------------------------------------------ dev.quit

	static CompletableFuture<JsonObject> quit(JsonObject json, Minecraft mc) {
		long forceAfterMs = Fields.of(json).optLong("forceAfterMs", 15_000, 1_000, 600_000);
		boolean first = QUITTING.compareAndSet(false, true);
		boolean stalled = FrameScheduler.stalled();
		if (first) {
			AtomicBoolean stopRan = new AtomicBoolean(false);
			// Reply first, stop shortly after so the response reaches the client.
			CompletableFuture.delayedExecutor(250, TimeUnit.MILLISECONDS).execute(() -> mc.execute(() -> {
				stopRan.set(true);
				mc.stop();
			}));
			Thread watchdog = new Thread(() -> quitWatchdog(mc, stopRan, 250 + forceAfterMs), "AgentCraft quit watchdog");
			watchdog.setDaemon(true); // dies with the JVM on a normal exit
			watchdog.start();
			AgentCraft.LOGGER.info("dev.quit: stopping (render thread {}; forced exit if the stop has not run after {} ms)",
				stalled ? "STALLED " + FrameScheduler.msSinceLastFrame() + " ms" : "ok", forceAfterMs);
		}
		JsonObject o = new JsonObject();
		o.addProperty("quitting", true);
		o.addProperty("alreadyQuitting", !first);
		o.addProperty("renderThreadStalled", stalled);
		o.addProperty("forceAfterMs", forceAfterMs);
		return CompletableFuture.completedFuture(o);
	}

	/** Hard cap on a normal shutdown (after the render thread ran mc.stop) before the JVM is halted. */
	static final long SHUTDOWN_CAP_MS = 90_000;

	private static void quitWatchdog(Minecraft mc, AtomicBoolean stopRan, long forceAfterMs) {
		long deadline = System.currentTimeMillis() + forceAfterMs;
		while (!stopRan.get() && System.currentTimeMillis() < deadline) {
			sleepQuietly(100);
		}
		int exitCode;
		if (!stopRan.get()) {
			AgentCraft.LOGGER.error("dev.quit: the render thread did not run the stop within {} ms (last frame {} ms ago): it is hung. Forcing exit.{}",
				forceAfterMs, FrameScheduler.msSinceLastFrame(), stackOf(mc.getRunningThread()));
			exitCode = 3;
		} else {
			// Normal shutdown in progress; the JVM exit kills this daemon thread long before the cap.
			sleepQuietly(SHUTDOWN_CAP_MS);
			AgentCraft.LOGGER.error("dev.quit: the game is still running {} ms after the stop; forcing exit.{}", SHUTDOWN_CAP_MS, stackOf(mc.getRunningThread()));
			exitCode = 4;
		}
		// The integrated server runs on its own thread: let it save the world before halting.
		var server = mc.getSingleplayerServer();
		if (server != null && server.isRunning()) {
			AgentCraft.LOGGER.warn("dev.quit: stopping the integrated server so the world is saved");
			server.halt(false);
			try {
				server.getRunningThread().join(30_000);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			AgentCraft.LOGGER.warn("dev.quit: integrated server {}", server.getRunningThread().isAlive() ? "did NOT stop within 30 s" : "stopped (world saved)");
		}
		AgentCraft.LOGGER.error("dev.quit: halting the JVM with exit code {}", exitCode);
		System.out.flush();
		System.err.flush();
		Runtime.getRuntime().halt(exitCode);
	}

	private static void sleepQuietly(long ms) {
		try {
			Thread.sleep(ms);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

	private static String stackOf(Thread t) {
		if (t == null) {
			return "";
		}
		StringBuilder sb = new StringBuilder(System.lineSeparator()).append("  ").append(t.getName()).append(" (").append(t.getState()).append("):");
		StackTraceElement[] st = t.getStackTrace();
		for (int i = 0; i < Math.min(st.length, 25); i++) {
			sb.append(System.lineSeparator()).append("    at ").append(st[i]);
		}
		return sb.toString();
	}

	// ------------------------------------------------------------------ dev.screenshot

	static CompletableFuture<JsonObject> screenshot(JsonObject json, Minecraft mc) {
		Fields f = Fields.of(json);
		if (f.has("width") || f.has("height")) {
			// Not supported yet: shots are taken at the window's framebuffer size (dev.state window.renderWidth/Height).
			throw new DevException("width/height are not supported; shots use the window framebuffer size");
		}
		Path out = resolveShotPath(f.str("name"));
		boolean hideHud = f.optBool("hideHud", true);
		int frames = f.optInt("frames", 3, 1, 600);
		boolean waitChunks = f.optBool("waitChunks", true);
		long chunkTimeout = f.optLong("chunkTimeoutMs", 30_000, 0, 600_000);
		int chunkRadius = f.optInt("chunkRadius", FULL_RADIUS, 0, FULL_RADIUS);

		AtomicBoolean restoreHud = new AtomicBoolean(false);
		AtomicBoolean chunksTimedOut = new AtomicBoolean(false);
		AtomicBoolean paused = new AtomicBoolean(false);
		CompletableFuture<JsonObject> result = new CompletableFuture<>();
		long start = System.currentTimeMillis();

		DevBridge.onClient(mc, () -> {
			if (mc.gui.hud.isHidden() != hideHud) {
				mc.gui.hud.toggle();
				restoreHud.set(true);
			}
			return mc.level != null && mc.player != null;
		}).thenCompose(inWorld -> {
			if (!(waitChunks && inWorld)) {
				return CompletableFuture.completedFuture(null);
			}
			// A chunk wait timing out is not fatal: capture anyway and report it.
			return waitChunks(mc, chunkRadius, Math.max(1, chunkTimeout)).exceptionally(t -> {
				chunksTimedOut.set(true);
				return null;
			});
		}).thenCompose(v -> FrameScheduler.afterFrames(frames)).thenAccept(v -> {
			// Runs on the render thread at the end of a frame: the main target holds that frame.
			paused.set(mc.isPaused());
			RenderTarget target = mc.gameRenderer.mainRenderTarget();
			Screenshot.takeScreenshot(target, image -> Util.ioPool().execute(() -> {
				try (NativeImage img = image) {
					Files.createDirectories(out.getParent());
					img.writeToFile(out);
					JsonObject o = new JsonObject();
					o.addProperty("path", out.toString());
					o.addProperty("width", img.getWidth());
					o.addProperty("height", img.getHeight());
					o.addProperty("ms", System.currentTimeMillis() - start);
					o.addProperty("chunksTimedOut", chunksTimedOut.get());
					o.addProperty("paused", paused.get());
					o.add("stats", imageStats(img));
					result.complete(o);
				} catch (Throwable t) {
					result.completeExceptionally(t);
				}
			}));
		}).exceptionally(t -> {
			result.completeExceptionally(t);
			return null;
		});

		return result.whenComplete((o, t) -> {
			if (restoreHud.get()) {
				mc.execute(() -> {
					if (mc.gui.hud.isHidden() == hideHud) {
						mc.gui.hud.toggle();
					}
				});
			}
		});
	}

	static Path resolveShotPath(String name) {
		String clean = name.replace('\\', '/');
		if (clean.isBlank() || clean.contains("..") || clean.startsWith("/") || clean.contains(":")) {
			throw new DevException("bad screenshot name '" + name + "' (use letters, digits, _ - . and / for subfolders)");
		}
		if (!clean.matches("[A-Za-z0-9_./-]+")) {
			throw new DevException("bad screenshot name '" + name + "' (use letters, digits, _ - . and / for subfolders)");
		}
		if (!clean.toLowerCase(Locale.ROOT).endsWith(".png")) {
			clean = clean + ".png";
		}
		Path dir = ClientEnv.shotsDir();
		Path out = dir.resolve(clean).normalize();
		if (!out.startsWith(dir)) {
			throw new DevException("screenshot path escapes the shots dir");
		}
		return out;
	}

	/** Cheap sanity numbers so tools can detect black/blank frames without opening the PNG. */
	static JsonObject imageStats(NativeImage img) {
		int w = img.getWidth();
		int h = img.getHeight();
		int steps = 64;
		double sum = 0;
		double sumSq = 0;
		int n = 0;
		int dark = 0;
		for (int j = 0; j < steps; j++) {
			for (int i = 0; i < steps; i++) {
				int x = (int) ((i + 0.5) * w / steps);
				int y = (int) ((j + 0.5) * h / steps);
				int abgr = img.getPixel(x, y);
				int r = abgr & 0xFF;
				int g = (abgr >> 8) & 0xFF;
				int b = (abgr >> 16) & 0xFF;
				double l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				sum += l;
				sumSq += l * l;
				n++;
				if (l < 8) {
					dark++;
				}
			}
		}
		double mean = sum / n;
		JsonObject s = new JsonObject();
		s.addProperty("meanLuma", Math.round(mean * 10) / 10.0);
		s.addProperty("stdLuma", Math.round(Math.sqrt(Math.max(0, sumSq / n - mean * mean)) * 10) / 10.0);
		s.addProperty("darkFraction", Math.round(dark * 1000.0 / n) / 1000.0);
		return s;
	}

	// ------------------------------------------------------------------ dev.command

	static CompletableFuture<JsonObject> serverCommand(Minecraft mc, String cmd) {
		return DevBridge.onClient(mc, () -> new Object[] {needServer(mc), mc.player.getUUID()}).thenCompose(arr -> {
			var server = (net.minecraft.client.server.IntegratedServer) arr[0];
			UUID uuid = (UUID) arr[1];
			return server.submit(() -> {
				ServerPlayer sp = server.getPlayerList().getPlayer(uuid);
				List<String> messages = new ArrayList<>();
				AtomicBoolean success = new AtomicBoolean(true);
				AtomicInteger result = new AtomicInteger(0);
				AtomicBoolean callbackFired = new AtomicBoolean(false);
				CommandSource capture = new CommandSource() {
					@Override
					public void sendSystemMessage(Component message) {
						messages.add(message.getString());
					}

					@Override
					public boolean acceptsSuccess() {
						return true;
					}

					@Override
					public boolean acceptsFailure() {
						return true;
					}

					@Override
					public boolean shouldInformAdmins() {
						return false;
					}
				};
				CommandSourceStack base = sp != null ? sp.createCommandSourceStack() : server.createCommandSourceStack();
				CommandSourceStack source = base.withSource(capture).withPermission(LevelBasedPermissionSet.OWNER)
					.withCallback((ok, value) -> {
						callbackFired.set(true);
						if (!ok) {
							success.set(false);
						}
						result.set(value);
					});
				server.getCommands().performPrefixedCommand(source, cmd);
				JsonObject o = new JsonObject();
				o.addProperty("cmd", cmd);
				JsonArray arrMsgs = new JsonArray();
				messages.forEach(arrMsgs::add);
				o.add("messages", arrMsgs);
				if (callbackFired.get()) {
					o.addProperty("success", success.get());
					o.addProperty("result", result.get());
				} else {
					// No result callback means the command failed to parse/execute.
					o.addProperty("success", false);
					o.add("result", JsonNull.INSTANCE);
				}
				return o;
			});
		});
	}

	// ------------------------------------------------------------------ dev.screen / key / type

	static CompletableFuture<JsonObject> screen(JsonObject json, Minecraft mc) {
		Fields f = Fields.of(json);
		String name = f.has("open") ? f.str("open") : null;
		return DevBridge.onClient(mc, () -> {
			if (name == null || name.equals("null") || name.equals("none")) {
				if (mc.level == null) {
					mc.gui.setScreen(new TitleScreen());
				} else {
					mc.gui.setScreen(null);
				}
			} else if (name.equals("chat")) {
				needPlayer(mc);
				mc.gui.openChatScreen(ChatComponent.ChatMethod.MESSAGE);
			} else {
				var factory = DevBridge.screens().get(name);
				if (factory == null) {
					throw new DevException("unknown screen '" + name + "'; known: chat, " + String.join(", ", new java.util.TreeSet<>(DevBridge.screens().keySet())));
				}
				mc.gui.setScreen(factory.apply(mc));
			}
			return null;
		}).thenCompose(v -> FrameScheduler.afterFrames(2)).thenApply(v -> {
			JsonObject o = new JsonObject();
			Screen s = mc.gui.screen();
			o.addProperty("screen", s == null ? null : s.getClass().getName());
			return o;
		});
	}

	static CompletableFuture<JsonObject> key(JsonObject json, Minecraft mc) {
		Fields f = Fields.of(json);
		String mappingName = f.has("mapping") ? f.nonBlank("mapping") : null;
		String rawKey = mappingName == null ? f.nonBlank("key") : null;
		int mods = f.optInt("modifiers", 0, 0, 0xFFFF);
		return DevBridge.onClient(mc, () -> {
			JsonObject o = new JsonObject();
			if (mappingName != null) {
				KeyMapping found = null;
				for (KeyMapping km : mc.options.keyMappings) {
					if (km.getName().equals(mappingName)) {
						found = km;
						break;
					}
				}
				if (found == null) {
					throw new DevException("unknown key mapping '" + mappingName + "'");
				}
				KeyMapping.click(InputConstants.getKey(found.saveString()));
				o.addProperty("clicked", mappingName);
				return o;
			}
			String keyName = rawKey.contains(".") ? rawKey : "key.keyboard." + rawKey.toLowerCase(Locale.ROOT);
			InputConstants.Key key;
			try {
				key = InputConstants.getKey(keyName);
			} catch (Exception e) {
				throw new DevException("unknown key '" + keyName + "'");
			}
			Screen screen = mc.gui.screen();
			if (screen != null) {
				boolean handled = screen.keyPressed(new KeyEvent(key.getValue(), 0, mods));
				o.addProperty("screenHandled", handled);
			} else {
				KeyMapping.click(key);
				o.addProperty("clickedKey", keyName);
			}
			return o;
		});
	}

	static CompletableFuture<JsonObject> type(JsonObject json, Minecraft mc) {
		String text = Fields.of(json).str("text");
		if (text.length() > 100_000) {
			throw new DevException("field 'text' is too long (" + text.length() + " chars, max 100000)");
		}
		return DevBridge.onClient(mc, () -> {
			Screen screen = mc.gui.screen();
			if (screen == null) {
				throw new DevException("no screen open");
			}
			int typed = 0;
			for (int i = 0; i < text.length(); ) {
				int cp = text.codePointAt(i);
				i += Character.charCount(cp);
				if (screen.charTyped(new CharacterEvent(cp))) {
					typed++;
				}
			}
			JsonObject o = new JsonObject();
			o.addProperty("typed", typed);
			return o;
		});
	}
}
