import express from "express";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import mediasoup from "mediasoup";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());

const server = new http.Server(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

console.log(process.env.PUBLIC_IP);

let router: mediasoup.types.Router | undefined;
const workers: mediasoup.types.Worker[] = [];

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
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
      },
    ],
  });

  return { worker, router };
}

async function startServer() {
  const { worker, router: createdRouter } = await createWorker();
  workers.push(worker);
  router = createdRouter;

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

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
        listenIps: [
          { ip: "0.0.0.0", announcedIp: process.env.PUBLIC_IP || "127.0.0.1" },
        ],
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
      async ({ kind, rtpParameters, transportId }, callback) => {
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

        const producer = await transport.produce({ kind, rtpParameters });
        producers[producer.id] = { producer, transportId: selectedTransportId };

        console.log(
          "Producer created:",
          producer.id,
          "for socket:",
          socket.id,
          "kind:",
          kind,
        );

        // Notify all other clients about the new producer
        socket.broadcast.emit("newProducer", {
          producerId: producer.id,
        });

        callback({ id: producer.id });
      },
    );

    socket.on("getProducers", (_, callback) => {
      const allProducers = Object.entries(producers)
        .filter(([_, data]) => {
          const producerSocketId = Object.entries(socketTransports).find(
            ([_, transportIds]) => transportIds.includes(data.transportId),
          )?.[0];
          return producerSocketId !== socket.id;
        })
        .map(([id, _]) => ({ producerId: id }));

      callback(allProducers);
    });

    socket.on(
      "consume",
      async ({ producerId, rtpCapabilities, transportId }, callback) => {
        console.log("=== CONSUME REQUEST ===");
        console.log("Producer ID:", producerId);
        console.log("Requested transport ID:", transportId);
        console.log(
          "Available transports for socket:",
          socketTransports[socket.id],
        );

        const producerData = producers[producerId];
        if (!producerData) {
          console.error("Producer not found:", producerId);
          throw new Error("Producer not found");
        }

        if (!router) {
          throw new Error("Router not initialized");
        }

        // Check if router can consume
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

      // Clean up all transports for this socket
      const transportIds = socketTransports[socket.id] || [];
      transportIds.forEach((id) => {
        const transport = transports[id];
        if (transport) {
          transport.close();
          delete transports[id];
        }
      });
      delete socketTransports[socket.id];

      // Clean up producers
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

startServer();
