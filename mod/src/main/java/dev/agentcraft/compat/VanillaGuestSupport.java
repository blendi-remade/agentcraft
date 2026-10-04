package dev.agentcraft.compat;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.block.ModBlocks;
import dev.agentcraft.block.entity.ModBlockEntities;
import dev.agentcraft.entity.ModEntities;
import dev.agentcraft.network.ForemanPayloads;
import eu.pb4.polymer.common.api.PolymerCommonUtils;
import eu.pb4.polymer.core.api.block.PolymerBlock;
import eu.pb4.polymer.core.api.block.PolymerBlockUtils;
import eu.pb4.polymer.core.api.item.PolymerItem;
import eu.pb4.polymer.core.api.utils.PolymerSyncedObject;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.fabric.api.networking.v1.context.PacketContext;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntityType;
/** Packet projections let ordinary Minecraft clients share the survival world. */
public final class VanillaGuestSupport {
    private VanillaGuestSupport() {}
    public static void init() {
        for (Block block : ModBlocks.all()) {
            Block fallback = fallback(BuiltInRegistries.BLOCK.getKey(block).getPath());
            PolymerBlock.registerOverlay(block, (state, context) -> fallback.defaultBlockState());
            PolymerItem.registerOverlay(block.asItem(), new PolymerItem() {
                public Item getPolymerItem(ItemStack stack, PacketContext context) { return fallback.asItem(); }
                public Identifier getPolymerItemModel(ItemStack stack, PacketContext context, HolderLookup.Provider lookup) {
                    return hasStudioClient(context) ? PolymerItem.super.getPolymerItemModel(stack, context, lookup) : null;
                }
            });
        }
        for (BlockEntityType<?> type : new BlockEntityType<?>[] { ModBlockEntities.MONITOR, ModBlockEntities.TASK_BOARD,
            ModBlockEntities.DECISION_PODIUM, ModBlockEntities.MEMORY_ARCHIVE, ModBlockEntities.MERGE_STATION,
            ModBlockEntities.STATUS_LAMP, ModBlockEntities.CONSOLE_TERMINAL }) {
            PolymerBlockUtils.registerBlockEntity(type, (obj, context) -> hasStudioClient(context) ? obj : null);
        }
        // Agents are locally rendered and never sent as server entities.
        PolymerSyncedObject.setSyncedObject(BuiltInRegistries.ENTITY_TYPE, ModEntities.AGENT,
            (type, context) -> EntityTypes.VILLAGER);
        AgentCraft.LOGGER.info("Vanilla guest compatibility enabled (16 block and item projections)");
    }
    private static boolean hasStudioClient(PacketContext context) {
        var player = PolymerCommonUtils.getPlayer(context);
        return player != null && ServerPlayNetworking.canSend(player, ForemanPayloads.Data.TYPE);
    }
    private static Block fallback(String name) {
        return switch (name) {
            case "monitor" -> Blocks.POLISHED_BLACKSTONE_SLAB;
            case "task_board", "memory_archive", "memory_catalog" -> Blocks.BOOKSHELF;
            case "decision_podium" -> Blocks.LECTERN;
            case "merge_station" -> Blocks.SMITHING_TABLE;
            case "status_lamp", "glow_panel" -> Blocks.SEA_LANTERN;
            case "console_terminal" -> Blocks.CRAFTING_TABLE;
            case "glow_strip" -> Blocks.END_ROD;
            case "plaster_panel", "plaster_frame" -> Blocks.CALCITE;
            case "walnut_panel", "walnut_trim" -> Blocks.DARK_OAK_PLANKS;
            case "terracotta_tile" -> Blocks.TERRACOTTA;
            case "oak_parquet" -> Blocks.OAK_PLANKS;
            default -> throw new IllegalArgumentException("Missing vanilla projection: " + name);
        };
    }
}
