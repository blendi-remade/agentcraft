package dev.agentcraft.client.ui;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * UI language for the mod's own screens. The English text in the code is the key: {@code Tr.t("Send")}
 * returns the translation from {@code assets/agentcraft/i18n/<lang>.json}, or the English text when
 * there is none, so an untranslated string never breaks a screen.
 *
 * <p>The language is, first match wins: {@code AGENTCRAFT_LANG} (en|it), {@code "language"} in
 * {@code <AGENTCRAFT_HOME or ~/.agentcraft>/config.json} (the same setting the agents and the dashboard
 * use), then Minecraft's own language ({@code lang:} in options.txt, e.g. it_it). The console
 * command {@code /lang it|en|auto} switches it while playing.
 */
public final class Tr {
	private static final String[] SUPPORTED = {"en", "it"};
	private static volatile String lang;
	private static volatile Map<String, String> table = Map.of();

	private Tr() {
	}

	/** The translation of an English UI string (itself when there is none). */
	public static String t(String en) {
		if (lang == null) {
			init();
		}
		String s = table.get(en);
		return s == null ? en : s;
	}

	/** {@link #t} then {@link String#format}: {@code Tr.f("%d files", n)}. */
	public static String f(String en, Object... args) {
		return String.format(Locale.ROOT, t(en), args);
	}

	public static String language() {
		if (lang == null) {
			init();
		}
		return lang;
	}

	/** Switch the language now ("en", "it" or "auto"); screens pick it up on their next frame. */
	public static synchronized void setLanguage(String code) {
		String l = normalize(code);
		if (l == null) {
			l = detect(true);
		}
		lang = l;
		table = load(l);
	}

	public static boolean supported(String code) {
		return "auto".equalsIgnoreCase(code) || normalize(code) != null;
	}

	private static synchronized void init() {
		if (lang == null) {
			setLanguage(detect(false));
		}
	}

	/** en_us / it-IT / IT -> en / it; anything else -> null. */
	static @Nullable String normalize(@Nullable String code) {
		if (code == null) {
			return null;
		}
		String c = code.trim().toLowerCase(Locale.ROOT);
		for (String s : SUPPORTED) {
			if (c.equals(s) || c.startsWith(s + "_") || c.startsWith(s + "-")) {
				return s;
			}
		}
		return null;
	}

	/** The configured language; {@code skipConfigured} = only Minecraft's own (for "auto"). */
	static String detect(boolean skipConfigured) {
		if (!skipConfigured) {
			String env = normalize(System.getenv("AGENTCRAFT_LANG"));
			if (env != null) {
				return env;
			}
			String cfg = normalize(configLanguage());
			if (cfg != null) {
				return cfg;
			}
		}
		String mc = normalize(minecraftLanguage(Path.of("options.txt")));
		return mc != null ? mc : "en";
	}

	private static @Nullable String configLanguage() {
		try {
			String home = System.getenv("AGENTCRAFT_HOME");
			Path dir = home != null && !home.isBlank() ? Path.of(home) : Path.of(System.getProperty("user.home"), ".agentcraft");
			Path file = dir.resolve("config.json");
			if (!Files.isRegularFile(file)) {
				return null;
			}
			JsonElement root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
			if (root.isJsonObject() && root.getAsJsonObject().has("language")) {
				return root.getAsJsonObject().get("language").getAsString();
			}
		} catch (Exception e) {
			// a broken config.json is the Foreman's to report; the UI stays usable
		}
		return null;
	}

	/** {@code lang:it_it} from the game's options.txt (the working directory of the client). */
	static @Nullable String minecraftLanguage(Path options) {
		try {
			if (!Files.isRegularFile(options)) {
				return null;
			}
			for (String line : Files.readAllLines(options, StandardCharsets.UTF_8)) {
				if (line.startsWith("lang:")) {
					return line.substring(5).trim();
				}
			}
		} catch (Exception e) {
			// unreadable options: fall back to English
		}
		return null;
	}

	private static Map<String, String> load(String l) {
		if ("en".equals(l)) {
			return Map.of();
		}
		try (InputStream in = Tr.class.getResourceAsStream("/assets/agentcraft/i18n/" + l + ".json")) {
			if (in == null) {
				return Map.of();
			}
			JsonObject o = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
			Map<String, String> m = new HashMap<>();
			for (Map.Entry<String, JsonElement> e : o.entrySet()) {
				if (e.getValue().isJsonPrimitive()) {
					m.put(e.getKey(), e.getValue().getAsString());
				}
			}
			return Map.copyOf(m);
		} catch (Exception e) {
			return Map.of();
		}
	}
}
