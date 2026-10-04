package dev.agentcraft.server;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.ForemanJson;
import dev.agentcraft.client.foreman.LinkStatus;
import dev.agentcraft.client.foreman.LinkStatus.Phase;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.network.ForemanPayloads;
import dev.agentcraft.network.ForemanPayloads.Control;
import dev.agentcraft.network.ForemanPayloads.Data;
import dev.agentcraft.network.ForemanPayloads.Link;
import dev.agentcraft.network.ForemanPayloads.Layout;
import dev.agentcraft.network.ForemanPayloads.Request;
import dev.agentcraft.security.OwnerAccess;
import dev.agentcraft.layout.Anchors;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * One server-owned connection to Foreman's loopback WebSocket. Play-channel packets bind every
 * request to the authenticated Minecraft UUID; response IDs are namespaced and routed back to the
 * requester, while snapshots and state updates are shared with connected AgentCraft clients.
 */
public final class ServerForemanRelay {
	public static final int ACK_TIMEOUT_MS = 20_000;
	private static final long[] BACKOFF_MS = {250, 500, 1000, 2000, 3000, 5000};
	private static final long SILENCE_MS = 45_000;
	private static final long HANDSHAKE_MS = 15_000;
	private static final long PING_MS = 15_000;
	private final dev.agentcraft.network.SnapshotTransfer snapshots = new dev.agentcraft.network.SnapshotTransfer();
	private static final int MAX_JSON_CHARS = 4 * 1024 * 1024;
	private static final int MAX_JSON_BYTES = 4 * 1024 * 1024;
	private static final int MAX_PENDING = 512;
	private static final int MAX_REQUESTS_PER_SECOND = 24;
	private static final ForemanState EMPTY_STATE = new ForemanState(new LinkStatus(Phase.DISABLED, "server relay", 0, null,
		System.currentTimeMillis(), 0, false));
	private static volatile @Nullable ServerForemanRelay instance;

