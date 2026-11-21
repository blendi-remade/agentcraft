package dev.agentcraft.client.foreman;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.TypeAdapter;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;
import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Gson set up for the Foreman protocol: lenient wire enums, records, no HTML escaping, nulls omitted. */
public final class ForemanJson {
	public static final Gson GSON = new GsonBuilder()
		.disableHtmlEscaping()
		.registerTypeAdapter(Protocol.AgentState.class, wireEnum(Protocol.AgentState.class))
		.registerTypeAdapter(Protocol.Station.class, wireEnum(Protocol.Station.class))
		.registerTypeAdapter(Protocol.AgentRole.class, wireEnum(Protocol.AgentRole.class))
		.registerTypeAdapter(Protocol.TaskStatus.class, wireEnum(Protocol.TaskStatus.class))
		.registerTypeAdapter(Protocol.CiStatus.class, wireEnum(Protocol.CiStatus.class))
		.registerTypeAdapter(Protocol.LogKind.class, wireEnum(Protocol.LogKind.class))
		.registerTypeAdapter(Protocol.DecisionKind.class, wireEnum(Protocol.DecisionKind.class))
		.registerTypeAdapter(Protocol.DecisionStatus.class, wireEnum(Protocol.DecisionStatus.class))
		.registerTypeAdapter(Protocol.GoalStatus.class, wireEnum(Protocol.GoalStatus.class))
		.registerTypeAdapter(Protocol.FeedKind.class, wireEnum(Protocol.FeedKind.class))
		.registerTypeAdapter(Protocol.NotifyLevel.class, wireEnum(Protocol.NotifyLevel.class))
		.registerTypeAdapter(Protocol.WorktreeStatus.class, wireEnum(Protocol.WorktreeStatus.class))
		.registerTypeAdapter(Protocol.BackendName.class, wireEnum(Protocol.BackendName.class))
		.registerTypeAdapter(Protocol.AuthStatus.class, wireEnum(Protocol.AuthStatus.class))
		.registerTypeAdapter(Protocol.DiffFileStatus.class, wireEnum(Protocol.DiffFileStatus.class))
		.registerTypeAdapter(Protocol.DiffLineKind.class, wireEnum(Protocol.DiffLineKind.class))
		.create();

	private ForemanJson() {
	}

	public static <T> T read(JsonElement json, Class<T> type) {
		return GSON.fromJson(json, type);
	}

	/**
	 * Wire enums deserialize by lower-case name; unknown values become the enum's UNKNOWN
	 * constant (or null). The generic bound keeps the cast-free and warning-free: no
	 * unchecked cast from a raw TypeAdapter is needed.
	 */
	private static <E extends Enum<E> & Protocol.Wire> TypeAdapter<E> wireEnum(Class<E> enumType) {
		Map<String, E> byWire = new HashMap<>();
		E unknown = null;
		for (E constant : enumType.getEnumConstants()) {
			byWire.put(constant.name().toLowerCase(Locale.ROOT), constant);
			if (constant.name().equals("UNKNOWN")) {
				unknown = constant;
			}
		}
		final E fallback = unknown;
		return new TypeAdapter<E>() {
			@Override
			public void write(JsonWriter out, E value) throws IOException {
				out.value(value.wire());
			}

			@Override
			public E read(JsonReader in) throws IOException {
				if (in.peek() == JsonToken.NULL) {
					in.nextNull();
					return null;
				}
				if (in.peek() != JsonToken.STRING) {
					in.skipValue();
					return fallback;
				}
				return byWire.getOrDefault(in.nextString().toLowerCase(Locale.ROOT), fallback);
			}
		}.nullSafe();
	}

	/** Small helper to build outgoing messages: {@code msg("goal.submit").put("text", t).json()}. */
	public static Builder msg(String type) {
		return new Builder(type);
	}

	public static final class Builder {
		private final JsonObject o = new JsonObject();

		private Builder(String type) {
			o.addProperty("v", Protocol.VERSION);
			o.addProperty("type", type);
		}

		/** Adds the field unless {@code value} is null (optional fields are omitted, never null). */
		public Builder put(String key, Object value) {
			if (value == null) {
				return this;
			}
			if (value instanceof String s) {
				o.addProperty(key, s);
			} else if (value instanceof Number n) {
				o.addProperty(key, n);
			} else if (value instanceof Boolean b) {
				o.addProperty(key, b);
			} else if (value instanceof JsonElement el) {
				o.add(key, el);
			} else {
				o.add(key, GSON.toJsonTree(value));
			}
			return this;
		}

		public JsonObject json() {
			return o;
		}
	}
}
