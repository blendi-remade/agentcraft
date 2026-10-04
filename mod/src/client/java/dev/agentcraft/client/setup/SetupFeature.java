package dev.agentcraft.client.setup;

import com.google.gson.JsonObject;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.BackendName;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;

/**
* First connection offers setup after discovery; observers and legacy servers never get a popup.
*/
public final class SetupFeature {
	private static boolean checked, pending;
	private static long generation;

	private SetupFeature() {}

	public static void init() {
		DevBridge.registerScreen("setup", mc -> new TeamSetupScreen(mc.gui.screen()));
		ClientTickEvents.END_CLIENT_TICK.register(SetupFeature::tick);
	}

	static void tick(Minecraft mc) {
		if (mc.level == null || !Foreman.connected()) {
			if (checked || pending) {
				generation++;
				checked = false;
				pending = false;
			}
			return;
		}
		if (!checked) {
			if (Foreman.state().status() == null) return;
			checked = true;
			if (Foreman.state().status().backend() == BackendName.SIM) return;
			long requestGeneration = generation;
			Foreman.send("harness.detect", new JsonObject())
					.whenComplete(
							(ack, error) -> {
								if (requestGeneration != generation
										|| error != null
										|| ack == null
										|| !ack.ok()
										|| ack.result() == null) return;
								JsonObject result = ack.result();
								pending =
										result.has("canConfigure")
												&& result.get("canConfigure").getAsBoolean()
												&& result.has("setupComplete")
												&& !result.get("setupComplete").getAsBoolean();
							});
		}
		if (pending && mc.gui.screen() instanceof TeamSetupScreen) pending = false;
		if (pending && mc.gui.screen() == null && mc.gui.overlay() == null) {
			pending = false;
			mc.gui.setScreen(new TeamSetupScreen(null));
		}
	}
}
