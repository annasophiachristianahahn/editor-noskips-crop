// script.js
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
  const videoWidth = parseInt(document.getElementById('video-width').value);
  const videoHeight = parseInt(document.getElementById('video-height').value);
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
    isNaN(finalLength) ||
    isNaN(videoWidth) ||
    isNaN(videoHeight) ||
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
  await processVideos(files, finalLength, videoWidth, videoHeight, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom);
});

async function processVideos(files, finalLength, videoWidth, videoHeight, minClipLength, maxClipLength, zoomProbability, minZoom, maxZoom) {
  updateProgress('Initializing processing...');
  const canvas = document.createElement('canvas');
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const ctx = canvas.getContext('2d');
  const chunks = [];

  // Use a captureStream frame rate of 30 FPS
  const stream = canvas.captureStream(30);

  // Use H.264 codec with a bitrate of 8 Mbps
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
    // If there is room at the end of the base clip, add 1 second of extra buffer.
    let effectiveClipLength = clipLength;
    if (startTime + clipLength + 1 <= duration) {
      effectiveClipLength = clipLength + 1;
    }
    clipConfs.push({ file: randFile, startTime, clipLength, effectiveClipLength });
    totalDuration += clipLength;
    lastFile = randFile;
    updateProgress(`Added clip from ${randFile.name}: start=${startTime.toFixed(2)}s, length=${clipLength.toFixed(2)}s (effective: ${effectiveClipLength.toFixed(2)}s). Total duration: ${totalDuration.toFixed(2)}s`);
  }
  
  // Create 12 video elements for seamless transitions (an increased pool).
  const NUM_PLAYERS = 12;
  let players = [];
  let playerConfigs = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    let vid = document.createElement('video');
    vid.muted = true;
    vid.autoplay = true;
    // Force auto-preloading and decoding.
    vid.preload = 'auto';
    vid.load();
    players.push(vid);
    playerConfigs.push(null);
  }
  
  // Preload up to NUM_PLAYERS clips from the clip configuration queue.
  let initialPreload = Math.min(NUM_PLAYERS, clipConfs.length);
  for (let i = 0; i < initialPreload; i++) {
    let clip = clipConfs.shift();
    playerConfigs[i] = clip;
    await preloadClip(players[i], clip.file, clip.startTime, clip.effectiveClipLength);
    updateProgress(`Preloaded clip into player ${i} from ${clip.file.name}`);
    // For the first player, set the canvas dimensions.
    if (i === 0) {
      // canvas.width = players[i].videoWidth;
      // canvas.height = players[i].videoHeight;
    }
  }
  // Total number of clips to process = preloaded ones plus remaining in clipConfs.
  const totalClips = initialPreload + clipConfs.length;
  
  recorder.start();
  updateProgress('Recording started.');
  
  // Use round-robin through the video pool.
  let playedCount = 0;
  let currentIndex = 0;
  while (playedCount < totalClips) {
    const currentConfig = playerConfigs[currentIndex];
    if (!currentConfig) break;
    updateProgress(`Playing clip from ${currentConfig.file.name} using player ${currentIndex} (start: ${currentConfig.startTime.toFixed(2)}s, nominal length: ${currentConfig.clipLength.toFixed(2)}s, effective: ${currentConfig.effectiveClipLength.toFixed(2)}s)`);
    await playActiveClip(players[currentIndex], currentConfig, canvas, ctx, { zoomProbability, minZoom, maxZoom }, videoWidth, videoHeight);
    playedCount++;
  
    // Preload the next clip into the just used player, if any remain.
    if (clipConfs.length > 0) {
      let nextClip = clipConfs.shift();
      updateProgress(`Preloading new clip into player ${currentIndex} from ${nextClip.file.name} (start: ${nextClip.startTime.toFixed(2)}s, nominal length: ${nextClip.clipLength.toFixed(2)}s, effective: ${nextClip.effectiveClipLength.toFixed(2)}s)`);
      await preloadClip(players[currentIndex], nextClip.file, nextClip.startTime, nextClip.effectiveClipLength);
      playerConfigs[currentIndex] = nextClip;
    } else {
      playerConfigs[currentIndex] = null;
    }
    currentIndex = (currentIndex + 1) % NUM_PLAYERS;
  }
  
  // Stop recording after the desired final length (in seconds)
  setTimeout(() => {
    recorder.stop();
    updateProgress('Recording stopped.');
  }, finalLength * 1000);
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

