package dev.agentcraft.client.setup;

import static org.mockito.Mockito.*;

import com.google.gson.JsonObject;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Ack;
import dev.agentcraft.client.foreman.Protocol.BackendName;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import java.lang.reflect.Field;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.multiplayer.ClientLevel;
import org.junit.jupiter.api.Test;

class SetupFeatureTest {
	@org.junit.jupiter.api.BeforeAll
	static void bootstrap() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	private static void set(Minecraft mc, String field, Object value) throws Exception {
		Field f = Minecraft.class.getDeclaredField(field);
		f.setAccessible(true);
		f.set(mc, value);
	}

	private static Ack result(boolean allowed, boolean complete) {
		JsonObject json = new JsonObject();
		json.addProperty("canConfigure", allowed);
		json.addProperty("setupComplete", complete);
		return new Ack("detect", true, null, json);
	}

	@Test
	void reconnectDiscardsOldDiscoveryAndWaitsForAnUnoccupiedScreen() throws Exception {
		Minecraft mc = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		set(mc, "gui", gui);
		ForemanState state = mock(ForemanState.class);
		ForemanStatus status = mock(ForemanStatus.class);
		when(state.status()).thenReturn(status);
		when(status.backend()).thenReturn(BackendName.CODEX);
		CompletableFuture<Ack> old = new CompletableFuture<>(), current = new CompletableFuture<>();
		try (var singleton = mockStatic(Minecraft.class);
				var foreman = mockStatic(Foreman.class)) {
			singleton.when(Minecraft::getInstance).thenReturn(mc);
			foreman.when(Foreman::connected).thenReturn(true);
			foreman.when(Foreman::state).thenReturn(state);
			foreman.when(() -> Foreman.send(eq("harness.detect"), any())).thenReturn(old, current);
			SetupFeature.tick(mc); // Clear any state from another test.
			set(mc, "level", mock(ClientLevel.class));
			SetupFeature.tick(mc);
			set(mc, "level", null);
			SetupFeature.tick(mc);
			set(mc, "level", mock(ClientLevel.class));
			SetupFeature.tick(mc);
			old.complete(result(true, false));
			SetupFeature.tick(mc);
			verify(gui, never()).setScreen(any());
			when(gui.screen()).thenReturn(mock(Screen.class));
			current.complete(result(true, false));
			SetupFeature.tick(mc);
			verify(gui, never()).setScreen(any());
			when(gui.screen()).thenReturn(null);
			SetupFeature.tick(mc);
			SetupFeature.tick(mc);
			verify(gui, times(1)).setScreen(isA(TeamSetupScreen.class));
			foreman.verify(() -> Foreman.send(eq("harness.detect"), any()), times(2));
			set(mc, "level", null);
			SetupFeature.tick(mc);
		}
	}

	@Test
	void deniedCompletedFailedAndSimulationConnectionsDoNotOpenSetup() throws Exception {
		Minecraft mc = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		set(mc, "gui", gui);
		ForemanState state = mock(ForemanState.class);
		ForemanStatus status = mock(ForemanStatus.class);
		when(state.status()).thenReturn(status);
		when(status.backend()).thenReturn(BackendName.CODEX);
		try (var singleton = mockStatic(Minecraft.class);
				var foreman = mockStatic(Foreman.class)) {
			singleton.when(Minecraft::getInstance).thenReturn(mc);
			foreman.when(Foreman::connected).thenReturn(true);
			foreman.when(Foreman::state).thenReturn(state);
			for (Ack ack :
					new Ack[] {
						result(false, false), result(true, true), new Ack("denied", false, "Owner only", null)
					}) {
				set(mc, "level", null);
				SetupFeature.tick(mc);
				foreman
						.when(() -> Foreman.send(eq("harness.detect"), any()))
						.thenReturn(CompletableFuture.completedFuture(ack));
				set(mc, "level", mock(ClientLevel.class));
				SetupFeature.tick(mc);
				SetupFeature.tick(mc);
			}
			set(mc, "level", null);
			SetupFeature.tick(mc);
			when(status.backend()).thenReturn(BackendName.SIM);
			set(mc, "level", mock(ClientLevel.class));
			SetupFeature.tick(mc);
			foreman.verify(() -> Foreman.send(eq("harness.detect"), any()), times(3));
			verify(gui, never()).setScreen(any());
			set(mc, "level", null);
			SetupFeature.tick(mc);
		}
	}
}
