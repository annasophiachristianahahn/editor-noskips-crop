// Helper: Append progress messages into the status div
function updateProgress(message) {
  const statusDiv = document.getElementById('status');
  const p = document.createElement('p');
  p.textContent = message;
  statusDiv.appendChild(p);
  statusDiv.scrollTop = statusDiv.scrollHeight;
}

document.getElementById('start-button').addEventListener('click', async () => {
  const files = document.getElementById('video-files').files;
  const finalLength = parseInt(document.getElementById('final-length').value);
  const minClipLength = parseInt(document.getElementById('min-clip-length').value);
  const maxClipLength = parseInt(document.getElementById('max-clip-length').value);
  const zoomProbability = parseFloat(document.getElementById('zoom-probability').value);
  const minZoom = parseFloat(document.getElementById('min-zoom').value);
  const maxZoom = parseFloat(document.getElementById('max-zoom').value);
  const finalWidth = parseInt(document.getElementById('final-width').value);
  const finalHeight = parseInt(document.getElementById('final-height').value);

  // Clear previous status messages and hide download button
  document.getElementById('status').innerHTML = '';
  document.getElementById('download-button').style.display = 'none';

  if (!files.length) {
    updateProgress('Error: Please select at least one video file.');
    return;
  }

  if (
    isNaN(finalLength) ||
    isNaN(minClipLength) ||
    isNaN(maxClipLength) ||
    minClipLength > maxClipLength ||
    isNaN(zoomProbability) ||
    isNaN(minZoom) ||
    isNaN(maxZoom) ||
    minZoom > maxZoom
  ) {
    updateProgress('Error: Please enter valid numeric values.');
    return;
  }

  updateProgress('Starting video editing process...');
  await processVideos(files, finalLength, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom, finalWidth, finalHeight);
});

