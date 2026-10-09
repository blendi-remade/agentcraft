package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.ClientEnv;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.dev.Fields;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import java.net.URI;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;

/**
 * Wires the Foreman link: creates the state model and the WebSocket client at startup, starts it
 * when the client has started, stops it on shutdown, and exposes it to the DevBridge
 * ({@code dev.state.foreman}, {@code dev.foreman}).
 *
 * <pre>
 * AGENTCRAFT_PORT     Foreman port (default 7878), always 127.0.0.1
 * AGENTCRAFT_FOREMAN  0 disables the link (the HUD then says so)
 * </pre>
 */
public final class ForemanFeature {
	private ForemanFeature() {
	}

	public static void init() {
		int port = ClientEnv.intValue("AGENTCRAFT_PORT", 7878);
		boolean enabled = ClientEnv.flag("AGENTCRAFT_FOREMAN", true);
		URI uri = URI.create("ws://127.0.0.1:" + port);
		String modVersion = FabricLoader.getInstance().getModContainer(AgentCraft.MOD_ID)
			.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("0");
		ForemanState state = new ForemanState(new LinkStatus(enabled ? LinkStatus.Phase.WAITING_RETRY : LinkStatus.Phase.DISABLED,
			uri.toString(), 0, null, System.currentTimeMillis(), System.currentTimeMillis(), false));
		// Executor: the client thread. Minecraft.getInstance() is resolved lazily (it does not exist yet during init).
		ForemanLink link = new ForemanLink(uri, modVersion, state, r -> Minecraft.getInstance().execute(r), enabled);
		Foreman.install(state, link);
		ClientLifecycleEvents.CLIENT_STARTED.register(mc -> link.start());
		ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> link.stop());

