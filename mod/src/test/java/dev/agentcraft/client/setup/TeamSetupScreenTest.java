package dev.agentcraft.client.setup;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.Ack;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import org.junit.jupiter.api.Test;

class TeamSetupScreenTest {
	@org.junit.jupiter.api.BeforeAll
	static void bootstrap() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	private static void set(Object target, Class<?> type, String name, Object value)
			throws Exception {
		Field f = type.getDeclaredField(name);
		f.setAccessible(true);
		f.set(target, value);
	}

	private static JsonObject discovery(boolean claude) {
		JsonObject result =
				JsonParser.parseString(
								"""
								{"canConfigure":true,"setupComplete":false,"hasAgentOverrides":true,"roles":{},"harnesses":[
								{"provider":"codex","available":true,"version":"Codex test","models":[{"model":"sol","label":"Sol","efforts":["high"],"defaultEffort":"high"}]},
								{"provider":"claude","available":true,"version":"Claude test","models":[{"model":"sonnet","label":"Sonnet","efforts":["default","high"],"defaultEffort":"default"}]}]}
								""")
						.getAsJsonObject();
		result.getAsJsonArray("harnesses").get(1).getAsJsonObject().addProperty("available", claude);
		return result;
	}

	private static void click(TeamSetupScreen screen, double x, double y) {
		screen.mouseClicked(
				new MouseButtonEvent(x, y, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0)),
				false);
		screen.tick();
	}

	private void scenario(boolean claude, boolean reset) throws Exception {
		scenario(claude, reset, false);
	}

	private void scenario(boolean claude, boolean reset, boolean editWorker) throws Exception {
		scenario(claude, reset, editWorker, 0);
	}

	private void scenario(boolean claude, boolean reset, boolean editWorker, int failure)
			throws Exception {
		Minecraft mc = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		when(mc.getSoundManager()).thenReturn(mock(net.minecraft.client.sounds.SoundManager.class));
		set(mc, Minecraft.class, "gui", gui);
		set(mc, Minecraft.class, "font", mock(Font.class));
		List<JsonObject> saves = new ArrayList<>();
		CompletableFuture<Ack> detected = new CompletableFuture<>();
		try (var singleton = mockStatic(Minecraft.class);
				var foreman = mockStatic(Foreman.class)) {
			singleton.when(Minecraft::getInstance).thenReturn(mc);
			foreman.when(() -> Foreman.send(eq("harness.detect"), any())).thenReturn(detected);
			foreman
					.when(() -> Foreman.send(eq("team.configure"), any()))
					.thenAnswer(
							call -> {
								saves.add(((JsonObject) call.getArgument(1)).deepCopy());
								if (saves.size() == 1 && failure == 1)
									return CompletableFuture.completedFuture(
											new Ack("save", false, "Unavailable provider", null));
								if (saves.size() == 1 && failure == 2)
									return CompletableFuture.failedFuture(
											new IllegalStateException("Connection lost"));
								return CompletableFuture.completedFuture(
										new Ack("save", true, null, new JsonObject()));
							});
			TeamSetupScreen screen = new TeamSetupScreen(null);
			screen.width = 480;
			screen.height = 300;
			set(screen, net.minecraft.client.gui.screens.Screen.class, "minecraft", mc);
			screen.init();
			detected.complete(new Ack("detect", true, null, discovery(claude)));
			screen.tick();
			click(screen, 350, 68); // Mixed team preset, disabled if Claude is unavailable.
			assertTrue(saves.isEmpty(), "A preset must not save settings");
			if (!claude) {
				click(screen, 220, 272);
				assertTrue(saves.isEmpty(), "Unavailable mixed team must not save");
				click(screen, 80, 68);
			}
			if (editWorker) {
				click(screen, 410, 138); // Worker's Choose button.
				var captured =
						org.mockito.ArgumentCaptor.forClass(net.minecraft.client.gui.screens.Screen.class);
				verify(gui).setScreen(captured.capture());
				var picker = captured.getValue();
				picker.width = 480;
				picker.height = 300;
				set(picker, net.minecraft.client.gui.screens.Screen.class, "minecraft", mc);
				var init = picker.getClass().getDeclaredMethod("init");
				init.setAccessible(true);
				init.invoke(picker);
				picker.mouseClicked(
						new MouseButtonEvent(320, 50, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0)),
						false); // Claude.
				picker.tick();
				picker.mouseClicked(
						new MouseButtonEvent(
								150, 224, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0)),
						false); // Default -> high.
				picker.tick();
				assertTrue(
						picker.getFocused() instanceof net.minecraft.client.gui.components.Button,
						"Reasoning has focus after rebuild: " + picker.getFocused());
				assertTrue(
						((net.minecraft.client.gui.components.Button) picker.getFocused())
								.getMessage()
								.getString()
								.startsWith("Reasoning"));
				picker.keyPressed(new net.minecraft.client.input.KeyEvent(InputConstants.KEY_TAB, 9, 0));
				assertEquals(
						"Use for worker",
						((net.minecraft.client.gui.components.Button) picker.getFocused())
								.getMessage()
								.getString());
				picker.keyPressed(
						new net.minecraft.client.input.KeyEvent(
								InputConstants.KEY_RETURN, 13, 0)); // Tab from reasoning must reach Use for worker.
				assertTrue(saves.isEmpty(), "Role picker must not persist the team");
				screen.init();
			}
			if (reset) click(screen, 100, 234); // Explicit reset toggle.
			click(screen, 220, 272); // Save team.
			assertEquals(1, saves.size());
			JsonObject payload = saves.getFirst();
			if (failure != 0) {
				Field status = TeamSetupScreen.class.getDeclaredField("status");
				status.setAccessible(true);
				assertFalse(((String) status.get(screen)).startsWith("Saved"));
				Field overrides = TeamSetupScreen.class.getDeclaredField("hasOverrides");
				overrides.setAccessible(true);
				assertTrue(overrides.getBoolean(screen));
				click(screen, 220, 272);
				assertEquals(2, saves.size());
				assertEquals(
						payload,
						saves.getLast(),
						"Retry must preserve the role draft and explicit reset choice");
				assertTrue(((String) status.get(screen)).startsWith("Saved"));
			}
			assertEquals(reset, payload.get("resetAgentOverrides").getAsBoolean());
			JsonObject roles = payload.getAsJsonObject("roles");
			assertEquals("codex", roles.getAsJsonObject("lead").get("provider").getAsString());
			assertEquals(
					editWorker ? "claude" : "codex",
					roles.getAsJsonObject("worker").get("provider").getAsString());
			assertEquals(
					claude ? "claude" : "codex",
					roles.getAsJsonObject("reviewer").get("provider").getAsString());
			assertEquals("high", roles.getAsJsonObject("worker").get("effort").getAsString());
		}
	}

	@Test
	void failedAcknowledgementPreservesDraftAndResetForRetry() throws Exception {
		scenario(true, true, false, 1);
	}

	@Test
	void failedConnectionPreservesDraftAndResetForRetry() throws Exception {
		scenario(true, true, false, 2);
	}

	@Test
	void rolePickerSelectsHarnessAndReasoningBeforeAtomicSave() throws Exception {
		scenario(true, false, true);
	}

	@Test
	void mixedPresetIsADraftUntilSaveAndPreservesOverrides() throws Exception {
		scenario(true, false);
	}

	@Test
	void resetRequiresAnExplicitToggle() throws Exception {
		scenario(true, true);
	}

	@Test
	void unavailableClaudeDisablesMixedPresetButAllCodexCanSave() throws Exception {
		scenario(false, false);
	}
}