async function processVideos(files, finalLength, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom, finalWidth, finalHeight) {
  updateProgress('Initializing processing...');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const chunks = [];

  // Use a captureStream frame rate of 30 FPS (can be adjusted)
  const stream = canvas.captureStream(30);

  // Use H.264 codec and set a bitrate of 8 Mbps (8,000,000 bps)
  let options = {
    mimeType: 'video/mp4; codecs="avc1.42E01E"',
    videoBitsPerSecond: 8000000
  };

  let recorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (e) {
    updateProgress('H.264 configuration not supported, using default settings.');
    recorder = new MediaRecorder(stream);
  }

  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const videoURL = URL.createObjectURL(blob);
    const outputVideo = document.getElementById('output-video');
    outputVideo.src = videoURL;
    updateProgress('Video processing completed.');

    // Show and configure the DOWNLOAD button
    const downloadBtn = document.getElementById('download-button');
    downloadBtn.style.display = 'block';
    downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = videoURL;
      a.download = 'final_video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
  };

  // Build randomized clip configurations until total duration reaches finalLength
  let totalDuration = 0;
  let lastFile = null;
  const clipConfs = [];
  const filesArray = Array.from(files);
  updateProgress('Building clip configurations...');
  while (totalDuration < finalLength) {
    let candidate;
    do {
      candidate = filesArray[Math.floor(Math.random() * filesArray.length)];
    } while (filesArray.length > 1 && candidate === lastFile);
    const randFile = candidate;

    const duration = await getVideoDuration(randFile);
    const clipLength = getRandomClipLength(minClipLength, maxClipLength, duration);
    const startTime = getRandomStartTime(duration, clipLength);
    clipConfs.push({ file: randFile, startTime, clipLength });
    totalDuration += clipLength;
    lastFile = randFile;
    updateProgress(`Added clip from ${randFile.name}: start=${startTime.toFixed(2)}s, length=${clipLength.toFixed(2)}s. Total duration: ${totalDuration.toFixed(2)}s`);
  }

  // Create 4 video elements for a larger preloading pipeline
  const videoPlayers = [];
  for (let i = 0; i < 4; i++) {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    videoPlayers.push(video);
  }

  // Preload initial clips into the video players.
  if (clipConfs.length === 0) {
    updateProgress('No clips to process.');
    return;
  }
  // Preload the first clip into slot 0 and set canvas dimensions.
  const firstClip = clipConfs.shift();
  updateProgress(`Preloading first clip from ${firstClip.file.name} (start: ${firstClip.startTime.toFixed(2)}s, length: ${firstClip.clipLength.toFixed(2)}s) into slot 0`);
  await preloadClip(videoPlayers[0], firstClip.file, firstClip.startTime, firstClip.clipLength);
  videoPlayers[0].clipConf = firstClip;
  
  // Set canvas dimensions to the final dimensions
  canvas.width = finalWidth;
  canvas.height = finalHeight;

  // Preload remaining clips into slots 1 to 3, if available.
  for (let i = 1; i < videoPlayers.length; i++) {
    if (clipConfs.length > 0) {
      const clip = clipConfs.shift();
      updateProgress(`Preloading clip from ${clip.file.name} (start: ${clip.startTime.toFixed(2)}s, length: ${clip.clipLength.toFixed(2)}s) into slot ${i}`);
      await preloadClip(videoPlayers[i], clip.file, clip.startTime, clip.clipLength);
      videoPlayers[i].clipConf = clip;
    }
  }

  recorder.start();
  updateProgress('Recording started.');

  let currentPlayerIndex = 0;
  let previousClip = null;
  let recordedDuration = 0;
  
  while (recordedDuration < finalLength) {
    const currentVideo = videoPlayers[currentPlayerIndex];
    const currentClip = currentVideo.clipConf;
    
    // Start playing current clip
    const playPromise = playActiveClip(
        currentVideo, 
        currentClip, 
        canvas, 
        ctx, 
        { zoomProbability, minZoom, maxZoom },
        previousClip, // Pass the previous clip info
        finalWidth,
        finalHeight
    );

    // Preload next clip if available
    if (clipConfs.length > 0) {
        const upcoming = clipConfs.shift();
        await preloadClip(
            videoPlayers[(currentPlayerIndex + 1) % videoPlayers.length], 
            upcoming.file, 
            upcoming.startTime, 
            upcoming.clipLength
        );
        videoPlayers[(currentPlayerIndex + 1) % videoPlayers.length].clipConf = upcoming;
    }

    // Wait for current clip to finish
    await playPromise;
    
    recordedDuration += currentClip.clipLength;
    
    if (clipConfs.length === 0) break;
    
    previousClip = {
        video: currentVideo,
        conf: currentClip
    };
    currentPlayerIndex = (currentPlayerIndex + 1) % videoPlayers.length;
  }

  recorder.stop();
  updateProgress('Recording stopped.');
}

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const tempVideo = document.createElement('video');
    tempVideo.src = URL.createObjectURL(file);
    tempVideo.onloadedmetadata = () => resolve(tempVideo.duration);
  });
}

function getRandomClipLength(minClipLength, maxClipLength, duration) {
  const minLength = (minClipLength / 100) * duration;
  const maxLength = (maxClipLength / 100) * duration;
  return Math.random() * (maxLength - minLength) + minLength;
}

function getRandomStartTime(duration, clipLength) {
  return Math.random() * (duration - clipLength);
}

// Preload a clip: set the source and currentTime, and resolve when the seek completes
function preloadClip(video, file, startTime, clipLength) {
  return new Promise((resolve, reject) => {
    video.src = URL.createObjectURL(file);
    video.currentTime = startTime;
    video.onloadedmetadata = () => {
      video.onseeked = () => resolve();
      video.onerror = (e) => reject(e);
    };
    video.onerror = (e) => reject(e);
  });
}

