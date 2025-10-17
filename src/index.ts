import express from "express";
import { Server, Socket } from "socket.io";
import http from "http";
import cors from "cors";
import mediasoup from "mediasoup";
import dotenv from "dotenv";
import { ChatService } from "./Services/ChatService.js";
import { ReactionService } from "./Services/ReactionService.js";
dotenv.config();

const app = express();
app.use(cors());

const server = new http.Server(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

type User = {
  name: string;
};

let router: mediasoup.types.Router | undefined;
const workers: mediasoup.types.Worker[] = [];

const userMap: Record<string, User> = {};
// Store transports by transport ID
const transports: Record<string, mediasoup.types.WebRtcTransport> = {};

// Reference for which transports belong to which socket
const socketTransports: Record<string, string[]> = {};

// Store producers by producer ID with their transport ID
const producers: Record<
  string,
  { producer: mediasoup.types.Producer; transportId: string }
> = {};

// Store consumers by consumer ID with their transport ID
const consumers: Record<
  string,
  { consumer: mediasoup.types.Consumer; transportId: string }
> = {};

async function createWorker() {
  const worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  worker.on("died", () => {
    console.error("Mediasoup worker died, exiting...");
    process.exit(1);
  });

  const router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        parameters: {
          minptime: 10,
          useinbandfec: 1,
          stereo: 1,
          maxaveragebitrate: 128000,
        },
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
      },
      {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "42e01f",
        },
      },
    ],
  });

  return { worker, router };
}

async function getPublicIP(): Promise<string> {
  if (process.env.PUBLIC_IP) {
    console.log("Using PUBLIC_IP from environment:", process.env.PUBLIC_IP);
    return process.env.PUBLIC_IP;
  }

  try {
    const response = await fetch("https://api.ipify.org?format=text");
    const ip = await response.text();
    console.log("Detected public IP:", ip);
    return ip;
  } catch (err) {
    console.error("Failed to get public IP, using 127.0.0.1", err);
    return "127.0.0.1";
  }
}

