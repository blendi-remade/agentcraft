package dev.agentcraft.client.ui;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;

/**
 * Base of the mod's screens: the one place that decides which mouse clicks a screen sees. Only the
 * left button reaches {@link #leftClicked}, like vanilla widgets; every other click (and a left click
 * the screen did not handle) goes on to vanilla, so focused widgets such as an {@code EditBox} still
 * get it.
 *
 * <p>26.x reports SDL button numbers: left is {@link InputConstants#MOUSE_BUTTON_LEFT} (1), not
 * GLFW's 0. Screens that compared {@code button() == 0} themselves ignored every click.
 */
public abstract class ModScreen extends Screen {
	protected ModScreen(Component title) {
		super(title);
	}

	@Override
	public final boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		if (e.button() == InputConstants.MOUSE_BUTTON_LEFT && leftClicked(e, doubleClick)) {
			return true;
		}
		return super.mouseClicked(e, doubleClick);
	}

	/** A left click at {@code e.x(), e.y()} (GUI coordinates); true when the screen handled it. */
	protected boolean leftClicked(MouseButtonEvent e, boolean doubleClick) {
		return false;
	}
}
