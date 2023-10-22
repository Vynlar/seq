const socket = io.connect('/worker'); // Connect to the server
const userCodeTextarea = document.getElementById('user-code');
const originalCanvas = document.getElementById('original-image');
const processedCanvas = document.getElementById('processed-image');
const exception = document.getElementById('exception');

// Initialize with some sample code if there's nothing in local storage
const sampleCode = `
  // This is the function that will be called for each image
  // The image is a 2D array of pixels, each pixel is an object with r, g, b values
  // The function should return a 2D array of pixels, each pixel is an object with r, g, b values
  function processImage({ width, height, data }) {
    // This is a sample function that inverts the image
    return data.map(row => row.map(pixel => ({
      r: 1 - pixel.r,
      g: 1 - pixel.g,
      b: 1 - pixel.b,
    })));
  }
`;
userCodeTextarea.value = sessionStorage.getItem('user-code') || sampleCode;

// Add an event listener to userCodeTextarea that stores the user's code in localStorage
userCodeTextarea.addEventListener('input', () => {
  socket.emit('set-ready', { isReady: false });
  updateReadyStatus(false);
  sessionStorage.setItem('user-code', userCodeTextarea.value);
});

// Sample test images. You can replace these with real images
const [r, g, b] = [Math.random(), Math.random(), Math.random()]
const testImages = [
  // Here, we're generating 100x100 gray images, similar to the server, for testing purposes.
  Array.from({ length: 100 }).map(() => Array.from({ length: 100 }).map(() => ({ r, g, b })))
];

function drawImageOnCanvas(imageData, canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(imageData.width, imageData.height);

  let i = 0;
  for (const row of imageData.data) {
    for (const { r, g, b } of row) {
      imgData.data[i++] = r * 255;
      imgData.data[i++] = g * 255;
      imgData.data[i++] = b * 255;
      imgData.data[i++] = 255; // alpha
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function runUserProgram(image) {
  try {
    const userFunction = new Function('imageData', userCodeTextarea.value + ';window.processImage = processImage;');
    userFunction();
    return window.processImage(image)
  } catch (e) {
    console.error(e);
    exception.innerHTML = e;
  }
}

document.getElementById('test-code').addEventListener('click', () => {
  const originalImageData = testImages[0]; // Pick the first test image for now
  const originalImage = { width: 100, height: 100, data: originalImageData }
  drawImageOnCanvas(originalImage, originalCanvas);

  const processedImage = runUserProgram(originalImage);
  drawImageOnCanvas({ width: 100, height: 100, data: processedImage }, processedCanvas);
});

document.getElementById('set-ready').addEventListener('click', () => {
  socket.emit('set-ready', { isReady: true });
  updateReadyStatus(true);
});

function updateReadyStatus(isReady) {
  document.getElementById('ready').innerHTML = isReady ? 'Running' : 'Not running';
}

socket.on('update-ready', ({ isReady }) => {
  updateReadyStatus(isReady);
})

/*
 * interface InvalidReason {
    coordinates: [number, number];
    error: string;
}
 */
socket.on('invalid-image', (invalidReason) => {
  exception.innerHTML = `Invalid image at (${invalidReason.coordinates[0]}, ${invalidReason.coordinates[1]}): ${invalidReason.error}`;
})

socket.on('process-image', (image) => {
  try {
    console.log(image)
    const processedImage = runUserProgram(image);
    socket.emit('processed-image', {
      ...image,
      data: processedImage
    });
  } catch (error) {
    console.error("Error processing the image:", error);
    socket.emit('error-processing');
  }
});