package dev.agentcraft.layout;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The single source of named world positions (see {@link AnchorNames} for the naming contract).
 *
 * <p>An HQ builder computes a {@link Layout} and {@link #publish publishes} it on the server thread;
 * it is saved as {@code agentcraft-anchors.json} in the world folder and loaded again whenever the HQ
 * world starts, so the layout survives restarts without rebuilding. Readers on any thread get an
 * immutable snapshot ({@link #current()}); the client (same JVM in singleplayer) reads it directly.
 * Listeners are told about every new layout (on the thread that published it).
 */
public final class Anchors {
	public static final String FILE = "agentcraft-anchors.json";
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Axis-aligned region the HQ occupies (block coordinates, inclusive). Agent path search stays inside it. */
	public record Bounds(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		public boolean contains(int x, int y, int z) {
			return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
		}
	}

	/** An immutable published layout. {@code revision} increases with every publish (also across loads). */
	public record Layout(String name, long revision, @Nullable Bounds bounds, Map<String, Anchor> anchors) {
		public static final Layout EMPTY = new Layout("none", 0, null, Map.of());

		public @Nullable Anchor get(String anchorName) {
			return anchors.get(anchorName);
		}

		public boolean isEmpty() {
			return anchors.isEmpty();
		}
	}

	private static volatile Layout current = Layout.EMPTY;
	private static final List<Consumer<Layout>> LISTENERS = new CopyOnWriteArrayList<>();

	private Anchors() {
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(Anchors::load);
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> set(Layout.EMPTY));
	}

	public static Layout current() {
		return current;
	}

	/** Apply a layout delivered by the connected multiplayer server; the client never persists it locally. */
	public static void receiveServerLayout(JsonObject root) {
		set(fromJson(root));
	}

	public static @Nullable Anchor get(String name) {
		return current.anchors().get(name);
	}

	public static void addListener(Consumer<Layout> listener) {
		LISTENERS.add(listener);
	}

	public static Builder builder(String layoutName) {
		return new Builder(layoutName);
	}

	/** Builder whose locally specified coordinates are translated into an isolated world region. */
	public static Builder builder(String layoutName, int offsetX, int offsetY, int offsetZ) {
		return new Builder(layoutName, offsetX, offsetY, offsetZ);
	}

	/** Make {@code layout} current and save it with the world. Call on the server thread. */
	public static void publish(MinecraftServer server, Layout layout) {
		Layout withRev = new Layout(layout.name(), current.revision() + 1, layout.bounds(), layout.anchors());
		set(withRev);
		save(server, withRev);
		AgentCraft.LOGGER.info("Published layout '{}' rev {} with {} anchors", withRev.name(), withRev.revision(), withRev.anchors().size());
	}

	private static void set(Layout layout) {
		if (layout.equals(current)) return; // A server echo must not re-publish itself in integrated worlds.
		current = layout;
		for (Consumer<Layout> l : LISTENERS) {
			try {
				l.accept(layout);
			} catch (Throwable t) {
				AgentCraft.LOGGER.warn("Anchor listener failed", t);
			}
		}
	}

	// ------------------------------------------------------------------ persistence

	private static Path file(MinecraftServer server) {
		return server.getWorldPath(LevelResource.ROOT).resolve(FILE);
	}

	private static void save(MinecraftServer server, Layout layout) {
		JsonObject root = toJson(layout);
		Path f = file(server);
		try {
			Path tmp = f.resolveSibling(FILE + ".tmp");
			Files.writeString(tmp, GSON.toJson(root), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			AgentCraft.LOGGER.warn("Could not save {}", f, e);
		}
	}

	private static void load(MinecraftServer server) {
		Path f = file(server);
		if (!Files.exists(f)) {
			AgentCraft.LOGGER.info("No {} yet (run /agentcraft hq to build the HQ and its anchors)", FILE);
			set(Layout.EMPTY);
			return;
		}
		try {
			Layout layout = fromJson(JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject());
			set(layout);
			AgentCraft.LOGGER.info("Loaded layout '{}' rev {} ({} anchors)", layout.name(), layout.revision(), layout.anchors().size());
		} catch (Exception e) {
			AgentCraft.LOGGER.warn("Could not read {}; run /agentcraft hq again", f, e);
			set(Layout.EMPTY);
		}
	}

	public static JsonObject toJson(Layout layout) {
		JsonObject root = new JsonObject();
		root.addProperty("layout", layout.name());
		root.addProperty("revision", layout.revision());
		if (layout.bounds() != null) {
			Bounds b = layout.bounds();
			JsonObject bj = new JsonObject();
			bj.addProperty("minX", b.minX());
			bj.addProperty("minY", b.minY());
			bj.addProperty("minZ", b.minZ());
			bj.addProperty("maxX", b.maxX());
			bj.addProperty("maxY", b.maxY());
			bj.addProperty("maxZ", b.maxZ());
			root.add("bounds", bj);
		}
		JsonObject anchors = new JsonObject();
		layout.anchors().forEach((name, a) -> anchors.add(name, anchorJson(a)));
		root.add("anchors", anchors);
		return root;
	}

	public static JsonObject anchorJson(Anchor a) {
		JsonObject o = new JsonObject();
		o.addProperty("x", round(a.x()));
		o.addProperty("y", round(a.y()));
		o.addProperty("z", round(a.z()));
		o.addProperty("yaw", round(a.yaw()));
		o.addProperty("pitch", round(a.pitch()));
		return o;
	}

	private static double round(double v) {
		return Math.round(v * 1000.0) / 1000.0;
	}

	static Layout fromJson(JsonObject root) {
		Map<String, Anchor> map = new LinkedHashMap<>();
		JsonObject anchors = root.has("anchors") ? root.getAsJsonObject("anchors") : new JsonObject();
		for (var e : anchors.entrySet()) {
			JsonObject o = e.getValue().getAsJsonObject();
			map.put(e.getKey(), new Anchor(e.getKey(), o.get("x").getAsDouble(), o.get("y").getAsDouble(), o.get("z").getAsDouble(),
				o.has("yaw") ? o.get("yaw").getAsFloat() : 0f, o.has("pitch") ? o.get("pitch").getAsFloat() : 0f));
		}
		Bounds bounds = null;
		if (root.has("bounds")) {
			JsonObject b = root.getAsJsonObject("bounds");
			bounds = new Bounds(b.get("minX").getAsInt(), b.get("minY").getAsInt(), b.get("minZ").getAsInt(),
				b.get("maxX").getAsInt(), b.get("maxY").getAsInt(), b.get("maxZ").getAsInt());
		}
		String name = root.has("layout") ? root.get("layout").getAsString() : "unknown";
		long rev = root.has("revision") ? root.get("revision").getAsLong() : 1;
		return new Layout(name, rev, bounds, Collections.unmodifiableMap(map));
	}

	// ------------------------------------------------------------------ builder

	/** Collects anchors while an HQ builder runs. Later puts with the same name replace earlier ones. */
	public static final class Builder {
		private final String name;
		private final int offsetX;
		private final int offsetY;
		private final int offsetZ;
		private final Map<String, Anchor> anchors = new LinkedHashMap<>();
		private @Nullable Bounds bounds;

		private Builder(String name) {
			this(name, 0, 0, 0);
		}

		private Builder(String name, int offsetX, int offsetY, int offsetZ) {
			this.name = name;
			this.offsetX = offsetX;
			this.offsetY = offsetY;
			this.offsetZ = offsetZ;
		}

		public Builder put(String anchorName, double x, double y, double z, float yaw, float pitch) {
			anchors.put(anchorName, new Anchor(anchorName, x + offsetX, y + offsetY, z + offsetZ, yaw, pitch));
			return this;
		}

		/** A standing spot: feet at the top centre of block (bx, by, bz) ... i.e. x+0.5, y, z+0.5. */
		public Builder spot(String anchorName, int bx, int feetY, int bz, float yaw) {
			return put(anchorName, bx + 0.5, feetY, bz + 0.5, yaw, 0f);
		}

		/** Camera point: eye position + view direction. */
		public Builder camera(String camName, double x, double y, double z, float yaw, float pitch) {
			String n = camName.startsWith(AnchorNames.CAM_PREFIX) ? camName : AnchorNames.CAM_PREFIX + camName;
			return put(n, x, y, z, yaw, pitch);
		}

		/** Camera point looking at a target position. */
		public Builder cameraLookAt(String camName, double x, double y, double z, double tx, double ty, double tz) {
			double dx = tx - x;
			double dy = ty - y;
			double dz = tz - z;
			float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
			float pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
			return camera(camName, x, y, z, yaw, pitch);
		}

		public Builder bounds(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
			this.bounds = new Bounds(Math.min(minX, maxX) + offsetX, Math.min(minY, maxY) + offsetY, Math.min(minZ, maxZ) + offsetZ,
				Math.max(minX, maxX) + offsetX, Math.max(minY, maxY) + offsetY, Math.max(minZ, maxZ) + offsetZ);
			return this;
		}

		public Layout build() {
			return new Layout(name, 0, bounds, Collections.unmodifiableMap(new LinkedHashMap<>(anchors)));
		}
	}
}
