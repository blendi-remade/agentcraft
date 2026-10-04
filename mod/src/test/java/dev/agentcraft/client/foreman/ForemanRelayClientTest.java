package dev.agentcraft.client.foreman;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.agentcraft.network.ForemanPayloads.Data;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URI;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ForemanRelayClientTest {
	private ForemanLink link;
	private Map<?, ?> assemblies;

	@BeforeEach void setup() throws Exception {
		link = mock(ForemanLink.class);
		Field field = ForemanRelayClient.class.getDeclaredField("link");
		field.setAccessible(true);
		field.set(null, link);
		field = ForemanRelayClient.class.getDeclaredField("assemblies");
		field.setAccessible(true);
		assemblies = (Map<?, ?>) field.get(null);
		assemblies.clear();
	}

	private void accept(Data packet) throws Exception {
		Method method = ForemanRelayClient.class.getDeclaredMethod("accept", Data.class);
		method.setAccessible(true);
		method.invoke(null, packet);
	}

	@Test void reassemblesOutOfOrderWithoutMixingTransfers() throws Exception {
		accept(new Data("a", 1, 2, "world"));
		accept(new Data("b", 0, 1, "other"));
		accept(new Data("a", 0, 2, "hello "));
		verify(link).receiveRelayed("other");
		verify(link).receiveRelayed("hello world");
		assertTrue(assemblies.isEmpty());
	}

	@Test void rejectsInvalidCountsIndicesAndDuplicateParts() throws Exception {
		accept(new Data("a", 0, 0, "bad"));
		accept(new Data("a", 0, 271, "bad"));
		accept(new Data("a", -1, 1, "bad"));
		accept(new Data("a", 1, 1, "bad"));
		accept(new Data("a", 0, 2, "first"));
		accept(new Data("a", 0, 2, "duplicate"));
		assertTrue(assemblies.isEmpty());
		verifyNoInteractions(link);
	}

	@Test void disconnectFailsPendingRequestsImmediately() {
		var status = new LinkStatus(LinkStatus.Phase.SYNCED, "minecraft:server-relay", 0, null, 0, 0, true);
		var real = new ForemanLink(URI.create("minecraft:server-relay"), "test", new ForemanState(status), Runnable::run,
			true, message -> {}, () -> {});
		try {
			real.updateRelayStatus(status);
			var pending = real.send(ForemanJson.msg("user.message").put("text", "hello").json());
			assertFalse(pending.isDone());
			real.updateRelayStatus(status.with(LinkStatus.Phase.WAITING_RETRY, "disconnect", 0));
			assertTrue(pending.isCompletedExceptionally());
		} finally {
			real.stop();
		}
	}

	@Test void boundsIncompleteTransfersAndRejectsUtf8Overflow() throws Exception {
		for (int i = 0; i < 100; i++) accept(new Data("transfer-" + i, 0, 2, "part"));
		assertEquals(16, assemblies.size());
		assemblies.clear();
		// Under 4 Mi Java chars, but over the server's 4 MiB UTF-8 limit.
		for (int i = 0; i < 100; i++) accept(new Data("wide", i, 100, "界".repeat(16000)));
		verifyNoInteractions(link);
	}

	@Test void expiresIncompleteTransferBeforeAcceptingNewParts() throws Exception {
		accept(new Data("old", 0, 2, "old"));
		Object assembly = assemblies.get("old");
		Field time = assembly.getClass().getDeclaredField("createdAt");
		time.setAccessible(true);
		time.setLong(assembly, System.currentTimeMillis() - 31000);
		accept(new Data("old", 1, 2, "new"));
		verifyNoInteractions(link);
	}
}
