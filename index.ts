import { Server, Socket } from "socket.io";
import fs from "fs";
import express from "express";
import { createServer } from "http";
import { v4 as uuidv4 } from "uuid";

// Define types

interface RGB {
    r: number;
    g: number;
    b: number;
}

interface Image {
    width: number;
    height: number;
    data: RGB[][];
}

interface Client {
    id: string;
    socket: Socket;
    isReady: boolean;
}

interface GenerationSnapshot {
    generationId: string;
    imageSequence: Image[];
}

// Helpers

const createGrayImage = (width: number, height: number): Image => ({
    width,
    height,
    data: Array.from({ length: height }).map(() => Array.from({ length: width }).map(() => ({ r: 0.5, g: 0.5, b: 0.5 })))
});

const createRandomImage = (width: number, height: number): Image => ({
    width,
    height,
    data: Array.from({ length: height }).map(() => Array.from({ length: width }).map(() => ({
        r: Math.random(),
        g: Math.random(),
        b: Math.random(),
    })))
});

const loadImageFromJSONFile = (path: string): Image => {
    // [R, G, B][][] where R, G, B are numbers between 0 and 1
    const imageData: [number, number, number][][] = JSON.parse(fs.readFileSync(path, 'utf8'))
    const height = imageData.length;
    const width = imageData[0].length;
    const formattedImageData = imageData.map(row => row.map(([r, g, b]) => ({ r, g, b })));
    const image = {
        width,
        height,
        data: formattedImageData,
    }
    const [isValid, invalidReason] = validateImage(image);
    if(!isValid) {
        throw new Error(invalidReason.error);
    } else {
        console.log(`Loaded image from ${path}: ${width}x${height}`)
    }
    return image;
}

const getNextClient = (clients: Client[],
    clientIdsAlreadyUsed: Set<string> = new Set<string>()
): Client | undefined => {
    // randomly choose next client but make sure it has not been used yet
    const availableClients = clients.filter(c => c.isReady && !clientIdsAlreadyUsed.has(c.id));
    if (availableClients.length === 0) {
        return undefined;
    }
    const randomIndex = Math.floor(Math.random() * availableClients.length);
    return availableClients[randomIndex];
}

const hasNextClient = (clients: Client[],
    clientIdsAlreadyUsed: Set<string> = new Set<string>()
): boolean => {
    return clients.some(c => c.isReady && !clientIdsAlreadyUsed.has(c.id));
}


// Server

const app = express();
app.use(express.static("public"));

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // You might want to restrict the origins in production
    },
});

let clients: Client[] = [];
let generationSnapshots: GenerationSnapshot[] = [];

/*
 * Function to cap the number of snapshots at 500
 */
function insertGenerationSnapshot(snapshot: GenerationSnapshot) {
    generationSnapshots = [...generationSnapshots, snapshot];
    if (generationSnapshots.length > 500) {
        generationSnapshots = generationSnapshots.slice(generationSnapshots.length - 500);
    }
}

io.of("/worker").on("connection", (socket: Socket) => {
    const client: Client = {
        id: uuidv4(),
        socket,
        isReady: false,
    };

    console.log(`Client ${client.id} connected`)

    clients = [...clients, client];

    socket.on("set-ready", ({ isReady }) => {
        console.log(`Client ${client.id} updated ready state to ${isReady}`)
        client.isReady = isReady;
    });

    socket.on("processed-image", (image: RGB[][]) => {
        // Logic to handle received image and send it to the next client or admin UI
    });

    socket.on("disconnect", (reason) => {
        console.log(`Client ${client.id} disconnected because of ${reason}`)
        clients = clients.filter(c => c.id !== client.id);
    });
});

//let startingImage = createGrayImage(100, 100);
let startingImage = loadImageFromJSONFile('blaine.json');
//let startingImage = createRandomImage(100, 100);

interface InvalidReason {
    coordinates: [number, number];
    error: string;
}

function validateImage(image: Image): [false, InvalidReason] | [true, null] {
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
    const generationId = uuidv4();
    const imageSequence: Image[] = [];
    const clientIdsAlreadyUsed = new Set<string>();

    if(!hasNextClient(clients)) {
        console.log("No clients available, generation sequence aborted");
        return;
    }

    const processImage = (image: Image) => {
        const client = getNextClient(clients, clientIdsAlreadyUsed);
        if (!client) {
            console.log("No clients available, generation sequence completed");
            startingImage = imageSequence[imageSequence.length - 1];
            io.of("/admin").emit("generation-completed", {
                generationId,
                imageSequence,
            });
            insertGenerationSnapshot({ generationId, imageSequence });
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

        client.socket.once("processed-image", (newImage: Image) => {
            console.log(`Received processed image from client ${client.id}`);

            try {
                const [isValid, invalidReason] = validateImage(newImage);
                if(isValid) {
                    clientIdsAlreadyUsed.add(client.id);
                    clearTimeout(timeout);
                    imageSequence.push(newImage);

                    client.isReady = true; // Mark client as ready again
                    processImage(newImage); // Continue the sequence with the processed image
                } else {
                    throw new Error(invalidReason.error);
                }
            } catch (error: any) {
                console.log(`Received invalid image from client ${client.id}`);
                // Retry with the same image
                // The current worker would have never responded so they will be marked
                // as not ready and will not receive the image again
                client.socket.emit('update-ready', { isReady: false });
                console.log(error)
                client.socket.emit('invalid-image', { coordinates: [0, 0], error: error.message });
                processImage(image);
            }
        });
    };

    imageSequence.push(startingImage);
    processImage(startingImage); // Start the sequence with a gray image
};

// Every minute, initiate generation sequence
setInterval(initiateGenerationSequence, 5000);

io.of("/admin").on("connection", (socket: Socket) => {
    console.log('Admin UI connected')
    socket.on("manual-start", () => {
        initiateGenerationSequence();
    });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`)
});
