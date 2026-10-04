package dev.agentcraft.client;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.setup.SetupFeature;
import dev.agentcraft.client.agents.AgentsFeature;
import dev.agentcraft.client.console.ConsoleFeature;
import dev.agentcraft.client.decisions.DecisionsFeature;
import dev.agentcraft.client.diff.DiffFeature;
import dev.agentcraft.client.foreman.ForemanFeature;
import dev.agentcraft.client.hq.HqClientFeature;
import dev.agentcraft.client.hud.HudFeature;
import dev.agentcraft.client.library.LibraryFeature;
import dev.agentcraft.client.monitor.MonitorFeature;
import dev.agentcraft.client.permissions.PermissionsFeature;
import dev.agentcraft.client.taskwall.TaskWallFeature;
import dev.agentcraft.client.world.AnchorsDev;
import dev.agentcraft.client.world.ItemsDev;

/**
 * The one place that wires every client feature. Each feature lives in its own package with an
 * {@code init()} that registers everything it needs (renderers, HUD elements, screens, keybinds,
 * DevBridge commands, Foreman listeners), so a feature specialist only edits their own package.
 * Order matters only for {@link ForemanFeature} (first: everything else may read the state model).
 * See mod/FEATURES.md.
 */
public final class ClientFeatures {
	private ClientFeatures() {
	}

	public static void init() {
		ForemanFeature.init();   // link + state model (dev.foreman, dev.state.foreman)
		SetupFeature.init();     // detected harnesses and owner team setup
		AnchorsDev.init();       // dev.anchors, dev.camera {anchor}
		ItemsDev.init();         // dev.screen creative_agentcraft
		AgentsFeature.init();    // agent NPCs, nameplates, dev.agents
		HudFeature.init();       // connection banner (+ Phase 3: goal boss bar, toasts)
		HqClientFeature.init();  // lamps / podium / atrium driven by state (Phase 3)
		MonitorFeature.init();
		TaskWallFeature.init();
		DecisionsFeature.init();
		ConsoleFeature.init();
		DiffFeature.init();
		LibraryFeature.init();
		PermissionsFeature.init();
		AgentCraft.LOGGER.info("AgentCraft client features initialised");
	}
}