async function startServer() {
  const { worker, router: createdRouter } = await createWorker();
  workers.push(worker);
  router = createdRouter;

  io.on("connection", (socket: Socket) => {
    const chatService = new ChatService(socket);
    const reactionService = new ReactionService(socket);

    chatService.listenForMessage();
    reactionService.listenForReactions();

    console.log("Client connected:", socket.id);

    socket.on("setUserInfo", (userData) => {
      console.log("SET USER INFO - - - -");
      console.log(`Socket ${socket.id} set user info:`, userData);

      userMap[socket.id] = userData;
      console.log(userMap[socket.id]);
    });

    // Initialize transport tracking for this socket
    socketTransports[socket.id] = [];

    socket.on("getRouterRtpCapabilities", (_, callback) => {
      if (!router) return;
      callback(router.rtpCapabilities);
    });

    socket.on("createTransport", async ({ type }, callback) => {
      if (!router) {
        throw new Error("Router not initialized");
      }

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: await getPublicIP() }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      // Store transport by its ID and track which socket owns it
      transports[transport.id] = transport;

      if (!socketTransports[socket.id]) {
        socketTransports[socket.id] = [];
      }
      socketTransports[socket.id]!.push(transport.id);

      console.log(
        `Transport created (${type}) for ${socket.id}:`,
        transport.id,
      );
      console.log(
        `Socket ${socket.id} now has transports:`,
        socketTransports[socket.id],
      );

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    });

    socket.on(
      "connectTransport",
      async ({ transportId, dtlsParameters }, callback) => {
        const transport = transports[transportId];
        if (!transport) {
          console.error("Transport not found:", transportId);
          throw new Error("Transport not found");
        }

        await transport.connect({ dtlsParameters });
        console.log("Transport connected:", transportId);
        callback();
      },
    );

    socket.on(
      "produce",
      async ({ kind, rtpParameters, transportId, appData }, callback) => {
        let selectedTransportId = transportId;

        if (!selectedTransportId) {
          selectedTransportId = socketTransports[socket.id]?.[0];
        }

        if (!selectedTransportId) {
          throw new Error("No transport found for this socket");
        }

        const transport = transports[selectedTransportId];
        if (!transport) {
          throw new Error("Transport not found");
        }

        console.log(
          `Producing on transport ${selectedTransportId} for socket ${socket.id}`,
        );

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
        });
        producers[producer.id] = { producer, transportId: selectedTransportId };

        io.emit("newProducer", {
          producerId: producer.id,
          userName: userMap[socket.id]?.name,
          source: producer.appData.source,
        });

        callback({ id: producer.id });
      },
    );

    socket.on("getProducers", (_unused, callback) => {
      const allProducers = Array.from(Object.values(producers))
        .filter((data) => {
          const producerSocketId = Object.entries(socketTransports).find(
            ([, transportIds]) => transportIds.includes(data.transportId),
          )?.[0];
          return producerSocketId !== socket.id;
        })
        .map((data) => ({
          producerId: data.producer.id,
          socketId: Object.entries(socketTransports).find(([, transportIds]) =>
            transportIds.includes(data.transportId),
          )?.[0],
          source: data.producer.appData.source,
        }));

      callback(allProducers);
    });

    socket.on(
      "consume",
      async ({ producerId, rtpCapabilities, transportId }, callback) => {
        const producerData = producers[producerId];
        if (!producerData) {
          console.error("Producer not found:", producerId);
          throw new Error("Producer not found");
        }

        if (!router) {
          throw new Error("Router not initialized");
        }

        if (!router.canConsume({ producerId, rtpCapabilities })) {
          console.error("Cannot consume - incompatible RTP capabilities");
          return callback({ error: "Cannot consume" });
        }

        let selectedTransportId = transportId;

        if (!selectedTransportId) {
          const ids = socketTransports[socket.id] || [];
          selectedTransportId = ids[ids.length - 1];
          console.log(
            "No transport specified, using last one:",
            selectedTransportId,
          );
        }

        if (!selectedTransportId) {
          throw new Error("No transport found for this socket");
        }

        const transport = transports[selectedTransportId];
        if (!transport) {
          console.error("Transport not found:", selectedTransportId);
          throw new Error("Transport not found");
        }

        console.log(`Using transport ${selectedTransportId} for consuming`);
        console.log(`Transport state:`, {
          id: transport.id,
          closed: transport.closed,
          dtlsState: transport.dtlsState,
        });

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        consumers[consumer.id] = { consumer, transportId: selectedTransportId };

        console.log(
          "Consumer created:",
          consumer.id,
          "for socket:",
          socket.id,
          "kind:",
          consumer.kind,
          "on transport:",
          selectedTransportId,
        );

        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      },
    );

    socket.on("producerClosed", (data) => {
      console.log("PRODUCER CLOSED", data);

      socket.broadcast.emit("endScreenShare", data);
    });

    socket.on("resumeConsumer", async ({ consumerId }, callback) => {
      const consumerData = consumers[consumerId];
      if (consumerData) {
        await consumerData.consumer.resume();
        console.log("Consumer resumed:", consumerId);
      } else {
        console.error("Consumer not found for resume:", consumerId);
      }
      callback();
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);

      const transportIds = socketTransports[socket.id] || [];
      transportIds.forEach((id) => {
        const transport = transports[id];
        if (transport) {
          transport.close();
          delete transports[id];
        }
      });
      delete socketTransports[socket.id];

      Object.entries(producers).forEach(([id, data]) => {
        if (transportIds.includes(data.transportId)) {
          data.producer.close();
          delete producers[id];

          // Notify other clients that this producer is gone
          socket.broadcast.emit("producerClosed", { producerId: id });
        }
      });

      Object.entries(consumers).forEach(([id, data]) => {
        if (transportIds.includes(data.transportId)) {
          data.consumer.close();
          delete consumers[id];
        }
      });
    });
  });

  server.listen(4000, () => {
    console.log("SFU Server running on http://localhost:4000");
  });
}

startServer().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
