package dev.agentcraft.client.setup;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/** Studio setup uses detected catalogs; choices remain a draft until the whole team is saved. */
public final class TeamSetupScreen extends Screen {
	private static final String[] ROLES = {"lead", "worker", "reviewer"};

	private record Model(String id, String label, List<String> efforts, String defaultEffort) {}

	private record Harness(boolean available, String description, List<Model> models) {}

	private record Selection(String provider, String model, String effort) {
		JsonObject json() {
			JsonObject out = new JsonObject();
			out.addProperty("provider", provider);
			out.addProperty("model", model);
			out.addProperty("effort", effort);
			return out;
		}
	}

	private final @Nullable Screen parent;
	private final Map<String, Harness> harnesses = new LinkedHashMap<>();
	private final Map<String, Selection> roles = new LinkedHashMap<>();
	private boolean requested, busy, canConfigure, hasOverrides, resetOverrides, rebuild;
	private String status = "Detecting installed CLIs and available models…";
	private int x, y, w, h, roleGap;

	public TeamSetupScreen(@Nullable Screen parent) {
		super(Component.literal("Studio setup"));
		this.parent = parent;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void onClose() {
		if (!busy) minecraft.gui.setScreen(parent);
	}

	private static String text(JsonObject o, String key, String fallback) {
		return o != null && o.has(key) && !o.get(key).isJsonNull()
				? o.get(key).getAsString()
				: fallback;
	}

	private static boolean flag(JsonObject o, String key) {
		return o.has(key) && o.get(key).getAsBoolean();
	}

	private Button button(String label, int xx, int yy, int ww, boolean enabled, Runnable action) {
		Button b =
				Button.builder(Component.literal(label), ignored -> action.run())
						.bounds(xx, yy, ww, 20)
						.build();
		b.active = enabled;
		addRenderableWidget(b);
		return b;
	}

	private void queueRebuild() {
		rebuild = true;
	}

	@Override
	public void tick() {
		if (rebuild) {
			rebuild = false;
			init();
		}
	}

	@Override
	protected void init() {
		int focus = children().indexOf(getFocused());
		w = Math.min(440, width - 24);
		h = Math.min(280, height - 24);
		x = (width - w) / 2;
		y = (height - h) / 2;
		roleGap = Math.min(38, (h - 144) / 3);
		clearWidgets();
		int third = (w - 24) / 3;
		button(
				"All Codex",
				x + 10,
				y + 48,
				third,
				!busy && available("codex"),
				() -> preset("codex", "codex"));
		button(
				"All Claude",
				x + 12 + third,
				y + 48,
				third,
				!busy && available("claude"),
				() -> preset("claude", "claude"));
		button(
				"Mixed team",
				x + 14 + 2 * third,
				y + 48,
				third,
				!busy && available("codex") && available("claude"),
				() -> preset("codex", "claude"));
		for (int i = 0; i < ROLES.length; i++) {
			String role = ROLES[i];
			Selection s = roles.get(role);
			button(
					"Choose…",
					x + w - 80,
					y + 78 + i * roleGap,
					70,
					!busy && !harnesses.isEmpty(),
					() -> minecraft.gui.setScreen(new Picker(role, s)));
		}
		button(
				resetOverrides ? "Reset individual overrides" : "Keep individual overrides",
				x + 10,
				y + h - 66,
				w - 20,
				!busy && hasOverrides,
				() -> {
					resetOverrides = !resetOverrides;
					queueRebuild();
				});
		int bw = (w - 28) / 3;
		button("Detect again", x + 10, y + h - 28, bw, !busy, () -> detect(true));
		button(
				busy ? "Please wait…" : "Save team",
				x + 14 + bw,
				y + h - 28,
				bw,
				!busy && canConfigure && valid(),
				this::save);
		button("Back", x + 18 + 2 * bw, y + h - 28, bw, !busy, this::onClose);
		if (focus >= 0 && focus < children().size()) setFocused(children().get(focus));
		if (!requested) {
			requested = true;
			detect(false);
		}
	}

	private boolean available(String provider) {
		Harness h = harnesses.get(provider);
		return h != null && h.available() && !h.models().isEmpty();
	}

	private boolean valid() {
		for (String role : ROLES) {
			Selection s = roles.get(role);
			if (s == null || !available(s.provider())) return false;
			if (harnesses.get(s.provider()).models().stream()
					.noneMatch(m -> m.id().equals(s.model()) && m.efforts().contains(s.effort())))
				return false;
		}
		return true;
	}

	private @Nullable Selection initial(String provider) {
		Harness h = harnesses.get(provider);
		if (h == null || h.models().isEmpty()) return null;
		Model m = h.models().getFirst();
		return new Selection(provider, m.id(), m.defaultEffort());
	}

	private void preset(String provider, String reviewer) {
		roles.put("lead", initial(provider));
		roles.put("worker", initial(provider));
		roles.put("reviewer", initial(reviewer));
		status = "Choose each role's model and reasoning, then save.";
		queueRebuild();
	}

	private void detect(boolean refresh) {
		busy = true;
		status = "Detecting installed CLIs and available models…";
		JsonObject p = new JsonObject();
		p.addProperty("refresh", refresh);
		Foreman.send("harness.detect", p)
				.whenComplete(
						(ack, error) -> {
							busy = false;
							if (error != null || ack == null || !ack.ok() || ack.result() == null) {
								status =
										error != null
												? "Detection failed. Check the Foreman connection."
												: ack == null ? "No response." : ack.error();
								queueRebuild();
								return;
							}
							try {
								JsonObject result = ack.result();
								harnesses.clear();
								canConfigure = flag(result, "canConfigure");
								hasOverrides = flag(result, "hasAgentOverrides");
								for (var entry : result.getAsJsonArray("harnesses")) {
									JsonObject h = entry.getAsJsonObject();
									List<Model> models = new ArrayList<>();
									for (var model : h.getAsJsonArray("models")) {
										JsonObject m = model.getAsJsonObject();
										List<String> efforts = new ArrayList<>();
										for (var e : m.getAsJsonArray("efforts")) efforts.add(e.getAsString());
										if (!efforts.isEmpty())
											models.add(
													new Model(
															text(m, "model", ""),
															text(m, "label", ""),
															List.copyOf(efforts),
															text(m, "defaultEffort", efforts.getFirst())));
									}
									String provider = text(h, "provider", "");
									harnesses.put(
											provider,
											new Harness(
													flag(h, "available"),
													flag(h, "available")
															? text(h, "version", "Ready")
															: text(h, "reason", "Unavailable"),
													models));
								}
								JsonObject current = result.getAsJsonObject("roles");
								if (roles.isEmpty() && current != null)
									for (String role : ROLES) {
										JsonObject s = current.getAsJsonObject(role);
										if (s == null) continue;
										String provider = text(s, "provider", "");
										Selection fallback = initial(provider);
										if (fallback != null)
											roles.put(
													role,
													new Selection(
															provider,
															text(s, "model", fallback.model()),
															text(s, "effort", fallback.effort())));
									}
								status =
										canConfigure
												? "Pick one harness or mix roles. Current turns continue."
												: "This Foreman needs the team-setup update.";
							} catch (RuntimeException invalid) {
								status = "Invalid discovery response. Detect again.";
								canConfigure = false;
							}
							queueRebuild();
						});
		queueRebuild();
	}

	private void save() {
		if (!valid() || busy) return;
		JsonObject p = new JsonObject(), r = new JsonObject();
		for (String role : ROLES) r.add(role, roles.get(role).json());
		p.add("roles", r);
		p.addProperty("resetAgentOverrides", resetOverrides);
		busy = true;
		status = "Saving all role selections…";
		queueRebuild();
		Foreman.send("team.configure", p)
				.whenComplete(
						(ack, error) -> {
							busy = false;
							if (error != null || ack == null || !ack.ok()) {
								status =
										error != null
												? "Save failed. Previous settings remain."
												: ack == null ? "No response." : ack.error();
							} else {
								status = "Saved. New turns use these choices.";
								if (resetOverrides) hasOverrides = false;
								resetOverrides = false;
							}
							queueRebuild();
						});
	}

	private void line(GuiGraphicsExtractor g, String value, int xx, int yy, int max) {
		g.text(
				font,
				TextUtil.ellipsize(font, value == null ? "Request failed" : value, max),
				xx,
				yy,
				UiStyle.color("paper.text"),
				false);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float delta) {
		g.fill(0, 0, width, height, 0xAA17120E);
		Panels.panel(g, x, y, w, h);
		line(g, "Studio setup · harness, model and reasoning", x + 10, y + 10, w - 20);
		int i = 0;
		for (String provider : List.of("codex", "claude")) {
			Harness h = harnesses.get(provider);
			line(
					g,
					provider + ": " + (h == null ? "Detecting…" : h.description()),
					x + 10,
					y + 24 + 10 * i++,
					w - 20);
		}
		for (i = 0; i < ROLES.length; i++) {
			String role = ROLES[i];
			Selection s = roles.get(role);
			line(g, role.toUpperCase(), x + 10, y + 78 + i * roleGap, w - 105);
			line(
					g,
					s == null
							? "Choose a harness and model"
							: s.provider() + " / " + s.model() + " / " + s.effort(),
					x + 10,
					y + 91 + i * roleGap,
					w - 105);
		}
		line(g, status, x + 10, y + h - 40, w - 20);
		super.extractRenderState(g, mx, my, delta);
	}

	private final class Picker extends Screen {
		private final String role;
		private String provider;
		private int selected, first, effort, px, py, pw, ph, rows;
		private boolean rebuild;

		private void queueRebuild() {
			rebuild = true;
		}

		@Override
		public void tick() {
			if (rebuild) {
				rebuild = false;
				init();
			}
		}

		Picker(String role, @Nullable Selection previous) {
			super(Component.literal("Choose " + role));
			this.role = role;
			provider = previous == null ? (available("codex") ? "codex" : "claude") : previous.provider();
			selectPrevious(previous);
		}

		private List<Model> models() {
			Harness h = harnesses.get(provider);
			return h == null ? List.of() : h.models();
		}

		private void selectPrevious(@Nullable Selection s) {
			selected = 0;
			effort =
					models().isEmpty()
							? 0
							: Math.max(
									0, models().getFirst().efforts().indexOf(models().getFirst().defaultEffort()));
			first = 0;
			if (s != null)
				for (int i = 0; i < models().size(); i++)
					if (models().get(i).id().equals(s.model())) {
						selected = i;
						effort = Math.max(0, models().get(i).efforts().indexOf(s.effort()));
					}
		}

		private void control(String label, int xx, int yy, int ww, boolean active, Runnable action) {
			Button b =
					Button.builder(Component.literal(label), ignored -> action.run())
							.bounds(xx, yy, ww, 20)
							.build();
			b.active = active;
			addRenderableWidget(b);
		}

		@Override
		protected void init() {
			int focus = children().indexOf(getFocused());
			pw = Math.min(420, width - 24);
			ph = Math.min(280, height - 24);
			px = (width - pw) / 2;
			py = (height - ph) / 2;
			rows = Math.max(1, (ph - 138) / 20);
			clearWidgets();
			control(
					(provider.equals("codex") ? "✓ " : "") + "Codex",
					px + 10,
					py + 28,
					(pw - 24) / 2,
					true,
					() -> {
						provider = "codex";
						selectPrevious(null);
						queueRebuild();
					});
			control(
					(provider.equals("claude") ? "✓ " : "") + "Claude",
					px + 14 + (pw - 24) / 2,
					py + 28,
					(pw - 24) / 2,
					true,
					() -> {
						provider = "claude";
						selectPrevious(null);
						queueRebuild();
					});
			if (selected < first) first = selected;
			if (selected >= first + rows) first = selected - rows + 1;
			for (int i = 0; i < rows && first + i < models().size(); i++) {
				int index = first + i;
				control(
						(index == selected ? "› " : "") + models().get(index).label(),
						px + 10,
						py + 54 + i * 20,
						pw - 20,
						true,
						() -> choose(index));
			}
			control(
					"Reasoning: " + (models().isEmpty() ? "—" : models().get(selected).efforts().get(effort)),
					px + 10,
					py + ph - 74,
					pw - 20,
					!models().isEmpty(),
					() -> {
						effort = (effort + 1) % models().get(selected).efforts().size();
						queueRebuild();
					});
			control(
					"Use for " + role,
					px + 10,
					py + ph - 28,
					(pw - 24) / 2,
					available(provider),
					() -> {
						Model m = models().get(selected);
						roles.put(role, new Selection(provider, m.id(), m.efforts().get(effort)));
						onClose();
					});
			control("Cancel", px + 14 + (pw - 24) / 2, py + ph - 28, (pw - 24) / 2, true, this::onClose);
			if (focus >= 0 && focus < children().size()) setFocused(children().get(focus));
		}

		private void choose(int index) {
			selected = Math.clamp(index, 0, models().size() - 1);
			effort =
					Math.max(
							0, models().get(selected).efforts().indexOf(models().get(selected).defaultEffort()));
			queueRebuild();
		}

		@Override
		public void onClose() {
			minecraft.gui.setScreen(TeamSetupScreen.this);
		}

		@Override
		public boolean isPauseScreen() {
			return false;
		}

		@Override
		public boolean mouseScrolled(double mx, double my, double sx, double sy) {
			if (!models().isEmpty() && sy != 0) choose(selected + (sy > 0 ? -1 : 1));
			return true;
		}

		@Override
		public boolean keyPressed(KeyEvent e) {
			if (!models().isEmpty()
					&& (e.key() == InputConstants.KEY_UP || e.key() == InputConstants.KEY_DOWN)) {
				choose(selected + (e.key() == InputConstants.KEY_UP ? -1 : 1));
				return true;
			}
			return super.keyPressed(e);
		}

		@Override
		public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float delta) {
			g.fill(0, 0, width, height, 0xAA17120E);
			Panels.panel(g, px, py, pw, ph);
			line(g, "Choose " + role + " model", px + 10, py + 10, pw - 20);
			Harness h = harnesses.get(provider);
			line(
					g,
					h == null
							? "Not detected"
							: !h.available() ? h.description() : "Scroll or use ↑ / ↓ to browse models",
					px + 10,
					py + ph - 46,
					pw - 20);
			super.extractRenderState(g, mx, my, delta);
		}
	}
}
