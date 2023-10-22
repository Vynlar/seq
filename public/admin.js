const socket = io.connect('http://localhost:3000/admin'); // Connect to the admin namespace
const imageSequencesContainer = document.getElementById('image-sequence');

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

document.getElementById('manual-start').addEventListener('click', () => {
  socket.emit('manual-start');
});

socket.on('*', (event, ...args) => {
  console.log('event', event, args);
})

socket.on('generation-completed', ({ imageSequence }) => {
  console.log('generation completed', imageSequence)

  const imageSequenceContainer = document.createElement('div');
  imageSequencesContainer.insertBefore(imageSequenceContainer, imageSequencesContainer.firstChild);
  imageSequenceContainer.classList.add('image-sequence');

  for (const imageData of imageSequence) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    drawImageOnCanvas(imageData, canvas);
    imageSequenceContainer.appendChild(canvas);
  }
});
