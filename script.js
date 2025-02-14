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
  // These two inputs now define the canvas dimensions
  const canvasWidth = parseInt(document.getElementById('final-width').value);
  const canvasHeight = parseInt(document.getElementById('final-length').value);
  
  // The final video duration is still taken from an input (assumed to be final-length in the original code).
  // (If you want to decouple canvas height and final video duration, use a separate input for duration.)
  const finalDuration = parseInt(document.getElementById('final-length').value);
  
  const minClipLength = parseInt(document.getElementById('min-clip-length').value);
  const maxClipLength = parseInt(document.getElementById('max-clip-length').value);
  const zoomProbability = parseFloat(document.getElementById('zoom-probability').value);
  const minZoom = parseFloat(document.getElementById('min-zoom').value);
  const maxZoom = parseFloat(document.getElementById('max-zoom').value);

  // Clear previous status messages and hide download button
  document.getElementById('status').innerHTML = '';
  document.getElementById('download-button').style.display = 'none';

  if (!files.length) {
    updateProgress('Error: Please select at least one video file.');
    return;
  }

  if (
    isNaN(finalDuration) ||
    isNaN(minClipLength) ||
    isNaN(maxClipLength) ||
    minClipLength > maxClipLength ||
    isNaN(zoomProbability) ||
    isNaN(minZoom) ||
    isNaN(maxZoom) ||
    minZoom > maxZoom ||
    isNaN(canvasWidth) ||
    isNaN(canvasHeight)
  ) {
    updateProgress('Error: Please enter valid numeric values.');
    return;
  }

  updateProgress('Starting video editing process...');
  await processVideos(files, finalDuration, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom, canvasWidth, canvasHeight);
});

async function processVideos(files, finalDuration, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom, canvasWidth, canvasHeight) {
  updateProgress('Initializing processing...');
  const canvas = document.createElement('canvas');
  // Set the canvas dimensions from the input values
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
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

  // Build randomized clip configurations until total duration reaches finalDuration
  let totalDuration = 0;
  let lastFile = null;
  const clipConfs = [];
  const filesArray = Array.from(files);
  updateProgress('Building clip configurations...');
  while (totalDuration < finalDuration) {
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
  // Preload the first clip into slot 0.
  const firstClip = clipConfs.shift();
  updateProgress(`Preloading first clip from ${firstClip.file.name} (start: ${firstClip.startTime.toFixed(2)}s, length: ${firstClip.clipLength.toFixed(2)}s) into slot 0`);
  await preloadClip(videoPlayers[0], firstClip.file, firstClip.startTime, firstClip.clipLength);
  videoPlayers[0].clipConf = firstClip;

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

  while (true) {
    const currentVideo = videoPlayers[currentPlayerIndex];
    const currentClip = currentVideo.clipConf;

    // Start playing current clip with our modified drawing (with proper cropping and zoom)
    const playPromise = playActiveClip(
      currentVideo,
      currentClip,
      canvas,
      ctx,
      { zoomProbability, minZoom, maxZoom },
      previousClip // Pass the previous clip info for overlap
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

    if (clipConfs.length === 0) break;

    previousClip = {
      video: currentVideo,
      conf: currentClip
    };
    currentPlayerIndex = (currentPlayerIndex + 1) % videoPlayers.length;
  }

  // Stop recording after the desired final duration (in seconds)
  setTimeout(() => {
    recorder.stop();
    updateProgress('Recording stopped.');
  }, finalDuration * 1000);
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

// Play the clip by drawing frames from the active video onto the canvas,
// performing a two‐step crop: first crop the video to match the canvas aspect ratio,
// then (if a zoom effect is applied) select a random sub–region of that cropped area.
function playActiveClip(video, clipConf, canvas, ctx, zoomConfig, previousClip) {
  return new Promise((resolve, reject) => {
    const { startTime, clipLength, file } = clipConf;
    const endTime = startTime + clipLength;
    const overlapDuration = 1.0; // 1 second overlap

    // Determine whether to apply zoom.
    // (Note: zoomProbability is assumed to be a percentage.)
    const applyZoom = Math.random() < (zoomConfig.zoomProbability / 100);
    let zoomFactor = 1;

    video.play().then(() => {
      // Once the video is ready, compute the initial crop so that the source image
      // has the same aspect ratio as the canvas.
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      const canvasAspect = canvas.width / canvas.height;
      const videoAspect = videoWidth / videoHeight;
      let cropX, cropY, cropW, cropH;

      if (videoAspect > canvasAspect) {
        // Video is wider than canvas: crop the sides.
        cropH = videoHeight;
        cropW = cropH * canvasAspect;
        cropX = (videoWidth - cropW) / 2;
        cropY = 0;
      } else if (videoAspect < canvasAspect) {
        // Video is taller than canvas: crop the top and bottom.
        cropW = videoWidth;
        cropH = cropW / canvasAspect;
        cropX = 0;
        cropY = (videoHeight - cropH) / 2;
      } else {
        // Same aspect ratio: no initial cropping needed.
        cropX = 0;
        cropY = 0;
        cropW = videoWidth;
        cropH = videoHeight;
      }

      // If zoom is to be applied, choose a random zoom factor and determine a further crop
      // within the already cropped area. The zoom crop will have dimensions (cropW / zoomFactor, cropH / zoomFactor)
      // and will be randomly positioned within the crop, ensuring that when scaled it fills the canvas.
      let zoomCropX = cropX, zoomCropY = cropY, zoomCropW = cropW, zoomCropH = cropH;
      if (applyZoom) {
        zoomFactor = Math.random() * ((zoomConfig.maxZoom - zoomConfig.minZoom) / 100) + (zoomConfig.minZoom / 100);
        zoomCropW = cropW / zoomFactor;
        zoomCropH = cropH / zoomFactor;
        zoomCropX = cropX + Math.random() * (cropW - zoomCropW);
        zoomCropY = cropY + Math.random() * (cropH - zoomCropH);
        updateProgress(`Applied zoom on ${file.name}: ${(zoomFactor * 100).toFixed(0)}% (crop at x:${Math.floor(zoomCropX)}, y:${Math.floor(zoomCropY)})`);
      }

      const drawFrame = () => {
        // Clear canvas on each frame
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // If there is a previous clip and we're within the overlap period,
        // draw the previous clip in the background.
        if (previousClip && video.currentTime < startTime + overlapDuration) {
          const previousVideo = previousClip.video;
          // For simplicity, draw the full previous clip scaled to fill the canvas.
          ctx.drawImage(previousVideo, 0, 0, canvas.width, canvas.height);
        }

        // Draw the current clip.
        // If zoom is applied, use the zoom crop; otherwise, use the initial crop.
        if (applyZoom) {
          ctx.drawImage(video, zoomCropX, zoomCropY, zoomCropW, zoomCropH, 0, 0, canvas.width, canvas.height);
        } else {
          ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
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