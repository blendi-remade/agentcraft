package dev.agentcraft.client.agents;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.setup.TeamSetupScreen;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;

/** Owner-visible model choices, fetched from the signed-in backend rather than hard-coded. */
public final class AgentModelScreen extends Screen {
	private record Choice(String model, String label, List<String> efforts, String defaultEffort) {}

	private final Screen parent;
	private final String agentId;
	private final List<Choice> models = new ArrayList<>();
	private int selected, first, effort, x, y, w, rows;
	private boolean loading = true, saving;
	private String status = "Loading available models…";
	private String next = "", active = "";
	private String provider;
	private boolean requested;

	public AgentModelScreen(Screen parent, String agentId) {
		super(Component.literal("Agent model"));
		this.parent = parent;
		this.agentId = agentId;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void onClose() {
		minecraft.gui.setScreen(parent);
	}

	@Override
	protected void init() {
		w = Math.min(400, width - 24);
		x = (width - w) / 2;
		rows = Math.max(1, Math.min(7, (height - 182) / 22));
		y = Math.max(12, (height - (rows * 22 + 170)) / 2);
		if (!requested) {
			requested = true;
			load();
		}
	}

	private JsonObject modelPayload() {
		JsonObject p = payload();
		if (provider != null) p.addProperty("provider", provider);
		return p;
	}

	private JsonObject payload() {
		JsonObject p = new JsonObject();
		p.addProperty("agentId", agentId);
		return p;
	}

	private static String value(JsonObject o, String key, String fallback) {
		return o != null && o.has(key) && !o.get(key).isJsonNull()
				? o.get(key).getAsString()
				: fallback;
	}

	private String describe(JsonObject p) {
		return p == null
				? "idle"
				: value(p, "model", "Harness default") + " · " + value(p, "effort", "default effort");
	}

	private void settings(JsonObject r) {
		next = "Next turn: " + describe(r.getAsJsonObject("next"));
		active =
				"Current turn: "
						+ describe(
								r.has("active") && r.get("active").isJsonObject()
										? r.getAsJsonObject("active")
										: null);
	}

	private void load() {
		models.clear();
		selected = first = effort = 0;
		loading = true;
		status = "Loading available models…";
		Foreman.send("agent.models", modelPayload())
				.whenComplete(
						(ack, error) -> {
							loading = false;
							if (error != null || ack == null || !ack.ok() || ack.result() == null) {
								status =
										error != null
												? "Could not load models. Retry below."
												: ack == null ? "No response. Retry below." : ack.error();
								return;
							}
							try {
								JsonObject r = ack.result();
								models.clear();
								settings(r);
								provider =
										value(
												r,
												"catalogProvider",
												value(r, "provider", provider == null ? "codex" : provider));
								for (var entry : r.getAsJsonArray("models")) {
									JsonObject m = entry.getAsJsonObject();
									List<String> levels = new ArrayList<>();
									for (var level : m.getAsJsonArray("efforts")) levels.add(level.getAsString());
									if (!levels.isEmpty())
										models.add(
												new Choice(
														value(m, "model", ""),
														value(m, "label", ""),
														levels,
														value(m, "defaultEffort", levels.getFirst())));
								}
								selected = 0;
								first = 0;
								JsonObject desired = r.getAsJsonObject("next");
								for (int i = 0; i < models.size(); i++)
									if (models.get(i).model().equals(value(desired, "model", ""))) selected = i;
								resetEffort();
								if (!models.isEmpty()) {
									int index = models.get(selected).efforts().indexOf(value(desired, "effort", ""));
									if (index >= 0) effort = index;
								}
								status =
										models.isEmpty()
												? "No selectable models returned. Retry below."
												: "Changes apply on the next turn. Current work continues.";
							} catch (RuntimeException e) {
								models.clear();
								status = "Invalid model response. Retry below.";
							}
						});
	}

	private void resetEffort() {
		effort =
				models.isEmpty()
						? 0
						: Math.max(
								0, models.get(selected).efforts().indexOf(models.get(selected).defaultEffort()));
	}

	private void choose(int index) {
		selected = Math.clamp(index, 0, models.size() - 1);
		resetEffort();
	}

	private void save(boolean defaults) {
		if (loading || saving || (!defaults && models.isEmpty())) return;
		JsonObject p = payload();
		if (!defaults && provider != null) p.addProperty("provider", provider);
		if (!defaults) {
			Choice c = models.get(selected);
			p.addProperty("model", c.model());
			p.addProperty("effort", c.efforts().get(effort));
		}
		saving = true;
		status = "Saving…";
		Foreman.send("agent.configure", p)
				.whenComplete(
						(ack, error) -> {
							saving = false;
							if (error != null || ack == null || !ack.ok() || ack.result() == null) {
								status =
										error != null
												? "Save failed. Your previous settings remain."
												: ack == null ? "No response." : ack.error();
								return;
							}
							settings(ack.result());
							status = "Saved for the next turn.";
						});
	}

	private void text(GuiGraphicsExtractor g, String s, int yy) {
		g.text(
				font,
				TextUtil.ellipsize(font, s == null ? "Request failed" : s, w - 24),
				x + 12,
				yy,
				UiStyle.color("paper.text"),
				false);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float delta) {
		g.fill(0, 0, width, height, 0xAA17120E);
		Panels.panel(g, x, y, w, rows * 22 + 170);
		text(g, agentId + " · Model and reasoning", y + 12);
		text(g, next, y + 28);
		text(g, active, y + 40);
		String[] harnessButtons = {"Codex [C]", "Claude [L]", "Team [T]"};
		for (int i = 0; i < 3; i++) {
			int xx = x + 10 + i * (w - 20) / 3;
			Panels.sprite(
					g,
					Kit.button(i < 2 && (i == 0 ? "codex" : "claude").equals(provider), "normal"),
					xx,
					y + 52,
					(w - 24) / 3,
					20);
			g.text(font, harnessButtons[i], xx + 5, y + 58, UiStyle.color("paper.text"), false);
		}
		first = Math.clamp(first, 0, Math.max(0, models.size() - rows));
		if (selected < first) first = selected;
		if (selected >= first + rows) first = selected - rows + 1;
		for (int i = 0; i < rows && first + i < models.size(); i++) {
			int yy = y + 78 + i * 22;
			boolean sel = selected == first + i;
			Panels.sprite(g, Kit.button(sel, "normal"), x + 10, yy, w - 20, 20);
			text(g, models.get(first + i).label(), yy + 6);
		}
		int bottom = y + 78 + rows * 22;
		Panels.sprite(g, Kit.button(false, "normal"), x + 10, bottom, w - 20, 20);
		text(
				g,
				"Reasoning: "
						+ (models.isEmpty() ? "—" : models.get(selected).efforts().get(effort))
						+ "   ‹ / ›",
				bottom + 6);
		text(g, status, bottom + 26);
		String[] labels = {saving ? "Saving…" : "Apply", "Defaults [D]", "Retry [R]", "Back"};
		for (int i = 0; i < 4; i++) {
			int xx = x + 10 + i * (w - 20) / 4;
			Panels.sprite(g, Kit.button(i == 0, "normal"), xx, bottom + 42, (w - 24) / 4, 20);
			g.text(font, labels[i], xx + 5, bottom + 48, UiStyle.color("paper.text"), false);
		}
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean twice) {
		if (e.x() < x + 10 || e.x() >= x + w - 10) return true;
		if (e.button() != InputConstants.MOUSE_BUTTON_LEFT) return false;
		if (e.y() >= y + 52 && e.y() < y + 72 && !loading && !saving) {
			int section = (int) ((e.x() - x - 10) * 3 / (w - 20));
			if (section == 2) minecraft.gui.setScreen(new TeamSetupScreen(this));
			else {
				provider = section == 0 ? "codex" : "claude";
				load();
			}
			return true;
		}
		int top = y + 78, bottom = top + rows * 22;
		if (!loading && !saving && !models.isEmpty() && e.y() >= top && e.y() < bottom) {
			int index = first + (int) (e.y() - top) / 22;
			if (index < models.size()) choose(index);
		} else if (!loading && !saving && e.y() >= bottom && e.y() < bottom + 20 && !models.isEmpty())
			effort = (effort + 1) % models.get(selected).efforts().size();
		else if (e.y() >= bottom + 42 && e.y() < bottom + 62) {
			int button = (int) ((e.x() - x - 10) * 4 / (w - 20));
			switch (button) {
				case 0 -> save(false);
				case 1 -> save(true);
				case 2 -> {
					if (!saving && !loading) load();
				}
				case 3 -> onClose();
			}
		}
		return true;
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		if (!models.isEmpty() && !loading && !saving && sy != 0) choose(selected + (sy > 0 ? -1 : 1));
		return true;
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.key() == InputConstants.KEY_ESCAPE) {
			onClose();
			return true;
		}
		if (!loading && !saving) {
			if (e.key() == InputConstants.KEY_C || e.key() == InputConstants.KEY_L) {
				provider = e.key() == InputConstants.KEY_C ? "codex" : "claude";
				load();
				return true;
			}
			if (e.key() == InputConstants.KEY_T) {
				minecraft.gui.setScreen(new TeamSetupScreen(this));
				return true;
			}
			if (e.key() == InputConstants.KEY_R) {
				load();
				return true;
			}
			if (e.key() == InputConstants.KEY_D) {
				save(true);
				return true;
			}
		}
		if (!loading && !saving && !models.isEmpty()) {
			if (e.key() == InputConstants.KEY_UP) choose(selected - 1);
			else if (e.key() == InputConstants.KEY_DOWN) choose(selected + 1);
			else if (e.key() == InputConstants.KEY_LEFT)
				effort = Math.floorMod(effort - 1, models.get(selected).efforts().size());
			else if (e.key() == InputConstants.KEY_RIGHT)
				effort = (effort + 1) % models.get(selected).efforts().size();
			else if (e.key() == InputConstants.KEY_RETURN) save(false);
		}
		return true;
	}
}
