package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.LinkStatus.Phase;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.network.ForemanPayloads;
import dev.agentcraft.network.ForemanPayloads.Control;
import dev.agentcraft.network.ForemanPayloads.Data;
import dev.agentcraft.network.ForemanPayloads.Link;
import dev.agentcraft.network.ForemanPayloads.Layout;
import dev.agentcraft.network.ForemanPayloads.Request;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;

/** Client side of the in-game relay. Foreman protocol JSON remains unchanged over the play channel. */
public final class ForemanRelayClient {
	private static final int MAX_TRANSFER_CHARS = 4 * 1024 * 1024;
	private static final int MAX_ASSEMBLIES = 16;
	private static final int MAX_PARTS = 270;
	private static final long EXPIRE_MS = 30_000;
	private static volatile ForemanLink link;
	private static boolean initialized;
	private static final Map<String, Assembly> assemblies = new HashMap<>();

	private static final class Assembly {
		final String[] parts;
		final long createdAt = System.currentTimeMillis();
		int received;
		int chars;
		int bytes;

		Assembly(int count) {
			parts = new String[count];
		}
	}

	private ForemanRelayClient() {
	}

	public static synchronized void init(ForemanLink foremanLink) {
		link = foremanLink;
		if (initialized) {
			return;
		}
		initialized = true;
		ClientPlayNetworking.registerGlobalReceiver(Data.TYPE, (payload, context) -> context.client().execute(() -> accept(payload)));
		ClientPlayNetworking.registerGlobalReceiver(Link.TYPE, (payload, context) -> context.client().execute(() -> accept(payload)));
		ClientPlayNetworking.registerGlobalReceiver(Layout.TYPE, (payload, context) -> context.client().execute(() -> accept(payload)));
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> client.execute(() -> {
			if (!ClientPlayNetworking.canSend(Request.TYPE)) {
				ForemanLink current = link;
				if (current != null) {
					current.updateRelayStatus(new LinkStatus(Phase.WAITING_RETRY, current.uri().toString(), 0,
						"This Minecraft server does not have the AgentCraft server relay installed.", System.currentTimeMillis(), 0, false));
				}
			}
		}));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
			synchronized (assemblies) {
				assemblies.clear();
			}
			try {
				Anchors.receiveServerLayout(Anchors.toJson(Anchors.Layout.EMPTY));
			} catch (RuntimeException e) {
				AgentCraft.LOGGER.debug("Could not clear the remote studio layout after disconnect", e);
			}
			ForemanLink current = link;
			if (current != null) {
				current.updateRelayStatus(new LinkStatus(Phase.WAITING_RETRY, current.uri().toString(), 0,
					"Minecraft connection closed", System.currentTimeMillis(), 0, false));
			}
		});
	}

	public static void send(JsonObject message) {
		String json = ForemanJson.GSON.toJson(message);
		if (json.length() > ForemanPayloads.MAX_REQUEST_CHARS) {
			throw new IllegalArgumentException("Foreman request exceeds the Minecraft relay packet limit");
		}
		if (!ClientPlayNetworking.canSend(Request.TYPE)) {
			throw new IllegalStateException("The connected server does not have AgentCraft's multiplayer relay");
		}
		ClientPlayNetworking.send(new Request(json));
	}

	public static void reconnect() {
		if (ClientPlayNetworking.canSend(Control.TYPE)) {
			ClientPlayNetworking.send(new Control("reconnect"));
		}
	}

	private static void accept(Link payload) {
		ForemanLink current = link;
		if (current == null) {
			return;
		}
		Phase phase;
		try {
			phase = Phase.valueOf(payload.phase().toUpperCase(java.util.Locale.ROOT));
		} catch (IllegalArgumentException e) {
			phase = Phase.WAITING_RETRY;
		}
		String error = payload.error().isBlank() ? null : payload.error();
		current.updateRelayStatus(new LinkStatus(phase, current.uri().toString(), payload.attempt(), error, payload.sinceMs(),
			payload.nextRetryAtMs(), payload.everSynced()));
	}

	private static void accept(Layout payload) {
		try {
			var json = JsonParser.parseString(payload.json());
			if (json.isJsonObject()) {
				Anchors.receiveServerLayout(json.getAsJsonObject());
			}
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.warn("Could not apply the server's AgentCraft layout packet", e);
		}
	}

	private static void accept(Data packet) {
		ForemanLink current = link;
		if (current == null || packet.count() < 1 || packet.count() > MAX_PARTS || packet.index() < 0 || packet.index() >= packet.count()) {
			return;
		}
		String complete = null;
		synchronized (assemblies) {
			expireOld();
			if (!assemblies.containsKey(packet.transferId()) && assemblies.size() >= MAX_ASSEMBLIES) {
				return;
			}
			Assembly assembly = assemblies.computeIfAbsent(packet.transferId(), ignored -> new Assembly(packet.count()));
			if (assembly.parts.length != packet.count() || assembly.parts[packet.index()] != null) {
				assemblies.remove(packet.transferId());
				return;
			}
			assembly.parts[packet.index()] = packet.jsonFragment();
			assembly.received++;
			assembly.chars += packet.jsonFragment().length();
			assembly.bytes += packet.jsonFragment().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
			if (assembly.chars > MAX_TRANSFER_CHARS || assembly.bytes > MAX_TRANSFER_CHARS) {
				assemblies.remove(packet.transferId());
				return;
			}
			if (assembly.received == assembly.parts.length) {
				StringBuilder out = new StringBuilder(assembly.chars);
				for (String part : assembly.parts) {
					if (part == null) {
						assemblies.remove(packet.transferId());
						return;
					}
					out.append(part);
				}
				complete = out.toString();
				assemblies.remove(packet.transferId());
			}
		}
		if (complete != null) {
			current.receiveRelayed(complete);
		}
	}

	private static void expireOld() {
		long now = System.currentTimeMillis();
		Iterator<Assembly> values = assemblies.values().iterator();
		while (values.hasNext()) {
			if (now - values.next().createdAt > EXPIRE_MS) {
				values.remove();
			}
		}
	}
}
