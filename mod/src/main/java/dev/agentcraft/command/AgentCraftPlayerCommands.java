package dev.agentcraft.command;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.client.foreman.ForemanJson;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.security.OwnerAccess;
import dev.agentcraft.server.ServerForemanRelay;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/** Public multiplayer commands and owner-gated Foreman intents. */
public final class AgentCraftPlayerCommands {
	private AgentCraftPlayerCommands() {
	}

	public static void init() {
		AgentCraftCommands.sub(root -> root
			.then(Commands.literal("status").executes(ctx -> {
				ctx.getSource().sendSuccess(() -> Component.literal(ServerForemanRelay.statusLine()), false);
				return 1;
			}))
			.then(Commands.literal("visit")
				.executes(ctx -> visit(ctx, "entrance"))
				.then(Commands.argument("anchor", StringArgumentType.word())
					.suggests((ctx, builder) -> {
						Anchors.current().anchors().keySet().forEach(builder::suggest);
						return builder.buildFuture();
					})
					.executes(ctx -> visit(ctx, StringArgumentType.getString(ctx, "anchor")))))
			.then(Commands.literal("ask").then(Commands.argument("text", StringArgumentType.greedyString())
				.executes(ctx -> sendMessage(ctx, "all", StringArgumentType.getString(ctx, "text"), "ask"))))
			.then(Commands.literal("message").then(Commands.argument("target", StringArgumentType.word())
				.then(Commands.argument("text", StringArgumentType.greedyString())
					.executes(ctx -> sendMessage(ctx, StringArgumentType.getString(ctx, "target"), StringArgumentType.getString(ctx, "text"), "message")))))
			.then(Commands.literal("reconnect").executes(ctx -> {
				if (ctx.getSource().getEntity() instanceof ServerPlayer player) {
					ServerForemanRelay.reconnectFromCommand(player);
				} else {
					ctx.getSource().sendFailure(Component.literal("Run this as the configured server owner in game."));
				}
				return 1;
			})));
	}

	private static int visit(CommandContext<CommandSourceStack> ctx, String name) {
		if (!(ctx.getSource().getEntity() instanceof ServerPlayer player)) {
			ctx.getSource().sendFailure(Component.literal("/agentcraft visit is a player command."));
			return 0;
		}
		Anchor anchor = Anchors.get(name);
		if (anchor == null) {
			ctx.getSource().sendFailure(Component.literal("No AgentCraft anchor named '" + name + "' exists in this world yet."));
			return 0;
		}
		player.teleportTo(ctx.getSource().getServer().overworld(), anchor.x(), anchor.y(), anchor.z(), java.util.Set.of(), anchor.yaw(), anchor.pitch(), false);
		ctx.getSource().sendSuccess(() -> Component.literal("Visiting AgentCraft " + name + "."), false);
		return 1;
	}

	private static int sendMessage(CommandContext<CommandSourceStack> ctx, String to, String text, String command) {
		if (!(ctx.getSource().getEntity() instanceof ServerPlayer player) || !OwnerAccess.isOwner(player)) {
			ctx.getSource().sendFailure(Component.literal("Only the configured server owner can send prompts or work requests to the host Foreman. Use normal Minecraft chat to talk with other players."));
			return 0;
		}
		String body = text.trim();
		if (body.isEmpty() || body.length() > 1000) {
			ctx.getSource().sendFailure(Component.literal("Message text must contain 1–1000 characters."));
			return 0;
		}
		if (!ServerForemanRelay.connected()) {
			ctx.getSource().sendFailure(Component.literal("Foreman is not connected through the server yet. Try /agentcraft status."));
			return 0;
		}
		var message = ForemanJson.msg("user.message").put("to", to).put("text", body).json();
		if (!ServerForemanRelay.sendFromCommand(player, message)) {
			return 0;
		}
		ctx.getSource().sendSuccess(() -> Component.literal(command.equals("ask") ? "Sent your prompt to the AgentCraft team." : "Sent your message to " + to + "."), false);
		return 1;
	}
}
