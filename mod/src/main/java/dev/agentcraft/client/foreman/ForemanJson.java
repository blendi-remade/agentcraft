package dev.agentcraft.client.foreman;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.TypeAdapter;
import com.google.gson.TypeAdapterFactory;
import com.google.gson.reflect.TypeToken;
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
		.registerTypeAdapterFactory(new WireEnumFactory())
		.create();

	private ForemanJson() {
	}

	public static <T> T read(JsonElement json, Class<T> type) {
		return GSON.fromJson(json, type);
	}

	/** Deserialize wire enums by lower-case name; unknown values become the enum's UNKNOWN constant (or null). */
	private static final class WireEnumFactory implements TypeAdapterFactory {
		@Override
		@SuppressWarnings({"unchecked", "rawtypes"})
		public <T> TypeAdapter<T> create(Gson gson, TypeToken<T> type) {
			Class<? super T> raw = type.getRawType();
			if (!raw.isEnum() || !Protocol.Wire.class.isAssignableFrom(raw)) {
				return null;
			}
			Map<String, Enum<?>> byWire = new HashMap<>();
			Enum<?> unknown = null;
			for (Object c : raw.getEnumConstants()) {
				Enum<?> e = (Enum<?>) c;
				byWire.put(e.name().toLowerCase(Locale.ROOT), e);
				if (e.name().equals("UNKNOWN")) {
					unknown = e;
				}
			}
			final Enum<?> fallback = unknown;
			return (TypeAdapter<T>) new TypeAdapter<Enum<?>>() {
				@Override
				public void write(JsonWriter out, Enum<?> value) throws IOException {
					if (value == null) {
						out.nullValue();
					} else {
						out.value(((Protocol.Wire) value).wire());
					}
				}

				@Override
				public Enum<?> read(JsonReader in) throws IOException {
					if (in.peek() == JsonToken.NULL) {
						in.nextNull();
						return null;
					}
					if (in.peek() != JsonToken.STRING) {
						in.skipValue();
						return fallback;
					}
					Enum<?> e = byWire.get(in.nextString().toLowerCase(Locale.ROOT));
					return e != null ? e : fallback;
				}
			}.nullSafe();
		}
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