// Preload a clip: set the source, currentTime, preload it, and wait until it is fully ready (canplaythrough)
function preloadClip(video, file, startTime, clipDuration) {
  return new Promise((resolve, reject) => {
    video.src = URL.createObjectURL(file);
    video.currentTime = startTime;
    video.preload = 'auto';
    video.load();
    video.addEventListener('canplaythrough', () => resolve(), { once: true });
    video.onerror = (e) => reject(e);
  });
}

// Play the clip by drawing frames from the active video onto the canvas.
// We compute the clip end based on effectiveClipLength and then resolve once video.currentTime reaches (endTime - overlay).
// Here overlay is fixed at 1 second when available.
function playActiveClip(video, clipConf, canvas, ctx, zoomConfig, videoWidth, videoHeight) {
  return new Promise((resolve, reject) => {
    const { startTime, clipLength, effectiveClipLength, file } = clipConf;
    const endTime = startTime + effectiveClipLength;
    // Use a fixed overlay of 1 second if possible.
    const overlay = effectiveClipLength >= 1 ? 1 : effectiveClipLength;
    
    // Calculate aspect ratio of the video
    const videoAspectRatio = video.videoWidth / video.videoHeight;
    // Calculate aspect ratio of the canvas
    const canvasAspectRatio = videoWidth / videoHeight;

    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;

    // Determine if the video needs to be cropped
    if (videoAspectRatio > canvasAspectRatio) {
      // Video is wider than the canvas, crop the sides
      sourceWidth = video.videoHeight * canvasAspectRatio;
      sourceX = (video.videoWidth - sourceWidth) / 2;
    } else if (videoAspectRatio < canvasAspectRatio) {
      // Video is taller than the canvas, crop the top and bottom
      sourceHeight = video.videoWidth / canvasAspectRatio;
      sourceY = (video.videoHeight - sourceHeight) / 2;
    }

    let applyZoom = Math.random() < (zoomConfig.zoomProbability / 100);
    let zoomFactor = 1;
    let sx = 0, sy = 0; // source top-left coordinates

    if (applyZoom) {
      zoomFactor = Math.random() * ((zoomConfig.maxZoom - zoomConfig.minZoom) / 100) + (zoomConfig.minZoom / 100);
      const srcWidth = canvas.width / zoomFactor;
      const srcHeight = canvas.height / zoomFactor;
      sx = Math.random() * (canvas.width - srcWidth);
      sy = Math.random() * (canvas.height - srcHeight);
      updateProgress(`Applied zoom on ${file.name}: ${(zoomFactor * 100).toFixed(0)}% (crop at x:${sx.toFixed(0)}, y:${sy.toFixed(0)})`);
    }
    
    // Start playback when ready
    function startPlayback() {
      video.play().then(() => {
        const frameCallback = (now, metadata) => {
          if (metadata.mediaTime >= endTime - overlay) {
            resolve();
            return;
          }
          if (zoomFactor > 1) {
            const srcWidth = canvas.width / zoomFactor;
            const srcHeight = canvas.height / zoomFactor;
            ctx.drawImage(video, sourceX + sx, sourceY + sy, srcWidth, srcHeight, 0, 0, canvas.width, canvas.height);
          } else {
            ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
          }
          if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(frameCallback);
          } else {
            requestAnimationFrame(frameCallback);
          }
        };

        if (video.requestVideoFrameCallback) {
          video.requestVideoFrameCallback(frameCallback);
        } else {
          requestAnimationFrame(frameCallback);
        }
      }).catch((e) => {
        updateProgress(`Error playing clip from file ${file.name}: ${e.message}`);
        console.error(`Error playing clip from file: ${file.name}`, e);
        reject(e);
      });
    }
    
    // If the video isn't fully ready, wait for "canplay" before starting playback.
    if (video.readyState < 3) {
      video.addEventListener('canplay', function handler() {
        video.removeEventListener('canplay', handler);
        startPlayback();
      }, { once: true });
    } else {
      startPlayback();
    }
  });
}