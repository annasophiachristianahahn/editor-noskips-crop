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
  
  // NEW: Get final canvas dimensions from the index.html file
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
    minZoom > maxZoom ||
    isNaN(finalWidth) ||
    isNaN(finalHeight)
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

  // Set canvas dimensions from the provided inputs.
  canvas.width = finalWidth;
  canvas.height = finalHeight;

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

  // Build a pool of clip configurations that (when summed) exceed the final video length.
  let totalPlanned = 0;
  const clipConfs = [];
  const filesArray = Array.from(files);
  updateProgress('Building clip configurations...');
  while (totalPlanned < finalLength * 1.2) {  // plan a bit extra to be sure
    const candidate = filesArray[Math.floor(Math.random() * filesArray.length)];
    const duration = await getVideoDuration(candidate);
    const clipLength = getRandomClipLength(minClipLength, maxClipLength, duration);
    const startTime = getRandomStartTime(duration, clipLength);
    clipConfs.push({ file: candidate, startTime, clipLength });
    totalPlanned += clipLength;
    updateProgress(`Added clip from ${candidate.name}: start=${startTime.toFixed(2)}s, length=${clipLength.toFixed(2)}s (total planned: ${totalPlanned.toFixed(2)}s)`);
  }

  // Create 4 video elements for a preloading pipeline.
  const videoPlayers = [];
  for (let i = 0; i < 4; i++) {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    videoPlayers.push(video);
  }

  // Preload the first 4 clips (or as many as available)
  for (let i = 0; i < videoPlayers.length && clipConfs.length; i++) {
    const clip = clipConfs.shift();
    updateProgress(`Preloading clip from ${clip.file.name} into slot ${i}`);
    await preloadClip(videoPlayers[i], clip.file, clip.startTime, clip.clipLength);
    videoPlayers[i].clipConf = clip;
  }

  // Start recording and note the start time.
  recorder.start();
  const recordStart = performance.now();
  updateProgress('Recording started.');

  // Schedule recorder stop exactly after finalLength seconds.
  setTimeout(() => {
    recorder.stop();
    updateProgress('Recording stopped.');
  }, finalLength * 1000);

  // Instead of breaking when we run out of clips, cycle through our players until time is up.
  let currentPlayerIndex = 0;
  let previousClipInfo = null;
  while (performance.now() - recordStart < finalLength * 1000) {
    const currentVideo = videoPlayers[currentPlayerIndex];
    const clipConf = currentVideo.clipConf;

    // If a clip isn’t loaded, simply wait a bit (should be rare)
    if (!clipConf) {
      await new Promise(r => setTimeout(r, 50));
      continue;
    }

    // Play the clip (with fixed zoom crop if applicable)
    await playActiveClip(currentVideo, clipConf, canvas, ctx, { zoomProbability, minZoom, maxZoom }, previousClipInfo, recordStart, finalLength);

    // Update previousClipInfo to allow overlap drawing on the next clip.
    previousClipInfo = { video: currentVideo, conf: clipConf };

    // After finishing one clip, preload a new clip into this video element if any remain.
    if (clipConfs.length) {
      const newClip = clipConfs.shift();
      await preloadClip(currentVideo, newClip.file, newClip.startTime, newClip.clipLength);
      currentVideo.clipConf = newClip;
    }
    // Move to the next player (cycling through)
    currentPlayerIndex = (currentPlayerIndex + 1) % videoPlayers.length;
  }
}

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const tempVideo = document.createElement('video');
    tempVideo.src = URL.createObjectURL(file);
    tempVideo.onloadedmetadata = () => resolve(tempVideo.duration);
  });
}

function getRandomClipLength(minClipLength, maxClipLength, duration) {
  const minL = (minClipLength / 100) * duration;
  const maxL = (maxClipLength / 100) * duration;
  return Math.random() * (maxL - minL) + minL;
}

function getRandomStartTime(duration, clipLength) {
  return Math.random() * (duration - clipLength);
}

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

// playActiveClip now calculates the crop (including zoom crop) only once per clip.
// It also checks the overall elapsed recording time on each frame so that drawing stops once the final length is reached.
function playActiveClip(video, clipConf, canvas, ctx, zoomConfig, previousClip, recordStart, finalLength) {
  return new Promise((resolve, reject) => {
    const { startTime, clipLength, file } = clipConf;
    const clipEndTime = startTime + clipLength;
    const overlapDuration = 1.0; // seconds of overlap for transitions

    // Compute the “base crop” rectangle from the video that matches the canvas aspect ratio.
    const videoAspect = video.videoWidth / video.videoHeight;
    const canvasAspect = canvas.width / canvas.height;
    let baseSX, baseSY, baseSW, baseSH;
    if (videoAspect > canvasAspect) {
      // Video is wider: crop the sides.
      baseSH = video.videoHeight;
      baseSW = video.videoHeight * canvasAspect;
      baseSX = (video.videoWidth - baseSW) / 2;
      baseSY = 0;
    } else {
      // Video is taller: crop top and bottom.
      baseSW = video.videoWidth;
      baseSH = video.videoWidth / canvasAspect;
      baseSY = (video.videoHeight - baseSH) / 2;
      baseSX = 0;
    }

    // Determine whether to apply zoom and, if so, compute the fixed crop for this clip.
    let useZoom = Math.random() < (zoomConfig.zoomProbability / 100);
    let zoomFactor = 1;
    let fixedSX = baseSX, fixedSY = baseSY, fixedSW = baseSW, fixedSH = baseSH;
    if (useZoom) {
      zoomFactor = Math.random() * ((zoomConfig.maxZoom - zoomConfig.minZoom) / 100) + (zoomConfig.minZoom / 100);
      fixedSW = baseSW / zoomFactor;
      fixedSH = baseSH / zoomFactor;
      const maxOffX = baseSW - fixedSW;
      const maxOffY = baseSH - fixedSH;
      fixedSX = baseSX + Math.random() * maxOffX;
      fixedSY = baseSY + Math.random() * maxOffY;
      updateProgress(`Applied zoom on ${file.name}: factor ${(zoomFactor * 100).toFixed(0)}%, crop at x:${fixedSX.toFixed(0)}, y:${fixedSY.toFixed(0)}`);
    }

    video.play().then(() => {
      const drawFrame = () => {
        // Check overall recording time. If we've reached the final length, stop drawing.
        if (performance.now() - recordStart >= finalLength * 1000) {
          resolve();
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // If there is an overlap period with the previous clip, draw it first.
        if (previousClip && video.currentTime < startTime + overlapDuration) {
          ctx.drawImage(previousClip.video, 0, 0, canvas.width, canvas.height);
        }

        // Draw the current video using the fixed crop.
        ctx.drawImage(
          video,
          fixedSX, fixedSY, fixedSW, fixedSH,
          0, 0, canvas.width, canvas.height
        );

        // If the current clip’s designated end is reached, resolve.
        if (video.currentTime >= clipEndTime) {
          resolve();
        } else {
          requestAnimationFrame(drawFrame);
        }
      };
      drawFrame();
    }).catch((e) => {
      updateProgress(`Error playing clip from ${file.name}: ${e.message}`);
      reject(e);
    });
  });
}