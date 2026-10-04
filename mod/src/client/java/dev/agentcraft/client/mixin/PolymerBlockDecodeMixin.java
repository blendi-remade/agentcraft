package dev.agentcraft.client.mixin;
import eu.pb4.polymer.core.api.utils.PolymerClientDecoded;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import org.spongepowered.asm.mixin.Mixin;
/** Restore real AgentCraft block states on studio clients; vanilla guests see proxies. */
@Mixin(Block.class)
public abstract class PolymerBlockDecodeMixin implements PolymerClientDecoded {
    @Override public boolean shouldDecodePolymer() {
        return BuiltInRegistries.BLOCK.getKey((Block) (Object) this).getNamespace().equals("agentcraft");
    }
}
