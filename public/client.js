const socket = io.connect('/worker'); // Connect to the server
const originalCanvas = document.getElementById('original-image');
const processedCanvas = document.getElementById('processed-image');
const exception = document.getElementById('exception');
const validationError = document.getElementById('validation-error');

const editor = ace.edit("user-code");
editor.setTheme("ace/theme/monokai");
editor.session.setMode("ace/mode/javascript");

// Initialize with some sample code if there's nothing in local storage
const sampleCode = `
  function processImage({ width, height, data }) {
    // Initialize the new data array
    let newData = [];

    // Loop over each row
    for (let i = 0; i < data.length; i++) {
      // Initialize a new row
      let newRow = [];

      // Loop over each pixel in the row
      for (let j = 0; j < data[i].length; j++) {
        let pixel = data[i][j];

        // Invert the colors of the pixel
        newRow.push({
          r: 1 - pixel.r,
          g: 1 - pixel.g,
          b: 1 - pixel.b
        });
      }

      // Add the new row to the new data array
      newData.push(newRow);
    }

    return newData;
  }
`;

editor.setValue(sessionStorage.getItem('user-code') || sampleCode)

function resetCode() {
  editor.setValue(sampleCode);
  sessionStorage.setItem('user-code', sampleCode);
}

document.getElementById('reset-code').addEventListener('click', () => {
  const result = confirm('Are you sure you want to reset your code?');
  if (result) resetCode()
});

// copy prompt to clickboard
document.getElementById('copy-prompt').addEventListener('click', () => {
  navigator.clipboard.writeText(`You are a generative artist tasked with writing a function that takes the pixel data of an image and modifies to produce a new image.

Write a javascript function, \`processImage\` that receives an object of the following shape:
\`\`\`
{
  width: number // number of pixels wide for the input and output
  height: number // number of pixels tall
  data: [number, number, number][][] // 3-tuples, RGB, ranging from 0 to 1 containing the image data
}
\`\`\`

The function must return a modified copy of the \`data\` object representing the modified image of the same dimensions.


Here is an example of such a function:
\`\`\`
// This is a sample function that inverts the image
function processImage({ width, height, data }) {
    return data.map(row => row.map(pixel => ({
        r: 1 - pixel.r,
        g: 1 - pixel.g,
        b: 1 - pixel.b,
    })));
}
\`\`\`

Your collaborator has requested that you write a function that does the following to the image:

<enter your prompt here>
`);
});

// Add an event listener to the editor that stores the user's code in localStorage
editor.session.on('change', () => {
  socket.emit('set-ready', { isReady: false });
  updateReadyStatus(false);
  sessionStorage.setItem('user-code', editor.getValue());
})

// Sample test images. You can replace these with real images
const [r, g, b] = [Math.random(), Math.random(), Math.random()]
const testImages = [
  // Here, we're generating 100x100 gray images, similar to the server, for testing purposes.
  Array.from({ length: 100 }).map(() => Array.from({ length: 100 }).map(() => ({ r, g, b }))),
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
    const userFunction = new Function('imageData', editor.getValue() + ';window.processImage = processImage;');
    userFunction();
    return window.processImage(image)
  } catch (e) {
    console.error(e);
    exception.innerHTML = e;
  }
}

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

document.getElementById('test-code').addEventListener('click', () => {
  // clear the error messages
  exception.innerHTML = '';
  validationError.innerHTML = '';
  // Fetch the latest image from the server
  socket.emit('get-image', (compressedImage) => {
    const originalImage = JSON.parse(LZString.decompressFromUTF16(compressedImage))
    drawImageOnCanvas(originalImage, originalCanvas);

    const processedImage = runUserProgram(originalImage);
    try {
      const [isValid, reason] = validateImage({ width: 100, height: 100, data: processedImage });
      if (!isValid) {
        validationError.innerHTML = "Validation error: " + JSON.stringify(reason);
        return
      }
      drawImageOnCanvas({ width: 100, height: 100, data: processedImage }, processedCanvas);
    } catch (e) {
      validationError.innerHTML = "Erorr validating the image: " + e;
    }
  });
});

document.getElementById('set-ready').addEventListener('click', () => {
  socket.emit('set-ready', { isReady: true });
  updateReadyStatus(true);
  exception.innerHTML = '';
  validationError.innerHTML = '';
});

function updateReadyStatus(isReady) {
  const readyElement = document.getElementById('ready');
  readyElement.innerHTML = isReady ? 'Running' : 'Not running';
  if (isReady) {
    readyElement.classList.add('text-green-600');
    readyElement.classList.remove('text-red-600');
  } else {
    readyElement.classList.add('text-red-600');
    readyElement.classList.remove('text-green-600');
  }

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
  validationError.innerHTML = `Server says: Invalid image at (${invalidReason.coordinates[0]}, ${invalidReason.coordinates[1]}): ${invalidReason.error}`;
})

socket.on('process-image', (compressedImage) => {
  const image = JSON.parse(LZString.decompressFromUTF16(compressedImage))
  try {
    console.log(image)
    const processedImageData = runUserProgram(image);
    const compressedProcessedImage = LZString.compressToUTF16(JSON.stringify(
      {
        ...image,
        data: processedImageData,
      }));
    socket.emit('processed-image', compressedProcessedImage);
  } catch (error) {
    console.error("Error processing the image:", error);
    socket.emit('error-processing');
  }
});
