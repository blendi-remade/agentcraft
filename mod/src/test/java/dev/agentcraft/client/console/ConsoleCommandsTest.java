package dev.agentcraft.client.console;

import com.google.gson.JsonParser;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.LinkStatus;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ConsoleCommandsTest {
	@Test void ordinaryDiscussionDoesNotStartAGoal() {
		var s = state();
		var existingGoal = s.goal();
		var message = assertInstanceOf(ConsoleCommands.Message.class, ConsoleCommands.parse("can we discuss this?", s));
		assertEquals("marlow", message.to());
		assertEquals("can we discuss this?", message.text());
		assertEquals("message Marlow", ConsoleCommands.describe(message, s));
		assertSame(existingGoal, s.goal());
		assertTrue(s.tasks().isEmpty());
	}

	@Test void ordinaryTextBeforeAnyGoalIsAMessageIncludingWorkRequests() {
		var s = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "fixture", 0, null, 0, 0, true));
		s.receive("snapshot", JsonParser.parseString("{\"agents\":[{\"id\":\"marlow\",\"name\":\"Marlow\",\"role\":\"lead\"}]}").getAsJsonObject());
		for (String text : new String[] {"can we discuss this?", "implement the agreed change", "Olá Marlow\nlet's discuss /goal first"}) {
			assertEquals(new ConsoleCommands.Message("marlow", text), ConsoleCommands.parse("  " + text + "  ", s));
		}
		assertNull(s.goal());
		assertTrue(s.tasks().isEmpty());
	}

	private ForemanState state() {
		var s = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "fixture", 0, null, 0, 0, true));
		s.receive("snapshot", JsonParser.parseString("""
			{"agents":[{"id":"marlow","name":"Marlow","role":"lead"},
			{"id":"kit","name":"Kit","role":"worker"}],
			"repos":[{"id":"a","name":"Alpha","path":"/fixture/a","branch":"main"},
			{"id":"b","name":"Beta","path":"/fixture/b","branch":"main"}],
			"goal":{"id":"g1","text":"Existing work","repoId":"a","status":"active"}}
			""").getAsJsonObject());
		return s;
	}

	@Test void explicitGoalKeepsExistingRepositoryPickerAndTarget() {
		var s = state();
		var goal = assertInstanceOf(ConsoleCommands.Goal.class, ConsoleCommands.parse("/goal implement the agreed change", s));
		assertEquals("implement the agreed change", goal.text());
		assertEquals("a", goal.repoId());
		assertEquals(2, goal.choices().size());
		assertEquals("new goal → Alpha", ConsoleCommands.describe(goal, s));
		assertInstanceOf(ConsoleCommands.Invalid.class, ConsoleCommands.parse("/goal  ", s));
		assertEquals("a", s.goal().repoId());
	}

	@Test void directedMessagesAndCommandsKeepTheirMeaning() {
		var s = state();
		assertEquals(new ConsoleCommands.Message("kit", "hello"), ConsoleCommands.parse("@Kit hello", s));
		assertEquals(new ConsoleCommands.Message("all", "hello"), ConsoleCommands.parse("@all hello", s));
		assertInstanceOf(ConsoleCommands.Invalid.class, ConsoleCommands.parse("@nobody hello", s));
		assertInstanceOf(ConsoleCommands.Repos.class, ConsoleCommands.parse("/repos", s));
		assertInstanceOf(ConsoleCommands.Decide.class, ConsoleCommands.parse("/decide", s));
		assertInstanceOf(ConsoleCommands.Empty.class, ConsoleCommands.parse("  ", s));
	}

	@Test void explicitGoalIsDiscoverableInHelpAndCompletion() {
		assertTrue(ConsoleCommands.COMMANDS.stream().anyMatch(command -> command.name().equals("goal") && command.usage().equals("/goal <text>")));
		assertTrue(ConsoleCommands.complete("/go", 3, state()).stream().anyMatch(completion -> completion.replacement().equals("/goal ")));
	}

	@Test void explicitGoalKeepsSingleRepoAndNoRepoBehavior() {
		var s = state();
		s.receive("snapshot", JsonParser.parseString("{\"repos\":[{\"id\":\"b\",\"name\":\"Beta\",\"path\":\"/fixture/b\",\"branch\":\"main\"}]}").getAsJsonObject());
		var goal = assertInstanceOf(ConsoleCommands.Goal.class, ConsoleCommands.parse("/goal do work", s));
		assertEquals("b", goal.repoId());
		assertTrue(goal.choices().isEmpty());
		s.receive("snapshot", JsonParser.parseString("{}").getAsJsonObject());
		goal = assertInstanceOf(ConsoleCommands.Goal.class, ConsoleCommands.parse("/goal do work", s));
		assertNull(goal.repoId());
		assertTrue(goal.choices().isEmpty());
	}
}
