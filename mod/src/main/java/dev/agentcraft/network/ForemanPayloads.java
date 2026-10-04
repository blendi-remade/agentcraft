package dev.agentcraft.network;

import dev.agentcraft.AgentCraft;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** Authenticated play-channel transport for the server-owned Foreman relay. */
public final class ForemanPayloads {
	/** Keep each JSON fragment well below the vanilla custom-payload size ceiling. */
	public static final int MAX_FRAGMENT_CHARS = 16_000;
	public static final int MAX_REQUEST_CHARS = 16_000;
	private static final int MAX_TRANSFER_ID_CHARS = 48;

	private ForemanPayloads() {
	}

	public static void register() {
		PayloadTypeRegistry.serverboundPlay().register(Request.TYPE, Request.CODEC);
		PayloadTypeRegistry.serverboundPlay().register(Control.TYPE, Control.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(Data.TYPE, Data.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(Link.TYPE, Link.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(Layout.TYPE, Layout.CODEC);
	}

	/** A client request. The server always binds it to the authenticated Minecraft player. */
	public record Request(String json) implements CustomPacketPayload {
		public static final Type<Request> TYPE = new Type<>(AgentCraft.id("foreman_request"));
		public static final StreamCodec<RegistryFriendlyByteBuf, Request> CODEC = StreamCodec.composite(
			ByteBufCodecs.stringUtf8(MAX_REQUEST_CHARS), Request::json, Request::new);

		@Override
		public Type<? extends CustomPacketPayload> type() {
			return TYPE;
		}
	}

	/** Transport control messages are not part of the Foreman JSON protocol. */
	public record Control(String action) implements CustomPacketPayload {
		public static final Type<Control> TYPE = new Type<>(AgentCraft.id("foreman_control"));
		public static final StreamCodec<RegistryFriendlyByteBuf, Control> CODEC = StreamCodec.composite(
			ByteBufCodecs.stringUtf8(32), Control::action, Control::new);

		@Override
		public Type<? extends CustomPacketPayload> type() {
			return TYPE;
		}
	}

	/** One fragment of an unchanged Foreman protocol message. */
	public record Data(String transferId, int index, int count, String jsonFragment) implements CustomPacketPayload {
		public static final Type<Data> TYPE = new Type<>(AgentCraft.id("foreman_data"));
		public static final StreamCodec<RegistryFriendlyByteBuf, Data> CODEC = StreamCodec.composite(
			ByteBufCodecs.stringUtf8(MAX_TRANSFER_ID_CHARS), Data::transferId,
			ByteBufCodecs.VAR_INT, Data::index,
			ByteBufCodecs.VAR_INT, Data::count,
			ByteBufCodecs.stringUtf8(MAX_FRAGMENT_CHARS), Data::jsonFragment,
			Data::new);

		@Override
		public Type<? extends CustomPacketPayload> type() {
			return TYPE;
		}
	}

	/** Connection state of the server's one loopback WebSocket. */
	public record Link(String phase, String error, int attempt, long sinceMs, long nextRetryAtMs, boolean everSynced)
		implements CustomPacketPayload {
		public static final Type<Link> TYPE = new Type<>(AgentCraft.id("foreman_link"));
		public static final StreamCodec<RegistryFriendlyByteBuf, Link> CODEC = StreamCodec.composite(
			ByteBufCodecs.stringUtf8(32), Link::phase,
			ByteBufCodecs.stringUtf8(256), Link::error,
			ByteBufCodecs.VAR_INT, Link::attempt,
			ByteBufCodecs.VAR_LONG, Link::sinceMs,
			ByteBufCodecs.VAR_LONG, Link::nextRetryAtMs,
			ByteBufCodecs.BOOL, Link::everSynced,
			Link::new);

		@Override
		public Type<? extends CustomPacketPayload> type() {
			return TYPE;
		}
	}

	/** Published studio layout and world-space anchors for remote rendering and navigation. */
	public record Layout(String json) implements CustomPacketPayload {
		public static final Type<Layout> TYPE = new Type<>(AgentCraft.id("studio_layout"));
		public static final StreamCodec<RegistryFriendlyByteBuf, Layout> CODEC = StreamCodec.composite(
			ByteBufCodecs.stringUtf8(MAX_FRAGMENT_CHARS), Layout::json, Layout::new);

		@Override
		public Type<? extends CustomPacketPayload> type() {
			return TYPE;
		}
	}
}