		DevBridge.addStateContributor((mc, o) -> o.add("foreman", stateJson()));
		DevBridge.register("dev.foreman", 10_000,
			"{reconnect?:false} -> foreman link status, backend/auth and counts; reconnect:true drops and reconnects now",
			(req, mc) -> {
				boolean reconnect = Fields.of(req).optBool("reconnect", false);
				if (reconnect) {
					link.reconnectNow();
				}
				return DevBridge.onClient(mc, ForemanFeature::stateJson);
			});
		if (ClientEnv.flag("AGENTCRAFT_DEV_TEST", false)) {
			// TEST ONLY: feed a Foreman message into the state model as if the Foreman sent it (UI states
			// that are hard to reach for real, e.g. a failed claude login banner).
			DevBridge.register("dev.test.foremanMessage", 5_000, "{message:{type, ...}} - TEST ONLY: apply as if received from the Foreman",
				(req, mc) -> {
					JsonObject msg = Fields.of(req).obj("message").json();
					String type = Fields.of(msg).nonBlank("type");
					return DevBridge.onClient(mc, () -> {
						JsonObject o = new JsonObject();
						o.addProperty("applied", Foreman.state().apply(type, msg));
						return o;
					});
				});
		}
		// Video choreography (always available): inject messages as if the Foreman sent them, hold the live stream.
		DevBridge.register("dev.foreman.inject", 5_000,
			"{message:{type,...}} | {patch:{agent|task:id, set:{field:value...}}} | {say:{agent, text, to?}} - apply to the mod's Foreman"
				+ " model as if received (bypasses the hold queue); patch copies the current agent/task and replaces a few wire fields",
			(req, mc) -> {
				Fields f = Fields.of(req);
				JsonObject msg = injectMessage(f);
				return DevBridge.onClient(mc, () -> applyInjected(msg));
			});
		DevBridge.register("dev.foreman.hold", 10_000,
			"{on:bool, release?:reconnect|replay|drop} - hold live Foreman messages (queued, not applied) so a shot shows only what it"
				+ " injects; on:false releases them: reconnect (default, fresh snapshot), replay (apply the queue) or drop",
			(req, mc) -> {
				Fields f = Fields.of(req);
				boolean on = f.bool("on");
				String release = f.optStr("release", "reconnect");
				if (!java.util.Set.of("reconnect", "replay", "drop").contains(release)) {
					throw new DevBridge.DevException("field 'release' must be reconnect|replay|drop (got '" + release + "')");
				}
				return DevBridge.onClient(mc, () -> {
					JsonObject o = new JsonObject();
					o.addProperty("wasHeld", state.isHeld());
					if (on) {
						state.setHold(true);
					} else if (state.isHeld()) {
						o.addProperty("released", state.releaseHold(release.equals("replay")));
						if (release.equals("reconnect")) {
							link.reconnectNow();
						}
					}
					o.addProperty("held", state.isHeld());
					o.addProperty("queued", state.heldCount());
					return o;
				});
			});
		DevBridge.register("dev.foreman.send", 25_000,
			"{message:{type, ...payload}} -> {ack:{re, ok, error?, result?}} - send a client message (docs/protocol.md Mod -> Foreman) through"
				+ " the mod's own link, e.g. {message:{type:'goal.submit', text:'...'}} or {message:{type:'decision.answer', decisionId:'d3', option:'Merge'}}",
			(req, mc) -> {
				Fields f = Fields.of(req);
				JsonObject msg = f.obj("message").json();
				Fields.of(msg).nonBlank("type");
				return DevBridge.onClient(mc, () -> link.send(msg.deepCopy())).thenCompose(fut -> fut).thenApply(ack -> {
					JsonObject o = new JsonObject();
					o.add("ack", ForemanJson.GSON.toJsonTree(ack));
					return o;
				});
			});
	}

	/**
	 * Validates an injection request ({@code message} | {@code patch} | {@code say}) and returns it as
	 * {@code {kind, ...}} for {@link #applyInjected}. Any thread.
	 */
	public static JsonObject injectMessage(Fields f) {
		int kinds = (f.has("message") ? 1 : 0) + (f.has("patch") ? 1 : 0) + (f.has("say") ? 1 : 0);
		if (kinds != 1) {
			throw new DevBridge.DevException("give exactly one of message | patch | say");
		}
		JsonObject out = new JsonObject();
		if (f.has("message")) {
			JsonObject msg = f.obj("message").json().deepCopy();
			Fields.of(msg).nonBlank("type");
			out.addProperty("kind", "message");
			out.add("message", msg);
		} else if (f.has("patch")) {
			Fields p = f.obj("patch");
			if (p.has("agent") == p.has("task")) {
				throw new DevBridge.DevException("field 'patch' needs exactly one of agent | task");
			}
			out.addProperty("kind", "patch");
			out.addProperty("of", p.has("agent") ? "agent" : "task");
			out.addProperty("id", p.has("agent") ? p.nonBlank("agent") : p.nonBlank("task"));
			out.add("set", p.obj("set").json().deepCopy());
		} else {
			Fields s = f.obj("say");
			JsonObject msg = new JsonObject();
			msg.addProperty("v", Protocol.VERSION);
			msg.addProperty("type", "agent.say");
			msg.addProperty("agentId", s.nonBlank("agent"));
			msg.addProperty("text", s.str("text"));
			String to = s.optStr("to", null);
			if (to != null) {
				msg.addProperty("to", to);
			}
			out.addProperty("kind", "message");
			out.add("message", msg);
		}
		return out;
	}

	/** Applies a validated injection (see {@link #injectMessage}). Client thread. */
	public static JsonObject applyInjected(JsonObject inj) {
		ForemanState st = Foreman.state();
		JsonObject o = new JsonObject();
		if (inj.get("kind").getAsString().equals("patch")) {
			try {
				JsonObject applied = st.patch(inj.get("of").getAsString(), inj.get("id").getAsString(), inj.getAsJsonObject("set"));
				o.addProperty("applied", true);
				o.add("message", applied);
			} catch (IllegalArgumentException e) {
				throw new DevBridge.DevException(e.getMessage());
			}
			return o;
		}
		JsonObject msg = inj.getAsJsonObject("message").deepCopy();
		String type = msg.get("type").getAsString();
		if (type.equals("agent.say") && !msg.has("ts")) {
			// the bubble is fresh: stamped now
			msg.addProperty("ts", System.currentTimeMillis());
		}
		o.addProperty("applied", st.inject(type, msg));
		o.add("message", msg);
		return o;
	}

	/** Compact JSON view of the link + model (for dev.state / dev.foreman). Client thread. */
	public static JsonObject stateJson() {
		ForemanState s = Foreman.state();
		LinkStatus l = s.link();
		JsonObject o = new JsonObject();
		o.addProperty("link", l.phaseName());
		o.addProperty("connected", l.synced());
		o.addProperty("url", l.url());
		o.addProperty("attempt", l.attempt());
		o.addProperty("lastError", l.lastError());
		o.addProperty("phaseForMs", System.currentTimeMillis() - l.sinceMs());
		o.addProperty("everSynced", l.everSynced());
		o.addProperty("snapshots", s.snapshotCount());
		o.addProperty("messages", Foreman.link().messageCount());
		o.addProperty("lastMessageAgoMs", s.lastMessageAt() == 0 ? -1 : System.currentTimeMillis() - s.lastMessageAt());
		o.addProperty("stale", s.isStale());
		o.addProperty("held", s.isHeld());
		o.addProperty("heldQueued", s.heldCount());
		ForemanStatus fs = s.status();
		o.addProperty("backend", fs == null ? null : fs.backend().wire());
		o.addProperty("auth", fs == null ? null : fs.auth().wire());
		o.addProperty("message", fs == null ? null : fs.message());
		o.addProperty("version", fs == null ? null : fs.version());
		o.addProperty("authMode", fs == null ? null : fs.authMode());
		o.addProperty("usage", UsageText.summary(s, UsageText.HEADER_WINDOWS));
		JsonObject counts = new JsonObject();
		counts.addProperty("agents", s.agents().size());
		counts.addProperty("activeAgents", s.agents().values().stream().filter(Protocol.Agent::isActive).count());
		counts.addProperty("tasks", s.tasks().size());
		int open = 0;
		for (Task t : s.tasks().values()) {
			if (t.status() != TaskStatus.DONE && t.status() != TaskStatus.CANCELLED) {
				open++;
			}
		}
		counts.addProperty("openTasks", open);
		counts.addProperty("decisions", s.decisions().size());
		counts.addProperty("openDecisions", s.openDecisions().size());
		counts.addProperty("repos", s.repos().size());
		counts.addProperty("memory", s.memory().size());
		counts.addProperty("goals", s.goals().size());
		counts.addProperty("feed", s.feed().size());
		o.add("counts", counts);
		Goal g = s.goal();
		if (g != null) {
			JsonObject go = new JsonObject();
			go.addProperty("id", g.id());
			go.addProperty("text", g.text());
			go.addProperty("progress", g.progress());
			go.addProperty("status", g.status().wire());
			o.add("goal", go);
		}
		Decision first = s.openDecisions().isEmpty() ? null : s.openDecisions().getFirst();
		o.addProperty("oldestOpenDecision", first == null ? null : first.id());
		return o;
	}
}
