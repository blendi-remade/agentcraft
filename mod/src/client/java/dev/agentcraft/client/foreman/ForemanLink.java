package dev.agentcraft.client.foreman;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.LinkStatus.Phase;
import dev.agentcraft.client.foreman.Protocol.Ack;
import dev.agentcraft.client.foreman.Protocol.Diff;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * Client-facing Foreman link. Multiplayer clients use the authenticated Minecraft play-channel
 * relay; the legacy direct-WebSocket constructor remains available for local client tools. Sends {@code hello} on every
 * connect, hands each received message to {@link ForemanState} on the client thread, matches acks
 * and diffs to requests, and reconnects forever with backoff (0.25 s doubling up to 5 s). It never
 * blocks the render or server thread: all network work happens on its own daemon threads.
 *
 * <p>A watchdog closes a connection that sends nothing (not even a pong to our 15 s pings) for
 * 45 s, or that does not deliver a snapshot within 15 s of opening.
 */
public final class ForemanLink {
	public static final long ACK_TIMEOUT_MS = 20_000;
	private static final long[] BACKOFF_MS = {250, 500, 1000, 2000, 3000, 5000};
	private static final long SILENCE_MS = 45_000;
	private static final long HANDSHAKE_MS = 15_000;
	private static final long PING_MS = 15_000;

	private final URI uri;
	private final String modVersion;
	private final ForemanState state;
	private final Executor clientThread;
	private final @Nullable Consumer<JsonObject> relaySender;
	private final @Nullable Runnable relayReconnect;
	private final ScheduledExecutorService sched;
	private final ExecutorService io;
	private final HttpClient http;
	private final AtomicInteger generation = new AtomicInteger();
	private final AtomicLong ids = new AtomicLong();
	private final Map<String, CompletableFuture<Ack>> pendingAcks = new ConcurrentHashMap<>();
	private final Map<String, CompletableFuture<Diff>> pendingDiffs = new ConcurrentHashMap<>();
	private final java.util.List<Consumer<Diff>> diffListeners = new CopyOnWriteArrayList<>();