// Play the clip by drawing frames from the active video onto the canvas
function playActiveClip(video, clipConf, canvas, ctx, zoomConfig, previousClip, finalWidth, finalHeight) {
  return new Promise((resolve, reject) => {
    const { startTime, clipLength, file } = clipConf;
    const endTime = startTime + clipLength;
    const overlapDuration = 1.0; // 1 second overlap
    
    let applyZoom = Math.random() < (zoomConfig.zoomProbability / 100);
    let zoomFactor = 1;
    let sx = 0, sy = 0;

    if (applyZoom) {
      zoomFactor = Math.random() * ((zoomConfig.maxZoom - zoomConfig.minZoom) / 100) + (zoomConfig.minZoom / 100);
      const srcWidth = canvas.width / zoomFactor;
      const srcHeight = canvas.height / zoomFactor;
      sx = Math.random() * (canvas.width - srcWidth);
      sy = Math.random() * (canvas.height - srcHeight);
      updateProgress(`Applied zoom on ${file.name}: ${(zoomFactor * 100).toFixed(0)}% (random crop at x:${sx.toFixed(0)}, y:${sy.toFixed(0)})`);
    }

    video.play().then(() => {
      const drawFrame = () => {
        // Clear canvas on each frame
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // If we have a previous clip and we're in the overlap period
        if (previousClip && video.currentTime < startTime + overlapDuration) {
          const previousVideo = previousClip.video;
          // Draw the previous clip underneath
          
          // Calculate source and destination dimensions for cropping/scaling previous video
          let sourceWidth = previousVideo.videoWidth;
          let sourceHeight = previousVideo.videoHeight;
          let sourceX = 0;
          let sourceY = 0;
          let destWidth = finalWidth;
          let destHeight = finalHeight;

          const videoAspectRatio = sourceWidth / sourceHeight;
          const canvasAspectRatio = finalWidth / finalHeight;

          if (videoAspectRatio > canvasAspectRatio) {
              // Video is wider than the canvas, crop the sides
              sourceWidth = sourceHeight * canvasAspectRatio;
              sourceX = (previousVideo.videoWidth - sourceWidth) / 2;
          } else {
              // Video is taller than the canvas, crop the top and bottom
              sourceHeight = sourceWidth / canvasAspectRatio;
              sourceY = (previousVideo.videoHeight - sourceHeight) / 2;
          }

          ctx.drawImage(
              previousVideo,
              sourceX, sourceY, sourceWidth, sourceHeight,
              0, 0, destWidth, destHeight
          );
        }

        // Draw current clip
        
        // Calculate source and destination dimensions for cropping/scaling current video
        let sourceWidth = video.videoWidth;
        let sourceHeight = video.videoHeight;
        let sourceX = 0;
        let sourceY = 0;
        let destWidth = finalWidth;
        let destHeight = finalHeight;

        const videoAspectRatio = sourceWidth / sourceHeight;
        const canvasAspectRatio = finalWidth / finalHeight;

        if (videoAspectRatio > canvasAspectRatio) {
            // Video is wider than the canvas, crop the sides
            sourceWidth = sourceHeight * canvasAspectRatio;
            sourceX = (video.videoWidth - sourceWidth) / 2;
        } else {
            // Video is taller than the canvas, crop the top and bottom
            sourceHeight = sourceWidth / canvasAspectRatio;
            sourceY = (video.videoHeight - sourceHeight) / 2;
        }

        if (zoomFactor > 1) {
          const srcWidth = video.videoWidth / zoomFactor;
          const srcHeight = video.videoHeight / zoomFactor;
          const zoomX = Math.max(0, Math.min(sx, video.videoWidth - srcWidth));
          const zoomY = Math.max(0, Math.min(sy, video.videoHeight - srcHeight));
          ctx.drawImage(video, zoomX, zoomY, srcWidth, srcHeight, 0, 0, canvas.width, canvas.height);
        } else {
          ctx.drawImage(
              video,
              sourceX, sourceY, sourceWidth, sourceHeight,
              0, 0, destWidth, destHeight
          );
        }

        if (video.currentTime >= endTime) {
          resolve();
        } else {
          requestAnimationFrame(drawFrame);
        }
      };
      
      drawFrame();
    }).catch((e) => {
      updateProgress(`Error playing clip from file ${file.name}: ${e.message}`);
      console.error(`Error playing clip from file: ${file.name}`, e);
      reject(e);
    });
  });
}