	private final MinecraftServer server;
	private final URI uri;
	private final boolean enabled;
	private final ForemanState state;
	private final ScheduledExecutorService sched;
	private final ExecutorService io;
	private final HttpClient http;
	private final AtomicLong ids = new AtomicLong();
	private final AtomicLong transferIds = new AtomicLong();
	private final Map<String, Route> ackRoutes = new ConcurrentHashMap<>();
	private final Map<String, DiffRoute> diffRoutes = new ConcurrentHashMap<>();
	private final Map<UUID, RateWindow> rateWindows = new ConcurrentHashMap<>();
	private final Object sendLock = new Object();
	private volatile @Nullable WebSocket ws;
	private volatile boolean running;
	private volatile LinkStatus status;
	private volatile @Nullable JsonObject latestSnapshot;
	private volatile long lastInbound;
	private volatile long lastPing;
	private volatile int attempt;
	private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);

	private record Route(UUID playerId, String clientId, boolean notifyChat) {
	}

	private record DiffRoute(UUID playerId, String clientRequestId) {
	}

	private static final class RateWindow {
		long startedAt;
		int count;
	}

	private ServerForemanRelay(MinecraftServer server) {
		this.server = server;
		this.uri = URI.create("ws://127.0.0.1:" + configuredPort());
		this.enabled = enabled();
		this.status = new LinkStatus(enabled ? Phase.WAITING_RETRY : Phase.DISABLED, uri.toString(), 0, null,
			System.currentTimeMillis(), System.currentTimeMillis(), false);
		this.state = new ForemanState(status);
		this.sched = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "AgentCraft-Server-Foreman"));
		this.io = Executors.newCachedThreadPool(r -> daemon(r, "AgentCraft-Server-Foreman-io"));
		this.http = HttpClient.newBuilder().executor(io).connectTimeout(Duration.ofSeconds(3)).build();
	}

	private static Thread daemon(Runnable runnable, String name) {
		Thread thread = new Thread(runnable, name);
		thread.setDaemon(true);
		return thread;
	}

	/** Registers packet types and server lifecycle hooks from the common mod entrypoint. */
	public static void init() {
		ForemanPayloads.register();
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			ServerForemanRelay relay = new ServerForemanRelay(server);
			instance = relay;
			relay.start();
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			ServerForemanRelay relay = instance;
			if (relay != null && relay.server == server) {
				relay.stop();
				instance = null;
			}
		});
		Anchors.addListener(layout -> {
			ServerForemanRelay relay = instance;
			if (relay != null) {
				relay.broadcastLayout(layout);
			}
		});
		ServerPlayNetworking.registerGlobalReceiver(Request.TYPE, (payload, context) -> context.server().execute(() -> {
			ServerForemanRelay relay = instance;
			if (relay != null && relay.server == context.server()) {
				relay.receiveRequest(context.player(), payload.json());
			}
		}));
		ServerPlayNetworking.registerGlobalReceiver(Control.TYPE, (payload, context) -> context.server().execute(() -> {
			ServerForemanRelay relay = instance;
			if (relay != null && relay.server == context.server()) {
				relay.receiveControl(context.player(), payload.action());
			}
		}));
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> server.execute(() -> {
			ServerForemanRelay relay = instance;
			if (relay != null && relay.server == server) {
				ServerPlayer joining = handler.getPlayer();
				if (!ServerPlayNetworking.canSend(joining, Data.TYPE)) {
					return; // vanilla clients can use server commands, but have no GUI state channel
				}
				relay.sendLink(joining);
				relay.sendLayout(joining);
				JsonObject snapshot = relay.latestSnapshot;
				if (snapshot != null) {
					relay.sendData(joining, snapshot.toString());
				}
				// A cached snapshot is only a fast first paint. Ask the already-authorized server
				// connection for current state so a reconnect cannot miss later upserts and feed items.
				relay.refreshSnapshot();
			}
		}));
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			ServerForemanRelay relay = instance;
			if (relay != null && relay.server == server) {
				relay.forget(handler.getPlayer().getUUID());
			}
		});
		ServerMessageEvents.ALLOW_CHAT_MESSAGE.register((message, player, bound) -> {
			String text = message.signedContent();
			String trimmed = text.stripLeading();
			if (trimmed.equalsIgnoreCase("@codex") || trimmed.regionMatches(true, 0, "@codex ", 0, 7)) {
				ServerForemanRelay relay = instance;
				if (relay != null) {
					relay.handleCodexChat(player, trimmed);
				} else {
					player.sendSystemMessage(Component.literal("AgentCraft's server relay is not running."));
				}
				return false;
			}
			return true;
		});
	}

	/** Server-side state snapshot consumed by the authoritative HQ block driver. */
	public static ForemanState state() {
		ServerForemanRelay relay = instance;
		return relay == null ? EMPTY_STATE : relay.state;
	}

	public static boolean connected() {
		ServerForemanRelay relay = instance;
		return relay != null && relay.status.synced();
	}

	public static String statusLine() {
		ServerForemanRelay relay = instance;
		if (relay == null) {
			return "AgentCraft server relay is not running.";
		}
		LinkStatus link = relay.status;
		if (!link.synced()) {
			return "Foreman relay " + link.phaseName() + (link.lastError() == null ? "" : ": " + link.lastError());
		}
		ForemanState state = relay.state;
		var backend = state.status();
		long open = state.tasks().values().stream().filter(t -> t.status() != Protocol.TaskStatus.DONE && t.status() != Protocol.TaskStatus.CANCELLED).count();
		return "Foreman connected" + (backend == null ? "" : " · " + backend.backend().wire() + " / auth " + backend.auth().wire())
			+ " · " + state.agents().size() + " agents · " + open + " open tasks";
	}

	public static boolean isOwner(ServerPlayer player) {
		return OwnerAccess.isOwner(player);
	}

	/** Sends a command-originated Foreman intent; command handlers perform owner gating first. */
	public static boolean sendFromCommand(ServerPlayer player, JsonObject message) {
		ServerForemanRelay relay = instance;
		if (relay == null) {
			player.sendSystemMessage(Component.literal("AgentCraft's server relay is not running."));
			return false;
		}
		relay.accept(player, message, true);
		return true;
	}

	public static void reconnectFromCommand(ServerPlayer player) {
		if (!OwnerAccess.isOwner(player)) {
			player.sendSystemMessage(Component.literal("Only the configured server owner can reconnect Foreman."));
			return;
		}
		ServerForemanRelay relay = instance;
		if (relay == null) {
			player.sendSystemMessage(Component.literal("AgentCraft's server relay is not running."));
			return;
		}
		relay.reconnectNow();
		player.sendSystemMessage(Component.literal("Reconnecting the server's loopback Foreman link."));
	}

	private static boolean enabled() {
		String value = System.getProperty("agentcraft.foreman.enabled");
		if (value == null) {
			value = System.getenv("AGENTCRAFT_FOREMAN");
		}
		return value == null || !(value.trim().equals("0") || value.trim().equalsIgnoreCase("false") || value.trim().equalsIgnoreCase("off"));
	}

	private static int configuredPort() {
		String value = System.getProperty("agentcraft.foreman.port");
		if (value == null || value.isBlank()) {
			value = System.getenv("AGENTCRAFT_PORT");
		}
		if (value == null || value.isBlank()) {
			return 7878;
		}
		try {
			int port = Integer.parseInt(value.trim());
			if (port < 1 || port > 65535) {
				throw new NumberFormatException("outside 1..65535");
			}
			return port;
		} catch (NumberFormatException e) {
			AgentCraft.LOGGER.warn("Invalid agentcraft.foreman.port '{}'; using 7878", value);
			return 7878;
		}
	}

	private void start() {
		if (!enabled) {
			publish(status);
			AgentCraft.LOGGER.info("Server Foreman relay disabled by AGENTCRAFT_FOREMAN=0");
			return;
		}
		running = true;
		sched.execute(this::connect);
		sched.scheduleAtFixedRate(this::watchdog, 5, 5, TimeUnit.SECONDS);
		AgentCraft.LOGGER.info("Server Foreman relay started at loopback {}", uri);
	}

	private synchronized void stop() {
		snapshots.clear();
		running = false;
		WebSocket socket = ws;
		ws = null;
		if (socket != null) {
			socket.sendClose(WebSocket.NORMAL_CLOSURE, "server stopping").exceptionally(t -> null);
			socket.abort();
		}
		failRoutes("Minecraft server stopping");
		sched.shutdownNow();
		io.shutdownNow();
	}

	private void reconnectNow() {
		if (!enabled) {
			return;
		}
		sched.execute(() -> {
			WebSocket socket = ws;
			if (socket != null) {
				socket.abort();
			}
			fail(generation, "reconnect requested", 0);
		});
	}

	private volatile int generation;

	private void connect() {
		if (!running) {
			return;
		}
		int gen = ++generation;
		attempt++;
		publish(status.with(Phase.CONNECTING, status.lastError(), 0).attempt(attempt));
		try {
			http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(3)).buildAsync(uri, new Listener(gen)).whenComplete((socket, error) -> {
				if (error != null) {
					fail(gen, describe(error), -1);
					return;
				}
				if (gen != generation || !running) {
					socket.abort();
					return;
				}
				ws = socket;
				lastInbound = System.currentTimeMillis();
				lastPing = lastInbound;
				publish(status.with(Phase.HANDSHAKE, null, 0));
				sendRaw(socket, helloMessage().toString());
			});
		} catch (Throwable t) {
			fail(gen, describe(t), -1);
		}
	}

	private JsonObject helloMessage() {
		JsonObject hello = new JsonObject();
		hello.addProperty("v", Protocol.VERSION);
		hello.addProperty("type", "hello");
		hello.addProperty("modVersion", FabricLoader.getInstance().getModContainer(AgentCraft.MOD_ID)
			.map(container -> container.getMetadata().getVersion().getFriendlyString()).orElse("0"));
		hello.addProperty("protocol", Protocol.VERSION);
		hello.addProperty("snapshotParts", true);
		hello.addProperty("client", "mod-server-relay");
		return hello;
	}

	/** Ask the loopback Foreman for a current read-only snapshot on its existing server-owned socket. */
	private void refreshSnapshot() {
		WebSocket socket = ws;
		if (socket == null || !status.synced()) {
			return; // initial/reconnecting hello already has a snapshot in flight
		}
		sendRaw(socket, helloMessage().toString()).exceptionally(error -> {
			AgentCraft.LOGGER.warn("Could not request a fresh Foreman snapshot after player join", error);
			return null;
		});
	}

	private void fail(int gen, String reason, long overrideDelay) {
		if (gen != generation) {
			return;
		}
		generation++;
		snapshots.clear();
		WebSocket socket = ws;
		ws = null;
		if (socket != null) {
			socket.abort();
		}
		failRoutes("Foreman connection lost: " + reason);
		if (!running) {
			return;
		}
		boolean wasSynced = status.synced();
		if (wasSynced) {
			attempt = 0;
			AgentCraft.LOGGER.warn("Server Foreman link lost: {}", reason);
		}
		long delay = overrideDelay >= 0 ? overrideDelay : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
		publish(status.with(Phase.WAITING_RETRY, reason, System.currentTimeMillis() + delay));
		try {
			sched.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
		} catch (Throwable ignored) {
			// server is stopping
		}
	}

	private void watchdog() {
		WebSocket socket = ws;
		if (socket == null) {
			return;
		}
		long now = System.currentTimeMillis();
		if (status.phase() == Phase.HANDSHAKE && now - status.sinceMs() > HANDSHAKE_MS) {
			fail(generation, "no snapshot within " + HANDSHAKE_MS / 1000 + " s", -1);
		} else if (now - lastInbound > SILENCE_MS) {
			fail(generation, "no data for " + SILENCE_MS / 1000 + " s", -1);
		} else if (now - lastPing >= PING_MS) {
			lastPing = now;
			synchronized (sendLock) {
				sendChain = sendChain.handle((v, e) -> null).thenCompose(v -> socket.sendPing(ByteBuffer.allocate(0))).exceptionally(t -> null);
			}
		}
	}

	private void publish(LinkStatus next) {
		status = next;
		try {
			server.execute(() -> {
				if (instance != this) {
					return;
				}
				state.setLink(next);
				for (ServerPlayer player : server.getPlayerList().getPlayers()) {
					sendLink(player);
				}
			});
		} catch (RuntimeException e) {
			if (running) {
				AgentCraft.LOGGER.debug("Could not publish Foreman relay status", e);
			}
		}
	}

	private void sendLink(ServerPlayer player) {
		if (!ServerPlayNetworking.canSend(player, Link.TYPE)) {
			return;
		}
		LinkStatus s = status;
		ServerPlayNetworking.send(player, new Link(s.phaseName(), s.lastError() == null ? "" : truncate(s.lastError(), 240), s.attempt(), s.sinceMs(),
			s.nextRetryAtMs(), s.everSynced()));
	}

	private void sendLayout(ServerPlayer player) {
		if (ServerPlayNetworking.canSend(player, Layout.TYPE)) {
			String json = ForemanJson.GSON.toJson(Anchors.toJson(Anchors.current()));
			ServerPlayNetworking.send(player, new Layout(json));
		}
	}

	private void broadcastLayout(Anchors.Layout layout) {
		String json = ForemanJson.GSON.toJson(Anchors.toJson(layout));
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (ServerPlayNetworking.canSend(player, Layout.TYPE)) {
				ServerPlayNetworking.send(player, new Layout(json));
			}
		}
	}

	private void handleCodexChat(ServerPlayer player, String text) {
		String body = text.length() <= 6 ? "" : text.substring(6).trim();
		if (!OwnerAccess.isOwner(player)) {
			String request = body.isBlank() ? "(empty @codex message)" : truncate(body, 1000);
			ServerPlayer owner = OwnerAccess.ownerUuid(server).map(server.getPlayerList()::getPlayer).orElse(null);
			if (owner != null) {
				owner.sendSystemMessage(Component.literal("[Guest request; not forwarded to host Codex] " + player.getName().getString() + ": " + request));
				player.sendSystemMessage(Component.literal("Your request was shown to the server owner. The host Codex did not receive it."));
			} else {
				player.sendSystemMessage(Component.literal("Only the configured server owner may address host Codex, and the owner is offline. Your message was not forwarded."));
			}
			return;
		}
		if (body.isBlank() || body.length() > 1000) {
			player.sendSystemMessage(Component.literal("Use @codex followed by a message of 1–1000 characters."));
			return;
		}
		if (!status.synced()) {
			player.sendSystemMessage(Component.literal("Foreman is not connected through the server yet. Try /agentcraft status."));
			return;
		}
		JsonObject request = new JsonObject();
		request.addProperty("v", Protocol.VERSION);
		request.addProperty("type", "user.message");
		request.addProperty("to", "all");
		request.addProperty("text", body);
		accept(player, request, true);
		player.sendSystemMessage(Component.literal("Sent your message to Codex and the AgentCraft team."));
	}

	private void receiveControl(ServerPlayer player, String action) {
		if (!OwnerAccess.isOwner(player)) {
			player.sendSystemMessage(Component.literal("Only the configured server owner may control the host Foreman connection."));
			return;
		}
		if (action.equals("reconnect")) {
			reconnectNow();
			player.sendSystemMessage(Component.literal("Reconnecting the server's loopback Foreman link."));
		} else {
			player.sendSystemMessage(Component.literal("Unknown AgentCraft control action."));
		}
	}

	private void receiveRequest(ServerPlayer player, String text) {
		if (text.length() > ForemanPayloads.MAX_REQUEST_CHARS) {
			syntheticAck(player, "", "Request is too large.");
			return;
		}
		if (!rateLimited(player.getUUID())) {
			syntheticAck(player, "", "Please slow down your AgentCraft requests.");
			return;
		}
		try {
			JsonElement parsed = JsonParser.parseString(text);
			if (!parsed.isJsonObject()) {
				syntheticAck(player, "", "Request must be a JSON object.");
				return;
			}
			accept(player, parsed.getAsJsonObject(), false);
		} catch (RuntimeException e) {
			syntheticAck(player, "", "Request JSON could not be parsed.");
		}
	}

	private boolean rateLimited(UUID playerId) {
		long now = System.currentTimeMillis();
		RateWindow window = rateWindows.computeIfAbsent(playerId, ignored -> new RateWindow());
		synchronized (window) {
			if (now - window.startedAt >= 1000) {
				window.startedAt = now;
				window.count = 0;
			}
			return ++window.count <= MAX_REQUESTS_PER_SECOND;
		}
	}

	private void accept(ServerPlayer player, JsonObject original, boolean notifyChat) {
		JsonObject message = original.deepCopy();
		String type = string(message, "type");
		String clientId = string(message, "id");
		if (clientId.isBlank()) {
			clientId = "mc-client-" + ids.incrementAndGet();
		}
		if (clientId.length() > 128) {
			syntheticAck(player, clientId.substring(0, 128), "Request id is too long.");
			return;
		}
		if (type.isBlank() || type.equals("hello")) {
			syntheticAck(player, clientId, "Invalid Foreman request type.");
			return;
		}
		if (!OwnerAccess.isOwner(player)) {
			syntheticAck(player, clientId, "Only the configured server owner can send work, agent, repository, file, permission, or merge actions. You can still observe the shared studio and use Minecraft chat.");
			return;
		}
		if (ackRoutes.size() >= MAX_PENDING) {
			syntheticAck(player, clientId, "The server relay already has too many requests in flight.");
			return;
		}
		if (!status.synced() || ws == null) {
			syntheticAck(player, clientId, "Foreman is not connected through the server yet.");
			return;
		}
		String serverId = "acs-" + Long.toString(ids.incrementAndGet(), 36);
		message.addProperty("v", Protocol.VERSION);
		message.addProperty("id", serverId);
		String originalDiffRequestId = null;
		String serverDiffRequestId = null;
		if (type.equals("diff.request")) {
			originalDiffRequestId = string(message, "requestId");
			if (originalDiffRequestId.isBlank()) {
				originalDiffRequestId = "mc-diff-" + ids.incrementAndGet();
			}
			serverDiffRequestId = "acd-" + Long.toString(ids.incrementAndGet(), 36);
			message.addProperty("requestId", serverDiffRequestId);
			diffRoutes.put(serverDiffRequestId, new DiffRoute(player.getUUID(), originalDiffRequestId));
		}
		ackRoutes.put(serverId, new Route(player.getUUID(), clientId, notifyChat));
		String routedDiffId = serverDiffRequestId;
		String timeoutMessage = originalDiffRequestId != null ? "The diff request timed out." : "The Foreman request timed out.";
		sched.schedule(() -> {
			if (routedDiffId != null) {
				diffRoutes.remove(routedDiffId);
			}
			Route route = ackRoutes.remove(serverId);
			if (route != null) {
				server.execute(() -> sendSyntheticAck(route, timeoutMessage));
			}
		}, ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
		WebSocket socket = ws;
		if (socket == null) {
			Route route = ackRoutes.remove(serverId);
			if (route != null) {
				sendSyntheticAck(route, "Foreman is not connected through the server yet.");
			}
			return;
		}
		sendRaw(socket, message.toString()).whenComplete((ignored, error) -> {
			if (error != null) {
				server.execute(() -> {
					Route route = ackRoutes.remove(serverId);
					if (routedDiffId != null) {
						diffRoutes.remove(routedDiffId);
					}
					if (route != null) {
						sendSyntheticAck(route, "Could not send the request to the loopback Foreman." );
					}
				});
			}
		});
	}

	private void syntheticAck(ServerPlayer player, String id, String error) {
		JsonObject ack = new JsonObject();
		ack.addProperty("v", Protocol.VERSION);
		ack.addProperty("type", "ack");
		ack.addProperty("re", id);
		ack.addProperty("ok", false);
		ack.addProperty("error", truncate(error, 240));
		sendData(player, ack.toString());
		if (id.isBlank()) {
			player.sendSystemMessage(Component.literal(error));
		}
	}

	private void sendSyntheticAck(Route route, String error) {
		ServerPlayer player = server.getPlayerList().getPlayer(route.playerId());
		if (player == null) {
			return;
		}
		syntheticAck(player, route.clientId(), error);
	}

	private void handle(JsonObject message) {
		String type = string(message, "type");
		switch (type) {
			case "ack" -> {
				String serverId = string(message, "re");
				Route route = ackRoutes.remove(serverId);
				if (route == null) {
					return;
				}
				message.addProperty("re", route.clientId());
				sendData(route.playerId(), message.toString());
				if (route.notifyChat()) {
					ServerPlayer player = server.getPlayerList().getPlayer(route.playerId());
					if (player != null) {
						boolean ok = message.has("ok") && message.get("ok").getAsBoolean();
						player.sendSystemMessage(Component.literal(ok ? "Foreman accepted the request." : "Foreman declined the request: "
							+ string(message, "error")));
					}
				}
			}
			case "diff" -> {
				String serverRequestId = string(message, "requestId");
				DiffRoute route = diffRoutes.remove(serverRequestId);
				if (route == null) {
					return;
				}
				message.addProperty("requestId", route.clientRequestId());
				sendData(route.playerId(), message.toString());
			}
			case "error" -> {
				String serverId = string(message, "re");
				if (!serverId.isBlank()) {
					Route route = ackRoutes.get(serverId);
					if (route != null) {
						message.addProperty("re", route.clientId());
						sendData(route.playerId(), message.toString());
						return;
					}
				}
				broadcastData(message.toString());
			}
			default -> {
				if (type.equals("snapshot")) {
					latestSnapshot = message.deepCopy();
				}
				state.receive(type, message);
				broadcastData(message.toString());
				if (type.equals("agent.say")) {
					broadcastAgentReply(message);
				}
				if (type.equals("snapshot")) {
					attempt = 0;
					publish(status.with(Phase.SYNCED, null, 0));
					AgentCraft.LOGGER.info("Server Foreman relay synced ({})", uri);
				}
			}
		}
	}

	private void broadcastAgentReply(JsonObject message) {
		String recipient = string(message, "to");
		if (!recipient.isBlank() && !recipient.equalsIgnoreCase("user") && !recipient.equalsIgnoreCase("all")) {
			return;
		}
		String agentId = string(message, "agentId");
		String body = string(message, "text");
		if (body.isBlank()) {
			return;
		}
		Protocol.Agent agent = state.agent(agentId);
		String name = agent == null ? agentId : agent.name();
		server.getPlayerList().broadcastSystemMessage(Component.literal("[AgentCraft] " + name + ": " + body), false);
	}

	private void broadcastData(String json) {
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			sendData(player, json);
		}
	}

	private void broadcastLink() {
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			sendLink(player);
		}
	}

	private void sendData(UUID playerId, String json) {
		ServerPlayer player = server.getPlayerList().getPlayer(playerId);
		if (player != null) {
			sendData(player, json);
		}
	}

	private void sendData(ServerPlayer player, String json) {
        if (!ServerPlayNetworking.canSend(player, Data.TYPE)) return;
        if (!OwnerAccess.isOwner(player)) {
            JsonObject projected = JsonParser.parseString(json).getAsJsonObject();
            String type = string(projected, "type");
            if (type.equals("memory.upsert")) {
                JsonObject entry = projected.getAsJsonObject("entry");
                if (entry == null || !string(entry, "scope").equals("shared")) return;
            } else if (type.equals("snapshot") && projected.has("memory")) {
                JsonArray shared = new JsonArray();
                for (var entry : projected.getAsJsonArray("memory")) {
                    if (entry.isJsonObject() && string(entry.getAsJsonObject(), "scope").equals("shared")) shared.add(entry);
                }
                projected.add("memory", shared);
            }
            json = projected.toString();
        }
        int bytes = json.getBytes(StandardCharsets.UTF_8).length;
		if (bytes > MAX_JSON_BYTES && JsonParser.parseString(json).getAsJsonObject().get("type").getAsString().equals("snapshot")) {
			for (String part : dev.agentcraft.network.SnapshotTransfer.split(json)) sendData(player, part);
			return;
		}
		if (json.length() > MAX_JSON_CHARS || bytes > MAX_JSON_BYTES || !ServerPlayNetworking.canSend(player, Data.TYPE)) {
			if (json.length() > MAX_JSON_CHARS || bytes > MAX_JSON_BYTES) {
				AgentCraft.LOGGER.warn("Dropped oversized Foreman frame ({} characters, {} UTF-8 bytes)", json.length(), bytes);
			}
			return;
		}
		String transferId = Long.toUnsignedString(transferIds.incrementAndGet(), 36);
		List<String> parts = fragments(json);
		for (int i = 0; i < parts.size(); i++) {
			ServerPlayNetworking.send(player, new Data(transferId, i, parts.size(), parts.get(i)));
		}
	}

	private static List<String> fragments(String value) {
		List<String> out = new ArrayList<>();
		for (int start = 0; start < value.length();) {
			int end = Math.min(value.length(), start + ForemanPayloads.MAX_FRAGMENT_CHARS);
			// Keep a UTF-16 surrogate pair together so each UTF-8 packet decodes to valid text;
			// the ordered reassembler concatenates these untouched Java substrings verbatim.
			if (end < value.length() && Character.isHighSurrogate(value.charAt(end - 1)) && Character.isLowSurrogate(value.charAt(end))) {
				end--;
			}
			out.add(value.substring(start, end));
			start = end;
		}
		if (out.isEmpty()) {
			out.add("");
		}
		return out;
	}

	private void forget(UUID playerId) {
		ackRoutes.entrySet().removeIf(e -> e.getValue().playerId().equals(playerId));
		diffRoutes.entrySet().removeIf(e -> e.getValue().playerId().equals(playerId));
		rateWindows.remove(playerId);
	}

	private void failRoutes(String reason) {
		for (Route route : ackRoutes.values()) {
			server.execute(() -> sendSyntheticAck(route, reason));
		}
		ackRoutes.clear();
		diffRoutes.clear();
	}

	private final class Listener implements WebSocket.Listener {
		private final int generationAtOpen;
		private final StringBuilder text = new StringBuilder();

		private Listener(int generationAtOpen) {
			this.generationAtOpen = generationAtOpen;
		}

		@Override
		public void onOpen(WebSocket webSocket) {
			webSocket.request(1);
		}

		@Override
		public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
			text.append(data);
			if (text.length() > MAX_JSON_CHARS) {
				fail(generationAtOpen, "Foreman frame exceeded the relay limit", -1);
				return null;
			}
			if (last) {
				String frame = text.toString();
				text.setLength(0);
				if (frame.getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
					fail(generationAtOpen, "Foreman frame exceeded the 4 MiB relay limit", -1);
					return null;
				}
				if (generationAtOpen == generation) {
					lastInbound = System.currentTimeMillis();
					server.execute(() -> {
						if (running && generationAtOpen == generation) {
							try {
								parseAndHandle(frame);
							} finally {
								// Demand follows consumption: at most one complete frame waits
								// for the server thread, even under sustained agent output.
								if (running && generationAtOpen == generation) webSocket.request(1);
							}
						}
					});
				}
			} else {
				webSocket.request(1); // Continue the bounded, incomplete frame.
			}
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPing(WebSocket webSocket, ByteBuffer message) {
			lastInbound = System.currentTimeMillis();
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket webSocket, ByteBuffer message) {
			lastInbound = System.currentTimeMillis();
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
			fail(generationAtOpen, "closed by Foreman (" + statusCode + (reason == null || reason.isBlank() ? "" : ": " + reason) + ")", -1);
			return null;
		}

		@Override
		public void onError(WebSocket webSocket, Throwable error) {
			fail(generationAtOpen, describe(error), -1);
		}
	}

	private void parseAndHandle(String frame) {
		JsonObject object;
		try {
			JsonElement parsed = JsonParser.parseString(frame);
			if (!parsed.isJsonObject()) {
				return;
			}
			object = parsed.getAsJsonObject();
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.warn("Loopback Foreman sent invalid JSON ({} characters)", frame.length());
			return;
		}
		try {
			JsonObject complete = snapshots.accept(object);
			if (complete != null) handle(complete);
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.warn("Could not route Foreman frame '{}'", string(object, "type"), e);
		}
	}

	private CompletableFuture<?> sendRaw(WebSocket socket, String text) {
		synchronized (sendLock) {
			CompletableFuture<?> next = sendChain.handle((v, e) -> null).thenCompose(v -> socket.sendText(text, true));
			sendChain = next.exceptionally(e -> null);
			return next;
		}
	}

	private static String string(JsonObject o, String field) {
		try {
			return o.has(field) && o.get(field).isJsonPrimitive() ? o.get(field).getAsString() : "";
		} catch (RuntimeException e) {
			return "";
		}
	}

	private static String truncate(String value, int max) {
		return value.length() <= max ? value : value.substring(0, max - 1) + "…";
	}

	private static String describe(Throwable error) {
		Throwable cause = error;
		while ((cause instanceof CompletionException || cause.getClass() == RuntimeException.class) && cause.getCause() != null) {
			cause = cause.getCause();
		}
		if (cause instanceof ConnectException) {
			return "connection refused (start the local Foreman first?)";
		}
		if (cause instanceof HttpTimeoutException) {
			return "connect timed out";
		}
		if (cause instanceof WebSocketHandshakeException handshake) {
			return "handshake refused (HTTP " + handshake.getResponse().statusCode() + ")";
		}
		String message = cause.getMessage();
		return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message);
	}
}
