package dev.agentcraft.network;

import static org.junit.jupiter.api.Assertions.*;

import io.netty.buffer.Unpooled;
import net.minecraft.core.RegistryAccess;
import net.minecraft.network.RegistryFriendlyByteBuf;
import org.junit.jupiter.api.Test;

class ForemanPayloadsTest {
	@Test void unicodeFragmentRoundTrips() {
		var buffer = new RegistryFriendlyByteBuf(Unpooled.buffer(), RegistryAccess.EMPTY);
		try {
			var packet = new ForemanPayloads.Data("transfer", 0, 1, "studio 🌍 界");
			ForemanPayloads.Data.CODEC.encode(buffer, packet);
			assertEquals(packet, ForemanPayloads.Data.CODEC.decode(buffer));
		} finally { buffer.release(); }
	}

	@Test void wireCodecRejectsOversizedRequests() {
		var buffer = new RegistryFriendlyByteBuf(Unpooled.buffer(), RegistryAccess.EMPTY);
		try {
			assertThrows(io.netty.handler.codec.EncoderException.class, () -> ForemanPayloads.Request.CODEC.encode(buffer,
				new ForemanPayloads.Request("x".repeat(ForemanPayloads.MAX_REQUEST_CHARS + 1))));
		} finally { buffer.release(); }
	}
}
