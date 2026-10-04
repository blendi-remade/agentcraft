package dev.agentcraft.server;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.google.gson.JsonObject;
import dev.agentcraft.client.foreman.ForemanJson;
import dev.agentcraft.client.foreman.LinkStatus;
import dev.agentcraft.security.OwnerAccess;
import java.lang.reflect.*;
import java.net.URI;
import java.net.http.WebSocket;
import java.util.*;
import java.util.concurrent.*;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import org.junit.jupiter.api.*;

class ServerForemanRelayTest {
	private ServerForemanRelay relay;
	private MinecraftServer server;
	private ServerPlayer player;
	private WebSocket socket;
	private final UUID playerId = UUID.randomUUID();
	private final List<Runnable> queued = new ArrayList<>();

	@BeforeAll static void bootstrapRegistries() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@BeforeEach void setup() throws Exception {
		server = mock(MinecraftServer.class);
		player = mock(ServerPlayer.class);
		when(player.getUUID()).thenReturn(playerId);
		PlayerList players = mock(PlayerList.class);
		when(server.getPlayerList()).thenReturn(players);
		when(players.getPlayer(playerId)).thenReturn(player);
		when(players.getPlayers()).thenReturn(List.of());
		doAnswer(call -> { queued.add(call.getArgument(0)); return null; }).when(server).execute(any(Runnable.class));
		var constructor = ServerForemanRelay.class.getDeclaredConstructor(MinecraftServer.class);
		constructor.setAccessible(true);
		relay = constructor.newInstance(server);
		socket = mock(WebSocket.class);
		when(socket.sendText(anyString(), eq(true))).thenReturn(CompletableFuture.completedFuture(socket));
		when(socket.sendClose(anyInt(), anyString())).thenReturn(CompletableFuture.completedFuture(socket));
		set("ws", socket);
		set("status", new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
	}

	@AfterEach void stop() throws Exception {
		if (relay != null) call("stop", new Class<?>[0]);
	}

	private Object get(String name) throws Exception {
		Field field = ServerForemanRelay.class.getDeclaredField(name);
		field.setAccessible(true);
		return field.get(relay);
	}
	private void set(String name, Object value) throws Exception {
		Field field = ServerForemanRelay.class.getDeclaredField(name);
		field.setAccessible(true);
		field.set(relay, value);
	}
	private Object call(String name, Class<?>[] types, Object... args) throws Exception {
		Method method = ServerForemanRelay.class.getDeclaredMethod(name, types);
		method.setAccessible(true);
		return method.invoke(relay, args);
	}
	private void accept(String type) throws Exception {
		call("accept", new Class<?>[]{ServerPlayer.class, JsonObject.class, boolean.class}, player,
			ForemanJson.msg(type).put("id", "same-client-id").json(), false);
	}
	private Map<?, ?> routes(String name) throws Exception { return (Map<?, ?>) get(name); }

	@Test void endpointAlwaysLoopback() throws Exception {
		assertEquals("127.0.0.1", ((URI) get("uri")).getHost());
	}

	@Test void guestCannotPromptAnswerPermissionsOrMergeWhileOwnerCan() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class); var networking = mockStatic(ServerPlayNetworking.class)) {
			for (String type : List.of("user.message", "decision.answer", "goal.submit", "repo.open", "diff.request", "harness.detect", "team.configure", "agent.models", "agent.configure")) {
				accept(type);
			}
			verify(socket, never()).sendText(anyString(), anyBoolean());
			assertTrue(routes("ackRoutes").isEmpty());
			owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(true);
			accept("user.message");
			accept("decision.answer");
			accept("goal.submit");
			verify(socket, times(3)).sendText(anyString(), eq(true));
			assertEquals(3, routes("ackRoutes").size());
		}
	}

	@Test void malformedInputDoesNotReachForeman() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class); var networking = mockStatic(ServerPlayNetworking.class)) {
			owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(true);
			for (String text : List.of("{", "[]", "null", "{\"type\":{}}", "{\"type\":\"hello\"}", "x".repeat(16001))) {
				call("receiveRequest", new Class<?>[]{ServerPlayer.class, String.class}, player, text);
			}
			verify(socket, never()).sendText(anyString(), anyBoolean());
		}
	}

	@Test void guestRequestIsShownOnlyToOwnerAndSharedMemoryRemainsVisible() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class); var networking = mockStatic(ServerPlayNetworking.class)) {
			var owner = mock(ServerPlayer.class);
			UUID ownerId = UUID.randomUUID();
			owners.when(() -> OwnerAccess.ownerUuid(server)).thenReturn(Optional.of(ownerId));
			when(server.getPlayerList().getPlayer(ownerId)).thenReturn(owner);
			when(player.getName()).thenReturn(net.minecraft.network.chat.Component.literal("Guest"));
			call("handleCodexChat", new Class<?>[]{ServerPlayer.class, String.class}, player, "@codex build a tower");
			verify(owner).sendSystemMessage(argThat(message -> message.getString().contains("Guest: build a tower")));
			verify(socket, never()).sendText(anyString(), anyBoolean());
			networking.when(() -> ServerPlayNetworking.canSend(player, dev.agentcraft.network.ForemanPayloads.Data.TYPE)).thenReturn(true);
			call("sendData", new Class<?>[]{ServerPlayer.class, String.class}, player,
				"{\"type\":\"snapshot\",\"memory\":[{\"scope\":\"shared\",\"body\":\"visible\"},{\"scope\":\"private\",\"body\":\"hidden\"}]}");
			networking.verify(() -> ServerPlayNetworking.send(eq(player), argThat(payload ->
				payload instanceof dev.agentcraft.network.ForemanPayloads.Data data
					&& data.jsonFragment().contains("visible") && !data.jsonFragment().contains("hidden"))));
		}
	}

	@Test void nonDiffSendFailureCleansRouteWithoutNullKeyFailure() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class); var networking = mockStatic(ServerPlayNetworking.class)) {
			owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(true);
			when(socket.sendText(anyString(), eq(true))).thenReturn(CompletableFuture.failedFuture(new IllegalStateException("closed")));
			accept("user.message");
			assertEquals(1, queued.size());
			assertDoesNotThrow(() -> queued.removeFirst().run());
			assertTrue(routes("ackRoutes").isEmpty());
		}
	}

	@Test void disconnectForgetsAckDiffAndRateWindow() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class)) {
			owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(true);
			accept("diff.request");
			call("rateLimited", new Class<?>[]{UUID.class}, playerId);
			assertEquals(1, routes("ackRoutes").size());
			assertEquals(1, routes("diffRoutes").size());
			call("forget", new Class<?>[]{UUID.class}, playerId);
			for (String map : List.of("ackRoutes", "diffRoutes", "rateWindows")) assertTrue(routes(map).isEmpty());
		}
	}

	@Test void reconnectControlRequiresOwnerAndLinkFailureClearsRoutes() throws Exception {
		var scheduler = mock(ScheduledExecutorService.class);
		((ScheduledExecutorService) get("sched")).shutdownNow();
		set("sched", scheduler);
		try (var owners = mockStatic(OwnerAccess.class)) {
			call("receiveControl", new Class<?>[]{ServerPlayer.class, String.class}, player, "reconnect");
			verify(scheduler, never()).execute(any(Runnable.class));
			owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(true);
			call("receiveControl", new Class<?>[]{ServerPlayer.class, String.class}, player, "reconnect");
			verify(scheduler).execute(any(Runnable.class));
			accept("diff.request");
			call("fail", new Class<?>[]{int.class, String.class, long.class}, 0, "test disconnect", -1L);
			assertTrue(routes("ackRoutes").isEmpty());
			assertTrue(routes("diffRoutes").isEmpty());
			verify(socket).abort();
		}
	}

	@Test void queuedOldSnapshotCannotApplyAfterReconnectOrStop() throws Exception {
		set("running", true);
		Class<?> listenerClass = Class.forName(ServerForemanRelay.class.getName() + "$Listener");
		var constructor = listenerClass.getDeclaredConstructor(ServerForemanRelay.class, int.class);
		constructor.setAccessible(true);
		var listener = (WebSocket.Listener) constructor.newInstance(relay, 0);
		listener.onText(socket, "{\"type\":\"snapshot\"}", true);
		assertEquals(1, queued.size());
		set("generation", 1);
		queued.removeFirst().run();
		assertNull(get("latestSnapshot"));
		set("generation", 0);
		listener.onText(socket, "{\"type\":\"snapshot\"}", true);
		set("running", false);
		queued.removeFirst().run();
		assertNull(get("latestSnapshot"));
	}
	@Test void demandWaitsForServerConsumptionAcrossAThousandFrames() throws Exception {
		set("running", true);
		Class<?> type = Class.forName(ServerForemanRelay.class.getName() + "$Listener");
		var ctor = type.getDeclaredConstructor(ServerForemanRelay.class, int.class);
		ctor.setAccessible(true);
		var listener = (WebSocket.Listener) ctor.newInstance(relay, 0);
		for (int i = 0; i < 1000; i++) {
			clearInvocations(socket);
			listener.onText(socket, "{\"type\":", false);
			verify(socket).request(1);
			clearInvocations(socket);
			listener.onText(socket, "\"ack\"}", true);
			assertEquals(1, queued.size());
			verify(socket, never()).request(anyLong());
			queued.removeFirst().run();
			verify(socket).request(1);
			assertTrue(queued.isEmpty());
		}
	}

	@Test void segmentedSnapshotsFilterPrivateMemoryBeforeTransport() throws Exception {
		try (var owners = mockStatic(OwnerAccess.class); var networking = mockStatic(ServerPlayNetworking.class)) {
			var packets = new ArrayList<dev.agentcraft.network.ForemanPayloads.Data>();
			networking.when(() -> ServerPlayNetworking.canSend(player, dev.agentcraft.network.ForemanPayloads.Data.TYPE)).thenReturn(true);
			networking.when(() -> ServerPlayNetworking.send(eq(player), any(dev.agentcraft.network.ForemanPayloads.Data.class)))
				.thenAnswer(call -> { packets.add(call.getArgument(1)); return null; });
			JsonObject snapshot = com.google.gson.JsonParser.parseString("{\"type\":\"snapshot\",\"memory\":[{\"scope\":\"shared\",\"body\":\"visible\"},{\"scope\":\"private\",\"body\":\"private-marker\"}]}").getAsJsonObject();
			snapshot.addProperty("padding", "x".repeat(4 * 1024 * 1024 + 100));
			for (boolean owner : List.of(false, true)) {
				owners.when(() -> OwnerAccess.isOwner(player)).thenReturn(owner); packets.clear();
				call("sendData", new Class<?>[]{ServerPlayer.class, String.class}, player, snapshot.toString());
				assertFalse(packets.isEmpty());
				Map<String, StringBuilder> frames = new LinkedHashMap<>();
				for (var packet : packets) frames.computeIfAbsent(packet.transferId(), key -> new StringBuilder()).append(packet.jsonFragment());
				assertTrue(frames.size() > 1);
				var transfer = new dev.agentcraft.network.SnapshotTransfer(); JsonObject complete = null;
				for (var frame : frames.values()) complete = transfer.accept(com.google.gson.JsonParser.parseString(frame.toString()).getAsJsonObject());
				assertNotNull(complete); assertEquals(owner ? 2 : 1, complete.getAsJsonArray("memory").size());
				assertEquals(owner, complete.toString().contains("private-marker"));
				assertEquals(snapshot.get("padding"), complete.get("padding"));
			}
		}
	}

}
