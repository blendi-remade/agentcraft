package dev.agentcraft.security;

import java.util.UUID;
import java.util.Optional;
import com.mojang.authlib.GameProfile;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/** Stable owner identity for host-side AgentCraft operations. Player names are never authority. */
public final class OwnerAccess {
	private OwnerAccess() {
	}

	/** Explicit dedicated-server owner, or the actual integrated-server singleplayer profile. */
	public static Optional<UUID> ownerUuid(MinecraftServer server) {
		String raw = System.getProperty("agentcraft.owner.uuid");
		if (raw == null || raw.isBlank()) {
			raw = System.getenv("AGENTCRAFT_OWNER_UUID");
		}
		if (raw == null || raw.isBlank()) {
			if (!server.isSingleplayer()) {
				return Optional.empty();
			}
			GameProfile profile = server.getSingleplayerProfile();
			return profile == null ? Optional.empty() : Optional.of(profile.id());
		}
		try {
			return Optional.of(UUID.fromString(raw.trim()));
		} catch (IllegalArgumentException e) {
			return Optional.empty();
		}
	}

	/**
	 * The configured UUID is trusted only when Minecraft authenticated it. Integrated singleplayer
	 * uses the local authenticated profile; dedicated servers must keep online-mode enabled.
	 */
	public static boolean isOwner(MinecraftServer server, UUID playerId) {
		boolean trustedSession = server.isSingleplayer() || server.usesAuthentication() || flag("agentcraft.owner.allowOffline", "AGENTCRAFT_OWNER_ALLOW_OFFLINE");
		return trustedSession && ownerUuid(server).filter(playerId::equals).isPresent();
	}

	public static boolean isOwner(ServerPlayer player) {
		MinecraftServer server = player.level().getServer();
		return isOwner(server, player.getUUID());
	}

	/** Player commands require the configured UUID; only the dedicated server's real console bypasses it. */
	public static boolean isOwnerOrConsole(CommandSourceStack source) {
		ServerPlayer player = source.getPlayer();
		if (player != null) {
			return isOwner(player);
		}
		// withSource returns this only when the backing CommandSource is identical. Display
		// names are forgeable (for example a command block named "Server").
		return source.getEntity() == null && source.getServer().isDedicatedServer()
			&& source.withSource(source.getServer()) == source;
	}

	private static boolean flag(String property, String environment) {
		String raw = System.getProperty(property);
		if (raw == null) {
			raw = System.getenv(environment);
		}
		return raw != null && (raw.trim().equals("1") || raw.trim().equalsIgnoreCase("true") || raw.trim().equalsIgnoreCase("yes"));
	}
}
