import { Socket } from "socket.io";
import type { User } from "../index.js";

interface FocusModeChangeData {
  playerId: string;
  isInFocusMode: boolean;
}

export class FocusModeService {
  socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  listenForFocusModeChange(userMap: Record<string, User>) {
    console.log("Listening for focus mode changes...");

    this.socket.on("focusModeChange", (data: FocusModeChangeData) => {
      console.log(`Player ${data.playerId} focus mode: ${data.isInFocusMode}`);

      // Broadcast to all other clients
      this.socket.broadcast.emit("playerFocusModeChanged", {
        playerId: data.playerId,
        isInFocusMode: data.isInFocusMode,
        socketId: this.socket.id,
      });

      if (!userMap) {
        throw new Error("users not found");
      }
      userMap[this.socket.id]!.isInFocusMode = data.isInFocusMode;
      console.log("USERMAP - - -");
      console.log(userMap);

      this.socket.emit("playerFocusModeChanged", {
        playerId: data.playerId,
        isInFocusMode: data.isInFocusMode,
        socketId: this.socket.id,
      });

      // TODO: Update player focus status in database
    });
  }
}
