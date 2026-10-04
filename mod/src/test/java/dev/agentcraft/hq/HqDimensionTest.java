package dev.agentcraft.hq;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class HqDimensionTest {
	@org.junit.jupiter.api.BeforeAll static void bootstrap() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}
	@Test void preservesPlayerPlacedLeavesWhileAllowingNaturalFoliage() {
		var leaves = net.minecraft.world.level.block.Blocks.OAK_LEAVES.defaultBlockState();
		assertTrue(Plan.natural(leaves.setValue(net.minecraft.world.level.block.LeavesBlock.PERSISTENT, false)));
		assertFalse(Plan.natural(leaves.setValue(net.minecraft.world.level.block.LeavesBlock.PERSISTENT, true)));
	}
	@Test void firstBuildProtectsOverhangingLeavesAndPlayerBlocks() {
		var blocks = net.minecraft.world.level.block.Blocks.OAK_LEAVES.defaultBlockState();
		assertTrue(Plan.protectedOnFirstBuild(blocks));
		assertTrue(Plan.protectedOnFirstBuild(net.minecraft.world.level.block.Blocks.CHEST.defaultBlockState()));
		assertFalse(Plan.protectedOnFirstBuild(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState()));
		assertFalse(Plan.protectedOnFirstBuild(net.minecraft.world.level.block.Blocks.STONE.defaultBlockState()));
	}
	@Test void rejectsNetherBeforeCallingBuilderOrAccessingPersistedPlan() {
		ServerLevel level = mock(ServerLevel.class);
		when(level.dimension()).thenReturn(Level.NETHER);
		HqBuilder builder = mock(HqBuilder.class);
		assertThrows(IllegalArgumentException.class, () -> HqFeature.buildAndPublish(level, builder));
		verifyNoInteractions(builder);
		verify(level, never()).getServer();
	}
	@Test void rejectsEndBeforeCallingBuilderOrAccessingPersistedPlan() {
		ServerLevel level = mock(ServerLevel.class);
		when(level.dimension()).thenReturn(Level.END);
		HqBuilder builder = mock(HqBuilder.class);
		assertThrows(IllegalArgumentException.class, () -> HqFeature.buildAndPublish(level, builder));
		verifyNoInteractions(builder);
		verify(level, never()).getServer();
	}
}
