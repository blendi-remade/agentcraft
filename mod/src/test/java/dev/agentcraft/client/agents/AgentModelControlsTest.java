package dev.agentcraft.client.agents;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.Ack;
import dev.agentcraft.client.setup.TeamSetupScreen;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import org.junit.jupiter.api.Test;

class AgentModelControlsTest {
	private static void set(Object target, Class<?> type, String name, Object value)
			throws Exception {
		Field field = type.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	@Test
	void failedProviderPreviewClearsOldModelsAndRetrySavesTheNewCatalog() throws Exception {
		Minecraft mc = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		set(mc, Minecraft.class, "gui", gui);
		List<JsonObject> saves = new ArrayList<>();
		int[] requests = {0};
		try (var singleton = mockStatic(Minecraft.class);
				var foreman = mockStatic(Foreman.class)) {
			singleton.when(Minecraft::getInstance).thenReturn(mc);
			foreman
					.when(() -> Foreman.send(anyString(), any()))
					.thenAnswer(
							call -> {
								String type = call.getArgument(0);
								JsonObject payload = call.getArgument(1);
								if (type.equals("agent.models") && ++requests[0] == 2)
									return CompletableFuture.completedFuture(
											new Ack("test", false, "Claude unavailable", null));
								if (type.equals("agent.configure")) saves.add(payload.deepCopy());
								String provider =
										payload.has("provider") ? payload.get("provider").getAsString() : "codex";
								String model = provider.equals("codex") ? "astra" : "sonnet";
								JsonObject result =
										JsonParser.parseString(
														"{\"models\":[{\"model\":\""
																+ model
																+ "\",\"label\":\"Model\",\"efforts\":[\"default\",\"high\"],\"defaultEffort\":\"default\"}],\"next\":{\"model\":\"original\"},\"active\":null}")
												.getAsJsonObject();
								result.addProperty("catalogProvider", provider);
								return CompletableFuture.completedFuture(new Ack("test", true, null, result));
							});
			AgentModelScreen screen = new AgentModelScreen(null, "marlow");
			screen.width = 480;
			screen.height = 300;
			set(screen, Screen.class, "minecraft", mc);
			screen.init();
			Field choices = AgentModelScreen.class.getDeclaredField("models");
			choices.setAccessible(true);
			assertEquals(1, ((List<?>) choices.get(screen)).size());
			screen.keyPressed(new KeyEvent(InputConstants.KEY_L, 'l', 0));
			assertTrue(
					((List<?>) choices.get(screen)).isEmpty(),
					"Failed Claude preview must not retain Codex models");
			screen.keyPressed(new KeyEvent(InputConstants.KEY_RETURN, 13, 0));
			assertTrue(saves.isEmpty(), "An unavailable catalog cannot be applied");
			screen.keyPressed(new KeyEvent(InputConstants.KEY_R, 'r', 0));
			screen.keyPressed(new KeyEvent(InputConstants.KEY_RIGHT, 0, 0));
			screen.keyPressed(new KeyEvent(InputConstants.KEY_RETURN, 13, 0));
			assertEquals(1, saves.size());
			assertEquals("claude", saves.getFirst().get("provider").getAsString());
			assertEquals("sonnet", saves.getFirst().get("model").getAsString());
			assertEquals("high", saves.getFirst().get("effort").getAsString());
		}
	}

	@Test
	void mouseAndKeyboardPreviewProvidersWithoutSavingAndDefaultsClearsOverrides() throws Exception {
		Minecraft mc = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		set(mc, Minecraft.class, "gui", gui);
		List<JsonObject> previews = new ArrayList<>(), saves = new ArrayList<>();
		try (var singleton = mockStatic(Minecraft.class);
				var foreman = mockStatic(Foreman.class)) {
			singleton.when(Minecraft::getInstance).thenReturn(mc);
			foreman
					.when(() -> Foreman.send(anyString(), any()))
					.thenAnswer(
							call -> {
								String type = call.getArgument(0);
								JsonObject payload = call.getArgument(1);
								(type.equals("agent.models") ? previews : saves).add(payload.deepCopy());
								JsonObject result =
										JsonParser.parseString(
														"{\"models\":[],\"next\":{\"model\":\"original\"},\"active\":null}")
												.getAsJsonObject();
								if (payload.has("provider")) result.add("catalogProvider", payload.get("provider"));
								return CompletableFuture.completedFuture(new Ack("test", true, null, result));
							});
			AgentModelScreen screen = new AgentModelScreen(mock(Screen.class), "marlow");
			set(screen, Screen.class, "minecraft", mc);
			set(screen, AgentModelScreen.class, "loading", false);
			set(screen, AgentModelScreen.class, "x", 20);
			set(screen, AgentModelScreen.class, "y", 20);
			set(screen, AgentModelScreen.class, "w", 400);
			screen.keyPressed(new KeyEvent(InputConstants.KEY_C, 'c', 0));
			screen.keyPressed(new KeyEvent(InputConstants.KEY_L, 'l', 0));
			screen.mouseClicked(
					new MouseButtonEvent(70, 80, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0)),
					false);
			screen.mouseClicked(
					new MouseButtonEvent(200, 80, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0)),
					false);
			assertEquals(
					List.of("codex", "claude", "codex", "claude"),
					previews.stream().map(p -> p.get("provider").getAsString()).toList());
			assertTrue(saves.isEmpty(), "Provider preview must not change saved settings");
			screen.keyPressed(new KeyEvent(InputConstants.KEY_D, 'd', 0));
			assertEquals(1, saves.size());
			assertEquals("marlow", saves.getFirst().get("agentId").getAsString());
			assertFalse(saves.getFirst().has("provider"));
			assertFalse(saves.getFirst().has("model"));
			assertFalse(saves.getFirst().has("effort"));
			screen.keyPressed(new KeyEvent(InputConstants.KEY_T, 't', 0));
			verify(gui).setScreen(isA(TeamSetupScreen.class));
		}
	}
}
