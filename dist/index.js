"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_1 = require("socket.io");
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const uuid_1 = require("uuid");
// Helpers
const createGrayImage = (width, height) => ({
    width,
    height,
    data: Array.from({ length: height }).map(() => Array.from({ length: width }).map(() => ({ r: 0.5, g: 0.5, b: 0.5 })))
});
const getNextClient = (clients, clientIdsAlreadyUsed = new Set()) => {
    // randomly choose next client but make sure it has not been used yet
    const availableClients = clients.filter(c => c.isReady && !clientIdsAlreadyUsed.has(c.id));
    if (availableClients.length === 0) {
        return undefined;
    }
    const randomIndex = Math.floor(Math.random() * availableClients.length);
    return availableClients[randomIndex];
};
const hasNextClient = (clients, clientIdsAlreadyUsed = new Set()) => {
    return clients.some(c => c.isReady && !clientIdsAlreadyUsed.has(c.id));
};
// Server
const app = (0, express_1.default)();
app.use(express_1.default.static("public"));
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*", // You might want to restrict the origins in production
    },
});
let clients = [];
let generationSnapshots = [];
io.of("/worker").on("connection", (socket) => {
    const client = {
        id: (0, uuid_1.v4)(),
        socket,
        isReady: false,
    };
    console.log(`Client ${client.id} connected`);
    clients = [...clients, client];
    socket.on("set-ready", ({ isReady }) => {
        console.log(`Client ${client.id} updated ready state to ${isReady}`);
        client.isReady = isReady;
    });
    socket.on("processed-image", (image) => {
        // Logic to handle received image and send it to the next client or admin UI
    });
    socket.on("disconnect", (reason) => {
        console.log(`Client ${client.id} disconnected because of ${reason}`);
        clients = clients.filter(c => c.id !== client.id);
    });
});
let startingImage = createGrayImage(100, 100);
function validateImage(image) {
    for (let y = 0; y < image.height; y++) {
        const row = image.data[y];
        for (let x = 0; x < image.width; x++) {
            const pixel = row[x];
            if (pixel.r < 0 || pixel.r > 1) {
                return [false, { coordinates: [x, y], error: `Invalid red value ${pixel.r}` }];
            }
            if (pixel.g < 0 || pixel.g > 1) {
                return [false, { coordinates: [x, y], error: `Invalid green value ${pixel.g}` }];
            }
            if (pixel.b < 0 || pixel.b > 1) {
                return [false, { coordinates: [x, y], error: `Invalid blue value ${pixel.b}` }];
            }
        }
    }
    return [true, null];
}
const initiateGenerationSequence = () => {
    console.log("Initiating generation sequence");
    const generationId = (0, uuid_1.v4)();
    const imageSequence = [];
    const clientIdsAlreadyUsed = new Set();
    if (!hasNextClient(clients)) {
        console.log("No clients available, generation sequence aborted");
        return;
    }
    const processImage = (image) => {
        const client = getNextClient(clients, clientIdsAlreadyUsed);
        if (!client) {
            console.log("No clients available, generation sequence completed");
            startingImage = imageSequence[imageSequence.length - 1];
            io.of("/admin").emit("generation-completed", {
                generationId,
                imageSequence,
            });
            generationSnapshots = [...generationSnapshots, { generationId, imageSequence }];
            return;
        }
        client.isReady = false; // Mark client as not ready for now
        console.log(`Sending image to client ${client.id}`);
        client.socket.emit("process-image", image);
        const timeout = setTimeout(() => {
            // Retry with the same image
            // The current worker would have never responded so they will be marked
            // as not ready and will not receive the image again
            client.socket.emit('update-ready', { isReady: false });
            processImage(image);
        }, 5000);
        client.socket.once("processed-image", (newImage) => {
            console.log(`Received processed image from client ${client.id}`);
            const [isValid, invalidReason] = validateImage(newImage);
            if (isValid) {
                clientIdsAlreadyUsed.add(client.id);
                clearTimeout(timeout);
                imageSequence.push(newImage);
                client.isReady = true; // Mark client as ready again
                processImage(newImage); // Continue the sequence with the processed image
            }
            else {
                console.log(`Received invalid image from client ${client.id}`);
                // Retry with the same image
                // The current worker would have never responded so they will be marked
                // as not ready and will not receive the image again
                client.socket.emit('update-ready', { isReady: false });
                client.socket.emit('invalid-image', invalidReason);
                processImage(image);
            }
        });
    };
    imageSequence.push(startingImage);
    processImage(startingImage); // Start the sequence with a gray image
};
// Every minute, initiate generation sequence
setInterval(initiateGenerationSequence, 5000);
io.of("/admin").on("connection", (socket) => {
    console.log('Admin UI connected');
    socket.on("manual-start", () => {
        initiateGenerationSequence();
    });
});
httpServer.listen(3000, () => {
    console.log("Server listening on port 3000");
});
