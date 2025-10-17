import type { Socket } from "socket.io";
import type { EmojiData } from "./_types.js";
import { ReactionEventEnums } from "./_enums.js";

export class ReactionService {
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  listenForReactions() {
    console.log("Listening for reactions...");

    this.socket.on(
      ReactionEventEnums.SEND_REACTION,
      (reactionData: EmojiData) => {
        console.log("SENDING REACTION: ", reactionData);

        this.socket.broadcast.emit(
          ReactionEventEnums.NEW_REACTION,
          reactionData,
        );

        this.socket.emit(ReactionEventEnums.NEW_REACTION, reactionData);
      },
    );
  }
}
