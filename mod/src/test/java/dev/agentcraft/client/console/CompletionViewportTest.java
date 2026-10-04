package dev.agentcraft.client.console;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CompletionViewportTest {
	@Test void followsEverySelectionInBothDirectionsAndWraps() {
		int first = 0;
		for (int selected = 0; selected < 20; selected++) {
			first = CompletionViewport.start(first, selected, 20, 6);
			assertTrue(selected >= first && selected < first + 6);
		}
		assertEquals(14, first);
		assertEquals(0, CompletionViewport.start(first, 0, 20, 6));
		for (int selected = 19; selected >= 0; selected--) {
			first = CompletionViewport.start(first, selected, 20, 6);
			assertTrue(selected >= first && selected < first + 6);
		}
		assertEquals(14, CompletionViewport.start(first, 19, 20, 6));
	}
	@Test void clampsAfterFilteringAndKeepsVisibleSelectionStable() {
		assertEquals(0, CompletionViewport.start(14, 0, 2, 2));
		assertEquals(4, CompletionViewport.start(4, 7, 20, 6));
		assertEquals(0, CompletionViewport.start(14, 0, 0, 0));
	}
}
