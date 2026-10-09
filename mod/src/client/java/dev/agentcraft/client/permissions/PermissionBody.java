package dev.agentcraft.client.permissions;

import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.FormattedCharSequence;

/**
 * The body of a permission decision in the decision screen: the tool and its exact command (in a
 * well with a risk-coloured stripe), the risk chip with the Foreman's reason, the working directory,
 * and what "Always allow for this team" covers, so Allow once / Always allow / Deny is an informed
 * one-key choice.
 */
public final class PermissionBody {
	private static final int MAX_CMD_LINES = 4;

	private PermissionBody() {
	}

	/** Button labels shown for the permission options (the answer still sends the exact protocol label). */
	public static String buttonLabel(String option) {
		return option.startsWith("Always allow for this ") ? "Always allow" : option;
	}

	/** Height {@link #draw} will use at this width. */
	public static int height(Font font, Decision d, int w) {
		PermissionInfo info = PermissionInfo.of(d);
		return layout(font, d, info, w).height;
	}

	private record Layout(List<FormattedCharSequence> cmd, List<FormattedCharSequence> reason, List<FormattedCharSequence> covers, String cwd,
		int height) {
	}

	private static Layout layout(Font font, Decision d, PermissionInfo info, int w) {
		List<FormattedCharSequence> cmd = TextUtil.wrap(font, info.command(), w - 16);
		if (cmd.size() > MAX_CMD_LINES) {
			cmd = new ArrayList<>(cmd.subList(0, MAX_CMD_LINES));
		}
		String why = info.reason() != null ? info.reason() : "the Foreman asks before running this";
		List<FormattedCharSequence> reason = TextUtil.wrap(font, why, w - 34);
		if (reason.size() > 3) {
			reason = new ArrayList<>(reason.subList(0, 3));
		}
		String name = UiBits.agentName(d.agentId());
		String coversText = info.covers() != null && !info.covers().isEmpty() ? info.covers()
			: name + " can run exactly this again without asking";
		List<FormattedCharSequence> covers = TextUtil.wrap(font, coversText, w - 16);
		if (covers.size() > 3) {
			covers = new ArrayList<>(covers.subList(0, 3));
		}
		String cwd = info.cwd() == null ? "" : info.cwd();
		int h = 14; // tool row
		h += 8 + cmd.size() * 10 + 4; // command well
		h += 4 + reason.size() * 10; // why
		if (!cwd.isEmpty()) {
			h += 11;
		}
		h += 5 + 10 + covers.size() * 10; // covers block
		return new Layout(cmd, reason, covers, cwd, h);
	}

	/** Draw at (x, y), {@code w} wide; returns the height used. */
	public static int draw(GuiGraphicsExtractor g, Font font, Decision d, int x, int y, int w) {
		PermissionInfo info = PermissionInfo.of(d);
		Layout l = layout(font, d, info, w);
		int ink = UiBits.ink();
		int muted = UiBits.muted();
		int riskColor = UiStyle.status(info.risk().family);
		int cy = y;

		// tool row: icon + tool name, risk chip on the right
		Panels.sprite(g, Kit.icon(PermissionInfo.iconFor(info.tool())), x, cy, 12, 12);
		g.text(font, info.tool(), x + 16, cy + 2, ink, false);
		String riskLabel = info.risk().label;
		int pw = UiBits.dotPillWidth(font, riskLabel);
		UiBits.dotPill(g, font, info.risk().family, riskLabel, x + w - pw, cy, riskText(info.risk()));
		cy += 14;

		// the command in a well, risk stripe on the left
		int wellH = 8 + l.cmd().size() * 10;
		Panels.inset(g, x, cy, w, wellH);
		g.fill(x + 2, cy + 2, x + 4, cy + wellH - 2, riskColor);
		int ly = cy + 5;
		for (FormattedCharSequence line : l.cmd()) {
			g.text(font, line, x + 9, ly, ink, false);
			ly += 10;
		}
		cy += wellH + 4;

		// why it asks
		g.text(font, "Why", x, cy + 4, muted, false);
		ly = cy + 4;
		for (FormattedCharSequence line : l.reason()) {
			g.text(font, line, x + 30, ly, ink, false);
			ly += 10;
		}
		cy += 4 + l.reason().size() * 10;

		// where
		if (!l.cwd().isEmpty()) {
			g.text(font, "In", x, cy + 1, muted, false);
			String cwd = l.cwd();
			int max = w - 30;
			if (font.width(cwd) > max) {
				// keep the end of the path (the worktree name), it is the informative part
				cwd = TextUtil.ELLIPSIS + font.plainSubstrByWidth(cwd, max - font.width(TextUtil.ELLIPSIS), true);
			}
			g.text(font, cwd, x + 30, cy + 1, UiStyle.color("paper.path", 0xFF6C5415), false);
			cy += 11;
		}

		// what "Always allow" covers
		cy += 5;
		Panels.divider(g, x, cy - 3, w);
		// the "2" keycap ties this explanation to the "2 Always allow" button
		UiBits.keycap(g, font, "2", x, cy);
		String scopeLabel = d.options().stream().filter(o -> o.startsWith("Always allow for this ")).findFirst().orElse("Always allow");
		g.text(font, "\"" + scopeLabel + "\" covers:", x + 16, cy + 2, muted, false);
		ly = cy + 12;
		for (FormattedCharSequence line : l.covers()) {
			g.text(font, line, x + 16, ly, ink, false);
			ly += 10;
		}
		return l.height();
	}

	/** Darker text tone of a risk colour, for text on paper. */
	public static int riskText(PermissionInfo.Risk r) {
		return switch (r) {
			case HIGH -> UiBits.errorText();
			case MEDIUM -> UiStyle.color("paper.link", 0xFF874431);
			case LOW -> UiStyle.color("paper.path", 0xFF6C5415);
		};
	}
}