	private volatile @Nullable WebSocket ws;
	private volatile boolean running;
	private volatile LinkStatus status;
	private volatile long lastInbound;
	private volatile long lastPing;
	private volatile long messages;
	private volatile int attempt;
	private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);
	private final Object sendLock = new Object();

	public ForemanLink(URI uri, String modVersion, ForemanState state, Executor clientThread, boolean enabled) {
		this(uri, modVersion, state, clientThread, enabled, null, null);
	}

	/** Client facade for the Minecraft play-channel relay; the server alone opens the loopback socket. */
	public ForemanLink(URI uri, String modVersion, ForemanState state, Executor clientThread, boolean enabled,
		@Nullable Consumer<JsonObject> relaySender, @Nullable Runnable relayReconnect) {
		this.uri = uri;
		this.modVersion = modVersion;
		this.state = state;
		this.clientThread = clientThread;
		this.relaySender = relaySender;
		this.relayReconnect = relayReconnect;
		this.status = new LinkStatus(enabled ? Phase.WAITING_RETRY : Phase.DISABLED, uri.toString(), 0, null,
			System.currentTimeMillis(), System.currentTimeMillis(), false);
		this.sched = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "AgentCraft-ForemanLink"));
		this.io = Executors.newCachedThreadPool(r -> daemon(r, "AgentCraft-ForemanLink-io"));
		this.http = HttpClient.newBuilder().executor(io).connectTimeout(Duration.ofSeconds(3)).build();
	}

	private static Thread daemon(Runnable r, String name) {
		Thread t = new Thread(r, name);
		t.setDaemon(true);
		return t;
	}

	// ------------------------------------------------------------------ lifecycle

	public synchronized void start() {
		if (running || status.phase() == Phase.DISABLED) {
			return;
		}
		running = true;
		if (relaySender != null) {
			// JOIN delivers the authoritative server status and current snapshot.
			return;
		}
		sched.execute(this::connect);
		sched.scheduleAtFixedRate(this::watchdog, 5, 5, TimeUnit.SECONDS);
		AgentCraft.LOGGER.info("Foreman link started ({})", uri);
	}

	public synchronized void stop() {
		snapshots.clear();
		running = false;
		if (relaySender != null) {
			failPending("Minecraft connection closed");
			sched.shutdownNow();
			io.shutdownNow();
			return;
		}
		WebSocket s = ws;
		ws = null;
		if (s != null) {
			try {
				s.sendClose(WebSocket.NORMAL_CLOSURE, "game closing").orTimeout(500, TimeUnit.MILLISECONDS).exceptionally(t -> null).join();
			} catch (Throwable ignored) {
				// closing anyway
			}
			s.abort();
		}
		failPending("game closing");
		sched.shutdownNow();
		io.shutdownNow();
	}

	/** Drop the current connection (if any) and connect again right away. */
	public void reconnectNow() {
		if (relaySender != null) {
			if (relayReconnect != null) {
				relayReconnect.run();
			}
			return;
		}
		sched.execute(() -> {
			WebSocket s = ws;
			if (s != null) {
				s.abort();
			}
			fail(generation.get(), "reconnect requested", 0);
		});
	}

	public LinkStatus status() {
		return status;
	}

	public URI uri() {
		return uri;
	}

	/** Messages received since the game started. */
	public long messageCount() {
		return messages;
	}

	public long lastInboundAt() {
		return lastInbound;
	}

	/** Called (client thread) for every {@code diff} message, also ones answering other clients' requests addressed to us. */
	public void addDiffListener(Consumer<Diff> l) {
		diffListeners.add(l);
	}

	// ------------------------------------------------------------------ connect / fail

	private void connect() {
		if (!running) {
			return;
		}
		int gen = generation.incrementAndGet();
		attempt++;
		publish(status.with(Phase.CONNECTING, status.lastError(), 0).attempt(attempt));
		try {
			http.newWebSocketBuilder()
				.connectTimeout(Duration.ofSeconds(3))
				.buildAsync(uri, new Listener(gen))
				.whenComplete((socket, err) -> {
					if (err != null) {
						fail(gen, describe(err), -1);
						return;
					}
					if (gen != generation.get() || !running) {
						socket.abort();
						return;
					}
					ws = socket;
					lastInbound = System.currentTimeMillis();
					lastPing = lastInbound;
					publish(status.with(Phase.HANDSHAKE, null, 0));
					JsonObject hello = ForemanJson.msg("hello").put("modVersion", modVersion).put("protocol", Protocol.VERSION).put("client", "mod").put("snapshotParts", true).json();
					sendRaw(socket, hello.toString());
				});
		} catch (Throwable t) {
			fail(gen, describe(t), -1);
		}
	}

	/** The connection of generation {@code gen} is gone: fail pending requests and schedule the next attempt. */
	private void fail(int gen, String reason, long delayOverride) {
		if (gen != generation.get()) {
			return; // a stale socket's late callback
		}
		generation.incrementAndGet();
		snapshots.clear();
		WebSocket s = ws;
		ws = null;
		if (s != null) {
			s.abort();
		}
		failPending("Foreman connection lost: " + reason);
		if (!running) {
			return;
		}
		boolean wasSynced = status.phase() == Phase.SYNCED;
		if (wasSynced) {
			attempt = 0;
			AgentCraft.LOGGER.warn("Foreman link lost: {}", reason);
		}
		long delay = delayOverride >= 0 ? delayOverride : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
		publish(status.with(Phase.WAITING_RETRY, reason, System.currentTimeMillis() + delay));
		try {
			sched.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
		} catch (Throwable ignored) {
			// shutting down
		}
	}

	private void watchdog() {
		WebSocket s = ws;
		if (s == null) {
			return;
		}
		long now = System.currentTimeMillis();
		Phase p = status.phase();
		if (p == Phase.HANDSHAKE && now - status.sinceMs() > HANDSHAKE_MS) {
			fail(generation.get(), "no snapshot within " + HANDSHAKE_MS / 1000 + " s", -1);
		} else if (now - lastInbound > SILENCE_MS) {
			fail(generation.get(), "no data for " + SILENCE_MS / 1000 + " s", -1);
		} else if (now - lastPing >= PING_MS) {
			lastPing = now;
			synchronized (sendLock) {
				sendChain = sendChain.handle((v, e) -> null).thenCompose(v -> s.sendPing(ByteBuffer.allocate(0))).exceptionally(t -> null);
			}
		}
	}

	private void publish(LinkStatus s) {
		status = s;
		clientThread.execute(() -> state.setLink(s));
	}

	private static String describe(Throwable t) {
		Throwable c = t;
		while ((c instanceof CompletionException || c.getClass() == RuntimeException.class) && c.getCause() != null) {
			c = c.getCause();
		}
		if (c instanceof ConnectException) {
			return "connection refused (Foreman not running?)";
		}
		if (c instanceof HttpTimeoutException) {
			return "connect timed out";
		}
		if (c instanceof WebSocketHandshakeException h) {
			return "handshake refused (HTTP " + h.getResponse().statusCode() + ")";
		}
		String m = c.getMessage();
		return c.getClass().getSimpleName() + (m != null ? ": " + m : "");
	}

	// ------------------------------------------------------------------ receive

	private final class Listener implements WebSocket.Listener {
		private final int gen;
		private final StringBuilder buf = new StringBuilder();

		Listener(int gen) {
			this.gen = gen;
		}

		@Override
		public void onOpen(WebSocket webSocket) {
			webSocket.request(1);
		}

		@Override
		public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
			buf.append(data);
			if (last) {
				String text = buf.toString();
				buf.setLength(0);
				if (gen == generation.get()) {
					handle(text);
				}
			}
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPing(WebSocket webSocket, ByteBuffer message) {
			// java.net.http answers pings with a pong automatically
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
			fail(gen, "closed by Foreman (" + statusCode + (reason == null || reason.isEmpty() ? "" : ": " + reason) + ")", -1);
			return null;
		}

		@Override
		public void onError(WebSocket webSocket, Throwable error) {
			fail(gen, describe(error), -1);
		}
	}

	private final dev.agentcraft.network.SnapshotTransfer snapshots = new dev.agentcraft.network.SnapshotTransfer();

	private void handle(String text) {
		lastInbound = System.currentTimeMillis();
		messages++;
		JsonObject json;
		try {
			JsonElement el = JsonParser.parseString(text);
			if (!el.isJsonObject()) {
				return;
			}
			json = snapshots.accept(el.getAsJsonObject());
			if (json == null) return;
		} catch (Exception e) {
			AgentCraft.LOGGER.warn("Foreman sent invalid JSON ({} chars)", text.length());
			return;
		}
		String type = json.has("type") && json.get("type").isJsonPrimitive() ? json.get("type").getAsString() : "";
		try {
			switch (type) {
				case "ack" -> {
					Ack ack = ForemanJson.read(json, Ack.class);
					CompletableFuture<Ack> f = ack.re() == null ? null : pendingAcks.remove(ack.re());
					if (f != null) {
						f.complete(ack);
					}
				}
				case "diff" -> {
					Diff diff = ForemanJson.read(json, Diff.class);
					CompletableFuture<Diff> f = diff.requestId() == null ? null : pendingDiffs.remove(diff.requestId());
					if (f != null) {
						f.complete(diff);
					}
					clientThread.execute(() -> {
						for (Consumer<Diff> l : diffListeners) {
							try {
								l.accept(diff);
							} catch (Throwable t) {
								AgentCraft.LOGGER.warn("diff listener failed", t);
							}
						}
					});
				}
				case "error" -> AgentCraft.LOGGER.info("Foreman error: {}", json.has("message") ? json.get("message").getAsString() : json);
				case "snapshot" -> {
					// parse + apply on the client thread, then mark the link live
					clientThread.execute(() -> {
						try {
							state.receive(type, json);
						} catch (Exception e) {
							AgentCraft.LOGGER.warn("Bad snapshot from the Foreman", e);
						}
					});
					if (status.phase() != Phase.SYNCED) {
						attempt = 0;
						AgentCraft.LOGGER.info("Foreman link synced ({})", uri);
						publish(status.with(Phase.SYNCED, null, 0));
					}
				}
				default -> clientThread.execute(() -> {
					try {
						state.receive(type, json);
					} catch (Exception e) {
						AgentCraft.LOGGER.warn("Bad '{}' message from the Foreman", type, e);
					}
				});
			}
		} catch (Exception e) {
			AgentCraft.LOGGER.warn("Could not handle Foreman message '{}'", type, e);
		}
	}

	/** Receive an unchanged Foreman JSON frame routed through the server's authenticated play channel. */
	public void receiveRelayed(String text) {
		if (relaySender != null) {
			handle(text);
		}
	}

	/** Apply the server-owned WebSocket link status to this client's facade. */
	public void updateRelayStatus(LinkStatus next) {
		if (relaySender == null) {
			return;
		}
		status = next;
		if (!next.synced()) {
			failPending("Minecraft relay disconnected: " + next.phaseName());
		}
		clientThread.execute(() -> state.setLink(next));
	}

	// ------------------------------------------------------------------ send

	/**
	 * Send a client message. An {@code id} is added if missing; the future completes (on the client
	 * thread) with the Foreman's ack, or fails if not connected, on timeout or when the connection drops.
	 * {@code ack.ok == false} is a normal completion: check it.
	 */
	public CompletableFuture<Ack> send(JsonObject message) {
		CompletableFuture<Ack> raw = new CompletableFuture<>();
		WebSocket s = ws;
		if ((relaySender == null && s == null) || status.phase() != Phase.SYNCED) {
			raw.completeExceptionally(new IllegalStateException("Foreman not connected (" + status.phaseName() + ")"));
			return onClientThread(raw);
		}
		String id;
		if (message.has("id") && message.get("id").isJsonPrimitive()) {
			id = message.get("id").getAsString();
		} else {
			id = "mc-" + ids.incrementAndGet();
			message.addProperty("id", id);
		}
		if (!message.has("v")) {
			message.addProperty("v", Protocol.VERSION);
		}
		pendingAcks.put(id, raw);
		raw.orTimeout(ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS).whenComplete((a, e) -> pendingAcks.remove(id));
		if (relaySender != null) {
			try {
				relaySender.accept(message.deepCopy());
			} catch (Throwable t) {
				raw.completeExceptionally(t);
			}
		} else {
			sendRaw(s, message.toString()).exceptionally(t -> {
				raw.completeExceptionally(t);
				return null;
			});
		}
		return onClientThread(raw);
	}

	/** {@code diff.request}; completes (client thread) with the {@code diff} reply (check {@code diff.error()}). */
	public CompletableFuture<Diff> requestDiff(String repoId, String worktree) {
		String requestId = "mcd-" + ids.incrementAndGet();
		CompletableFuture<Diff> raw = new CompletableFuture<>();
		pendingDiffs.put(requestId, raw);
		raw.orTimeout(ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS).whenComplete((d, e) -> pendingDiffs.remove(requestId));
		send(ForemanJson.msg("diff.request").put("requestId", requestId).put("repoId", repoId).put("worktree", worktree).json())
			.whenComplete((ack, err) -> {
				if (err != null) {
					raw.completeExceptionally(err);
				} else if (!ack.ok()) {
					raw.completeExceptionally(new IllegalStateException(ack.error() != null ? ack.error() : "diff.request refused"));
				}
			});
		return onClientThread(raw);
	}

	/** A future that completes like {@code raw}, but always on the client thread. */
	private <T> CompletableFuture<T> onClientThread(CompletableFuture<T> raw) {
		CompletableFuture<T> out = new CompletableFuture<>();
		raw.whenComplete((v, e) -> clientThread.execute(() -> {
			if (e != null) {
				out.completeExceptionally(e instanceof CompletionException && e.getCause() != null ? e.getCause() : e);
			} else {
				out.complete(v);
			}
		}));
		return out;
	}

	/** java.net.http allows one outstanding send per socket: chain them. */
	private CompletableFuture<?> sendRaw(WebSocket s, String text) {
		synchronized (sendLock) {
			CompletableFuture<?> next = sendChain.handle((v, e) -> null).thenCompose(v -> s.sendText(text, true));
			sendChain = next.exceptionally(t -> null);
			return next;
		}
	}

	private void failPending(String reason) {
		IllegalStateException ex = new IllegalStateException(reason);
		pendingAcks.values().forEach(f -> f.completeExceptionally(ex));
		pendingAcks.clear();
		pendingDiffs.values().forEach(f -> f.completeExceptionally(ex));
		pendingDiffs.clear();
	}
}
