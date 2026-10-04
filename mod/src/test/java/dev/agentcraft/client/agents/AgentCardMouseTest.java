package dev.agentcraft.client.agents;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import java.lang.reflect.Field;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import org.junit.jupiter.api.Test;

/** Exercises the screen's actual mouse dispatch without a GPU or a running world. */
class AgentCardMouseTest {
	private static void set(Object target, Class<?> owner, String name, Object value) throws Exception {
		Field field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	private void clickAction(int index, int button, boolean model, boolean opens) throws Exception {
		Minecraft minecraft = mock(Minecraft.class);
		Gui gui = mock(Gui.class);
		set(minecraft, Minecraft.class, "gui", gui);
		ForemanState state = mock(ForemanState.class);
		when(state.agent("marlow")).thenReturn(mock(Agent.class));
		Screen console = mock(Screen.class);
		try (var minecraftStatic = mockStatic(Minecraft.class);
			 var foreman = mockStatic(Foreman.class);
			 var managers = mockStatic(AgentManager.class);
			 var bridge = mockStatic(DevBridge.class)) {
			minecraftStatic.when(Minecraft::getInstance).thenReturn(minecraft);
			foreman.when(Foreman::state).thenReturn(state);
			foreman.when(Foreman::connected).thenReturn(true);
			managers.when(AgentManager::get).thenReturn(mock(AgentManager.class));
			bridge.when(DevBridge::screens).thenReturn(Map.<String, java.util.function.Function<Minecraft, Screen>>of("console", ignored -> console));
			AgentCardScreen card = new AgentCardScreen("marlow");
			set(card, Screen.class, "minecraft", minecraft);
			Field buttons = AgentCardScreen.class.getDeclaredField("buttons");
			buttons.setAccessible(true);
			Object target = ((Object[]) buttons.get(card))[index];
			set(target, target.getClass(), "x", 100);
			set(target, target.getClass(), "y", 100);
			set(target, target.getClass(), "w", 60);
			var event = new MouseButtonEvent(120, 110, new MouseButtonInfo(button, 0));
			boolean handled = card.mouseClicked(event, false);
			assertEquals(opens, handled);
			if (!opens) verifyNoInteractions(gui);
			else if (model) verify(gui).setScreen(isA(AgentModelScreen.class));
			else verify(gui).setScreen(console);
		}
	}

	@Test void leftClickOpensModelSelector() throws Exception {
		clickAction(3, InputConstants.MOUSE_BUTTON_LEFT, true, true);
	}
	@Test void leftClickOpensMessageConsole() throws Exception {
		clickAction(0, InputConstants.MOUSE_BUTTON_LEFT, false, true);
	}
	@Test void rightClickDoesNotActivateModel() throws Exception {
		clickAction(3, InputConstants.MOUSE_BUTTON_RIGHT, true, false);
	}
}
