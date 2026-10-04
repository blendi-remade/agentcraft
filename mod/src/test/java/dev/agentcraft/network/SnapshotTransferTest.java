package dev.agentcraft.network;

import com.google.gson.*;
import dev.agentcraft.client.foreman.ForemanLink;
import dev.agentcraft.client.foreman.ForemanState;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SnapshotTransferTest {
	private JsonObject large() {
		JsonObject snapshot = new JsonObject(); snapshot.addProperty("type", "snapshot");
		JsonArray goals = new JsonArray();
		for (int i=0;i<1500;i++) { JsonObject goal=new JsonObject();goal.addProperty("id","g"+i);goal.addProperty("text","goal 🏠 ".repeat(500));goals.add(goal); }
		snapshot.add("goals",goals);return snapshot;
	}
	@Test void reassemblesLargeUnicodeHistoryExactly() {
		JsonObject original=large(); assertTrue(original.toString().getBytes(StandardCharsets.UTF_8).length>4*1024*1024);
		var frames=SnapshotTransfer.split(original.toString());var transfer=new SnapshotTransfer();
		for(int i=0;i<frames.size();i++) {
			assertTrue(frames.get(i).getBytes(StandardCharsets.UTF_8).length<1024*1024);
			JsonObject result=transfer.accept(JsonParser.parseString(frames.get(i)).getAsJsonObject());
			if(i<frames.size()-1)assertNull(result);else assertEquals(original,result);
		}
	}
	@Test void clientAppliesOnlyAfterTheLastPart() {
		ForemanState state=mock(ForemanState.class);
		ForemanLink link=new ForemanLink(URI.create("minecraft:server-relay"),"test",state,Runnable::run,true,m->{},()->{});
		JsonObject snapshot=large();var parts=SnapshotTransfer.split(snapshot.toString());
		try {
			for(int i=0;i<parts.size()-1;i++)link.receiveRelayed(parts.get(i));
			verify(state,never()).receive(eq("snapshot"),any());
			link.receiveRelayed(parts.getLast());
			verify(state).receive("snapshot",snapshot);
		}finally{link.stop();}
	}
	@Test void rejectsMissingAndMixedPartsAndCanRecover() {
		var frames=SnapshotTransfer.split(large().toString());var transfer=new SnapshotTransfer();
		assertThrows(IllegalArgumentException.class,()->transfer.accept(JsonParser.parseString(frames.get(1)).getAsJsonObject()));
		transfer.accept(JsonParser.parseString(frames.getFirst()).getAsJsonObject());
		JsonObject wrong=JsonParser.parseString(frames.get(1)).getAsJsonObject();wrong.addProperty("transferId","another");
		assertThrows(IllegalArgumentException.class,()->transfer.accept(wrong));
		JsonObject last=null;for(String frame:frames)last=transfer.accept(JsonParser.parseString(frame).getAsJsonObject());
		assertNotNull(last);assertEquals(1500,last.getAsJsonArray("goals").size());
	}
}
