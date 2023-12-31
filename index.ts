import { Server, Socket } from "socket.io";
import fs from "fs";
import express from "express";
import { createServer } from "http";
import { v4 as uuidv4 } from "uuid";
import { compressToUTF16, decompressFromUTF16 } from 'lz-string'
import sharp from 'sharp'

// Unique id for this execution
const executionId = uuidv4();

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
    data: Array.from({ length: height }).map(() => Array.from({ length: width }).map(() => ({ r: 0.2, g: 0.2, b: 0.2 })))
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
    generationSnapshots.push(snapshot);
    writeSnapshotToDisk(snapshot, `./public/snapshots/${executionId}`);
    if (generationSnapshots.length > 100) {
        generationSnapshots = generationSnapshots.slice(generationSnapshots.length - 500);
    }
}

/*
 * Write each image in each snapshot to disk.
 * Organize into folders:
 * 1. group by execution id
 * 2. group by generation id
 * 3. and finally one .png file per image
 *
 * This function may be called many times and should only write new snapshots to disk.
 */
function writeSnapshotToDisk(snapshot: GenerationSnapshot, path: string) {
    const generationId = snapshot.generationId;
    fs.mkdirSync(path, { recursive: true });
    snapshot.imageSequence.forEach((image, index) => {
        const filename = `${generationId}-${index}.png`;
        const filepath = `${path}/${filename}`;
        // ensure the directory exists

        if (!fs.existsSync(filepath)) {
            sharp(Buffer.from(image.data.flat().map(pixel => [pixel.r * 255, pixel.g * 255, pixel.b * 255]).flat()), {
                raw: {
                    width: image.width,
                    height: image.height,
                    channels: 3,
                }
            })
                .png()
                .toFile(filepath)
                .then(() => {
                    console.log(`Wrote image to ${filepath}`);
                })
                .catch((error) => {
                    console.log(`Error writing image to ${filepath}: ${error}`);
                });
        }
    });
}

let startingImage = createGrayImage(100, 100);
//let startingImage = loadImageFromJSONFile('blaine.json');
//let startingImage = createRandomImage(100, 100);

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

    socket.on("get-image", (callback) => {
        callback(compressToUTF16(JSON.stringify(startingImage)));
    })
});

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


let isRunning = false

const initiateGenerationSequence = () => {
    if(isRunning) {
        console.log("Generation sequence already running");
        return;
    }
    console.log("Initiating generation sequence");
    isRunning = true;
    const generationId = uuidv4();
    const imageSequence: Image[] = [];
    const clientIdsAlreadyUsed = new Set<string>();

    if(!hasNextClient(clients)) {
        isRunning = false;
        console.log("No clients available, generation sequence aborted");
        return;
    }

    const processImage = (image: Image) => {
        const client = getNextClient(clients, clientIdsAlreadyUsed);
        if (!client) {
            console.log("No clients available, generation sequence completed");
            isRunning = false;
            startingImage = imageSequence[imageSequence.length - 1];
            const repeat = (arr: any, n: any) => [].concat(...Array(n).fill(arr));
            io.of("/admin").emit("generation-completed", {
                generationId,
                imageSequence: repeat(imageSequence.map(image => (
                    compressToUTF16(JSON.stringify(image))
                )), 1),
            });
            insertGenerationSnapshot({ generationId, imageSequence });
            return;
        }

        client.isReady = false; // Mark client as not ready for now
        console.log(`Sending image to client ${client.id}`);
        client.socket.emit("process-image", compressToUTF16(JSON.stringify(image)));

        const timeout = setTimeout(() => {
            // Retry with the same image
            // The current worker would have never responded so they will be marked
            // as not ready and will not receive the image again
            client.socket.emit('update-ready', { isReady: false });
            processImage(image);
        }, 5000);

        client.socket.once("processed-image", (compressedImage: string) => {
            console.log(`Received processed image from client ${client.id}`);

            const newImage = JSON.parse(decompressFromUTF16(compressedImage));

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

    // On connect, send the last 10 generation snapshots via the `generation-completed` event
    generationSnapshots.slice(generationSnapshots.length - 10).forEach(snapshot => {
        socket.emit("generation-completed", {
            generationId: snapshot.generationId,
            imageSequence: snapshot.imageSequence.map(image => (
                compressToUTF16(JSON.stringify(image))
            )),
        });
    });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`)
});
