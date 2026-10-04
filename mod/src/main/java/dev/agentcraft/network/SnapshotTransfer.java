package dev.agentcraft.network;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Bounded, ordered transport for snapshots larger than a Minecraft relay message. */
public final class SnapshotTransfer {
	private static final int PART_CHARS = 128 * 1024;
	private static final int MAX_BYTES = 64 * 1024 * 1024;
	private String id = "";
	private int next, total, bytes;
	private long started;
	private final StringBuilder body = new StringBuilder();

	public synchronized void clear() {
		id = ""; next = total = bytes = 0; started = 0;
		body.setLength(0); body.trimToSize();
	}
	public synchronized @Nullable JsonObject accept(JsonObject message) {
		if (started != 0 && System.currentTimeMillis() - started > 30_000) clear();
		if (!message.has("type") || !message.get("type").getAsString().equals("snapshot.part")) return message;
		try {
			String incoming = message.get("transferId").getAsString();
			int index = message.get("index").getAsInt(), count = message.get("total").getAsInt();
			String part = message.get("body").getAsString();
			if (incoming.isEmpty() || incoming.length() > 64 || count < 1 || count > 512 || index < 0 || index >= count || part.length() > PART_CHARS) throw new IllegalArgumentException("Invalid snapshot segment");
			if (index == 0) { clear(); id = incoming; total = count; started = System.currentTimeMillis(); }
			if (!incoming.equals(id) || index != next || count != total) throw new IllegalArgumentException("Snapshot segments arrived out of order");
			bytes += part.getBytes(StandardCharsets.UTF_8).length;
			if (bytes > MAX_BYTES) throw new IllegalArgumentException("Snapshot exceeds 64 MiB");
			body.append(part); next++;
			if (next != total) return null;
			JsonObject result = JsonParser.parseString(body.toString()).getAsJsonObject();
			if (!result.has("type") || !result.get("type").getAsString().equals("snapshot")) throw new IllegalArgumentException("Transfer did not contain a snapshot");
			clear(); return result;
		} catch (RuntimeException e) { clear(); throw e; }
	}
	public static List<String> split(String json) {
		if (json.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new IllegalArgumentException("Snapshot exceeds 64 MiB");
		List<String> chunks = new ArrayList<>();
		for (int start = 0; start < json.length();) {
			int end = Math.min(start + PART_CHARS, json.length());
			if (end < json.length() && Character.isHighSurrogate(json.charAt(end - 1))) end--;
			chunks.add(json.substring(start, end)); start = end;
		}
		String id = UUID.randomUUID().toString(); List<String> result = new ArrayList<>();
		for (int i = 0; i < chunks.size(); i++) {
			JsonObject p = new JsonObject(); p.addProperty("v",1); p.addProperty("type","snapshot.part");
			p.addProperty("transferId",id); p.addProperty("index",i); p.addProperty("total",chunks.size()); p.addProperty("body",chunks.get(i)); result.add(p.toString());
		}
		return result;
	}
}
