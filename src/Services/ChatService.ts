import { Socket } from "socket.io";
import { type Message } from "./_types.js";
import { EventEnums } from "./_enums.js";

export class ChatService {
  socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  listenForMessage() {
    console.log("Listening for messages...");
    this.socket.on(EventEnums.SEND_MESSAGE, (msg: Partial<Message>) => {
      const completeMessage: Message = {
        content: msg.content || "",
        senderSocketId: this.socket.id,
        name: msg.name || "Unknown User",
        createdAt: new Date(),
        type: msg.type || "text",
        ...(msg.gifUrl && { gifUrl: msg.gifUrl }),
        ...(msg.imageUrl && { imageUrl: msg.imageUrl }),
      };

      this.socket.broadcast.emit(EventEnums.NEW_MESSAGE, completeMessage);
      this.socket.emit(EventEnums.NEW_MESSAGE, completeMessage);

      //TODO: Save message to database
      //idk to  tiring
    });
  }
}
