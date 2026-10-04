package dev.agentcraft.security;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.mojang.authlib.GameProfile;
import java.util.UUID;
import net.minecraft.server.MinecraftServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class OwnerAccessTest {
	private static final UUID OWNER = UUID.fromString("12345678-1234-1234-1234-123456789abc");
	private final MinecraftServer server = mock(MinecraftServer.class);

	@AfterEach void clearProperties() {
		System.clearProperty("agentcraft.owner.uuid");
		System.clearProperty("agentcraft.owner.allowOffline");
	}

	@Test void authenticatedConfiguredOwnerOnly() {
		System.setProperty("agentcraft.owner.uuid", OWNER.toString());
		when(server.usesAuthentication()).thenReturn(true);
		assertTrue(OwnerAccess.isOwner(server, OWNER));
		assertFalse(OwnerAccess.isOwner(server, UUID.randomUUID()));
	}

	@Test void missingAndMalformedOwnerFailClosed() {
		when(server.usesAuthentication()).thenReturn(true);
		assertTrue(OwnerAccess.ownerUuid(server).isEmpty());
		assertFalse(OwnerAccess.isOwner(server, OWNER));
		System.setProperty("agentcraft.owner.uuid", "not-a-uuid");
		assertFalse(OwnerAccess.isOwner(server, OWNER));
	}

	@Test void offlineDedicatedRejectedByDefaultWithExplicitLegacyOptIn() {
		System.setProperty("agentcraft.owner.uuid", OWNER.toString());
		assertFalse(OwnerAccess.isOwner(server, OWNER));
		System.setProperty("agentcraft.owner.allowOffline", "true");
		assertTrue(OwnerAccess.isOwner(server, OWNER));
		assertFalse(OwnerAccess.isOwner(server, UUID.randomUUID()));
	}

	@Test void integratedServerUsesLocalProfile() {
		when(server.isSingleplayer()).thenReturn(true);
		when(server.getSingleplayerProfile()).thenReturn(new GameProfile(OWNER, "Owner"));
		assertTrue(OwnerAccess.isOwner(server, OWNER));
		assertFalse(OwnerAccess.isOwner(server, UUID.randomUUID()));
	}

	@Test void namedCommandSourceCannotImpersonateDedicatedConsole() {
		when(server.isDedicatedServer()).thenReturn(true);
		var source = new net.minecraft.commands.CommandSourceStack(
			mock(net.minecraft.commands.CommandSource.class), net.minecraft.world.phys.Vec3.ZERO,
			net.minecraft.world.phys.Vec2.ZERO, null, mock(net.minecraft.server.permissions.PermissionSet.class),
			net.minecraft.network.chat.Component.literal("Server"), server);
		assertEquals("Server", source.getTextName());
		assertFalse(OwnerAccess.isOwnerOrConsole(source));
		assertTrue(OwnerAccess.isOwnerOrConsole(source.withSource(server)));
	}
}
