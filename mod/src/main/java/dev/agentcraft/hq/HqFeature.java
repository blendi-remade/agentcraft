package dev.agentcraft.hq;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.command.AgentCraftCommands;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.security.OwnerAccess;
import dev.agentcraft.world.HqWorld;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * HQ feature (common side): {@code /agentcraft hq [builder] [force]} builds the HQ and publishes its
 * anchors. The studio builder keeps cells the player changed since its last build; {@code force}
 * resets them too.
 */
public final class HqFeature {
	private HqFeature() {
	}

	/** The report of the last build (for QA: {@code dev.state.hq.lastBuild}). */
	private static volatile @Nullable String lastReport;

	public static @Nullable String lastReport() {
		return lastReport;
	}

	public static void init() {
		HqBuilders.register(new TestRoomBuilder());
		HqBuilders.register(new StudioHqBuilder());
		HqBuilders.setDefault(StudioHqBuilder.ID);
		// A fresh HQ world (no saved layout yet) gets the default HQ built before the player joins, so
		// the first launch walks straight into it. AGENTCRAFT_HQ_AUTOBUILD=0 turns this off.
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			if (!HqWorld.isHq(server) || !Anchors.current().isEmpty() || !autoBuild()) {
				return;
			}
			HqBuilder builder = HqBuilders.get(HqBuilders.defaultId());
			if (builder != null) {
				try {
					buildAndPublish(server.overworld(), builder, HqBuilder.Options.DEFAULT);
					AgentCraft.LOGGER.info("Fresh HQ world: built the default HQ '{}'", builder.id());
				} catch (RuntimeException e) {
					AgentCraft.LOGGER.error("Auto-building the HQ failed (run /agentcraft hq)", e);
				}
			}
		});
		AgentCraftCommands.sub(root -> root.then(Commands.literal("hq")
			.executes(ctx -> build(ctx, HqBuilders.defaultId(), buildOptions(HqBuilders.defaultId(), false)))
			.then(Commands.literal("force").executes(ctx -> build(ctx, HqBuilders.defaultId(), buildOptions(HqBuilders.defaultId(), true))))
			.then(Commands.argument("builder", StringArgumentType.word())
				.suggests((ctx, b) -> {
					HqBuilders.ids().forEach(b::suggest);
					return b.buildFuture();
				})
				.executes(ctx -> build(ctx, StringArgumentType.getString(ctx, "builder"), buildOptions(StringArgumentType.getString(ctx, "builder"), false)))
				.then(Commands.literal("force").executes(ctx -> build(ctx, StringArgumentType.getString(ctx, "builder"), buildOptions(StringArgumentType.getString(ctx, "builder"), true)))
					.then(Commands.literal("at").then(atCoordinates(true))))
				.then(Commands.literal("at").then(atCoordinates(false))))));
	}

	private static boolean autoBuild() {
		String v = System.getProperty("agentcraft.hq.autobuild");
		if (v == null) {
			v = System.getenv("AGENTCRAFT_HQ_AUTOBUILD");
		}
		return v == null || !(v.trim().equals("0") || v.trim().equalsIgnoreCase("false") || v.trim().equalsIgnoreCase("off"));
	}

	/** Optional, explicit world-space origin for a regular world: x/z = centre, y = meadow top. */
	private static HqBuilder.Options buildOptions(String id, boolean force) {
		if (!StudioHqBuilder.ID.equals(id)) {
			return new HqBuilder.Options(force);
		}
		Integer x = configInt("agentcraft.studio.x", "AGENTCRAFT_STUDIO_X");
		Integer y = configInt("agentcraft.studio.y", "AGENTCRAFT_STUDIO_Y");
		Integer z = configInt("agentcraft.studio.z", "AGENTCRAFT_STUDIO_Z");
		if (x == null && y == null && z == null) {
			return new HqBuilder.Options(force);
		}
		if (x == null || y == null || z == null || Math.abs((long) x) > 29_999_984 || Math.abs((long) z) > 29_999_984 || y < -64 || y > 320) {
			AgentCraft.LOGGER.warn("Studio origin needs valid agentcraft.studio.x/y/z values; use /agentcraft hq studio at x y z instead");
			return new HqBuilder.Options(force);
		}
		return new HqBuilder.Options(force, x, y, z, true);
	}

	private static @Nullable Integer configInt(String property, String environment) {
		String raw = System.getProperty(property);
		if (raw == null || raw.isBlank()) {
			raw = System.getenv(environment);
		}
		if (raw == null || raw.isBlank()) {
			return null;
		}
		try {
			return Integer.parseInt(raw.trim());
		} catch (NumberFormatException e) {
			return null;
		}
	}

	private static com.mojang.brigadier.builder.ArgumentBuilder<CommandSourceStack, ?> atCoordinates(boolean force) {
		return Commands.argument("x", com.mojang.brigadier.arguments.IntegerArgumentType.integer(-29_999_984, 29_999_984))
			.then(Commands.argument("y", com.mojang.brigadier.arguments.IntegerArgumentType.integer(-64, 320))
				.then(Commands.argument("z", com.mojang.brigadier.arguments.IntegerArgumentType.integer(-29_999_984, 29_999_984))
					.executes(ctx -> build(ctx, StringArgumentType.getString(ctx, "builder"), new HqBuilder.Options(force,
						com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "x"),
						com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "y"),
						com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "z"), true)))));
	}

	private static int build(CommandContext<CommandSourceStack> ctx, String id, HqBuilder.Options options) {
		if (!OwnerAccess.isOwnerOrConsole(ctx.getSource())) {
			ctx.getSource().sendFailure(Component.literal("Only the configured server owner can build or reset an AgentCraft studio."));
			return 0;
		}
		HqBuilder builder = HqBuilders.get(id);
		if (builder == null) {
			ctx.getSource().sendFailure(Component.literal("Unknown HQ builder '" + id + "' (known: " + HqBuilders.ids() + ")"));
			return 0;
		}
		if (!HqWorld.isHq(ctx.getSource().getServer()) && !options.explicitOrigin()) {
			ctx.getSource().sendFailure(Component.literal("On an existing world, give the isolated studio origin explicitly: /agentcraft hq studio at 12288 200 12288"));
			return 0;
		}
		if (options.explicitOrigin() && !StudioHqBuilder.ID.equals(id)) {
			ctx.getSource().sendFailure(Component.literal("Explicit coordinates are supported by the studio builder only."));
			return 0;
		}
		Anchors.Layout layout;
		try {
			layout = buildAndPublish(ctx.getSource().getLevel(), builder, options);
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.error("HQ builder '{}' failed", id, e);
			ctx.getSource().sendFailure(Component.literal("HQ builder '" + id + "' failed: " + e));
			return 0;
		}
		String report = lastReport;
		ctx.getSource().sendSuccess(() -> Component.literal("Built HQ '" + id + "': " + layout.anchors().size() + " anchors"
			+ (report == null ? "" : ". " + report)), true);
		return layout.anchors().size();
	}

	/** Runs {@code builder} (server thread), publishes its layout and moves the world spawn to its spawn anchor. */
	public static Anchors.Layout buildAndPublish(ServerLevel level, HqBuilder builder) {
		return buildAndPublish(level, builder, HqBuilder.Options.DEFAULT);
	}

	public static Anchors.Layout buildAndPublish(ServerLevel level, HqBuilder builder, HqBuilder.Options options) {
		// Layout persistence, visits and agent simulation currently describe one Overworld studio.
		// Reject other dimensions before touching the saved plan or any blocks.
		if (!level.dimension().equals(net.minecraft.world.level.Level.OVERWORLD)) {
			throw new IllegalArgumentException("Build the AgentCraft studio in the Overworld; other dimensions are not supported.");
		}
		long t0 = System.nanoTime();
		// another builder rewrites the same ground without a record: the studio's memory of its last
		// build no longer describes the world
		PlanStore.invalidateUnless(level.getServer(), builder.id());
		int dx = options.explicitOrigin() && StudioHqBuilder.ID.equals(builder.id()) ? options.originX() : 0;
		int dy = options.explicitOrigin() && StudioHqBuilder.ID.equals(builder.id()) ? options.originY() - StudioHqBuilder.GROUND : 0;
		int dz = options.explicitOrigin() && StudioHqBuilder.ID.equals(builder.id()) ? options.originZ() : 0;
		Anchors.Builder anchors = Anchors.builder(builder.id(), dx, dy, dz);
		lastReport = builder.build(level, anchors, options);
		Anchors.Layout layout = anchors.build();
		Anchors.publish(level.getServer(), layout);
		Anchor spawn = layout.get(AnchorNames.SPAWN);
		if (spawn != null && HqWorld.isHq(level.getServer())) {
			level.getServer().getCommands().performPrefixedCommand(level.getServer().createCommandSourceStack().withSuppressedOutput(),
				String.format(Locale.ROOT, "setworldspawn %d %d %d %.1f 0", (int) Math.floor(spawn.x()), (int) Math.floor(spawn.y()),
					(int) Math.floor(spawn.z()), spawn.yaw()));
		}
		AgentCraft.LOGGER.info("HQ '{}' built in {} ms{}", builder.id(), (System.nanoTime() - t0) / 1_000_000,
			lastReport == null ? "" : ": " + lastReport);
		return layout;
	}
}
