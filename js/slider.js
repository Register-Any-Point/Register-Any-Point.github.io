import { parseGIF, decompressFrames } from "https://esm.sh/gifuct-js@2.1.2";

document.addEventListener("DOMContentLoaded", async () => {
  // Find all slider-container elements on the page
  const allContainers = document.querySelectorAll(".slider-container");

  // Initialize each container independently
  allContainers.forEach(async (container) => {
    // ─── Read configuration from data attributes ───
    const gifUrl     = container.dataset.gifUrl;
    const frameStart = parseInt(container.dataset.frameStart, 10);
    const frameEnd   = parseInt(container.dataset.frameEnd, 10);

    // Crop parameters (adjust as needed or move to data attributes)
    const cropX      = 430;
    const cropY      = 50;
    const cropWidth  = 340;
    const cropHeight = 260;

    // ─── Query this container’s child elements ───
    const startCanvas = container.querySelector(".start-canvas");
    const midCanvas   = container.querySelector(".middle-canvas");
    const endCanvas   = container.querySelector(".end-canvas");
    const slider      = container.querySelector(".frame-slider");
    const sSpan       = container.querySelector(".s-value");
    const midCaption  = container.querySelector(".middle-caption");

    // ─── Fetch the GIF as an ArrayBuffer ───
    const resp        = await fetch(gifUrl);
    const arrayBuffer = await resp.arrayBuffer();

    // ─── Parse & decompress all frames ───
    const parsedGif   = parseGIF(arrayBuffer);
    const frames      = decompressFrames(parsedGif, /* buildPatch = */ true);

    // GIF logical (full‐canvas) dimensions
    const logicalWidth  = parsedGif.lsd.width;
    const logicalHeight = parsedGif.lsd.height;

    // Number of frames (0..length−1)
    const totalGifFrames = frames.length - 1;

    // Clamp start/end into valid range
    const startIdx = Math.max(0, Math.min(frameStart, totalGifFrames));
    const endIdx   = Math.max(0, Math.min(frameEnd,   totalGifFrames));
    const rangeStart = Math.min(startIdx, endIdx);
    const rangeEnd   = Math.max(startIdx, endIdx);

    // ─── Configure the range slider ───
    slider.min   = rangeStart;
    slider.max   = rangeEnd;
    slider.value = rangeStart;

    // ─── Resize each canvas to the desired crop size ───
    [startCanvas, midCanvas, endCanvas].forEach((cnv) => {
      cnv.width  = cropWidth;
      cnv.height = cropHeight;
    });

    // ─── Create an offscreen “master” canvas matching the GIF’s logical screen ───
    const masterCanvas = document.createElement("canvas");
    masterCanvas.width  = logicalWidth;
    masterCanvas.height = logicalHeight;
    const masterCtx = masterCanvas.getContext("2d");

    // Store a full‐canvas ImageData for each frame
    const fullFrames = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      // Handle disposal from previous frame
      if (i > 0) {
        const prev = frames[i - 1];
        if (prev.disposalType === 2) {
          masterCtx.clearRect(
            prev.dims.left,
            prev.dims.top,
            prev.dims.width,
            prev.dims.height
          );
        }
      }

      // Draw this frame’s patch onto the master canvas
      const patchImageData = new ImageData(
        frame.patch,
        frame.dims.width,
        frame.dims.height
      );
      masterCtx.putImageData(patchImageData, frame.dims.left, frame.dims.top);

      // Snapshot the entire master canvas
      fullFrames[i] = masterCtx.getImageData(0, 0, logicalWidth, logicalHeight);
    }

    // ─── Function to draw a cropped frame into a target canvas ───
    function drawCroppedFrame(frameIndex, targetCanvas) {
      const fullFrameData = fullFrames[frameIndex];

      // Paint it onto a temporary offscreen canvas
      const temp = document.createElement("canvas");
      temp.width  = logicalWidth;
      temp.height = logicalHeight;
      const tctx = temp.getContext("2d");
      tctx.putImageData(fullFrameData, 0, 0);

      // Copy only the crop rectangle into the visible canvas
      const ctx = targetCanvas.getContext("2d");
      ctx.clearRect(0, 0, cropWidth, cropHeight);
      ctx.drawImage(
        temp,
        cropX, cropY,          // Source top-left (crop origin)
        cropWidth, cropHeight, // Source size (crop w/h)
        0, 0,                  // Destination top-left
        cropWidth, cropHeight  // Destination size
      );
    }

    // ─── INITIAL RENDER ───
    drawCroppedFrame(rangeStart, startCanvas);
    drawCroppedFrame(rangeStart, midCanvas);
    drawCroppedFrame(rangeEnd,   endCanvas);

    // Compute and display initial “s”
    const initialS = rangeEnd > rangeStart
      ? ((rangeStart - rangeStart) / (rangeEnd - rangeStart)).toFixed(2)
      : "0.00";
    sSpan.textContent = initialS;

    // ─── SLIDER EVENT HANDLER ───
    slider.addEventListener("input", (e) => {
      const idx = parseInt(e.target.value, 10);
      drawCroppedFrame(idx, midCanvas);

      let s = "0.00";
      if (rangeEnd > rangeStart) {
        s = ((idx - rangeStart) / (rangeEnd - rangeStart)).toFixed(2);
      }
      sSpan.textContent = s;

      // Optionally update the middle-caption text as well:
      // midCaption.textContent = `Noise Z(${s})`;
    });

    // ─── OPTIONAL: Dynamic resize / scaling ───
    function scaleContainerToFit() {
      const parentWidth    = container.parentElement.clientWidth;
      const scaleFactor    = Math.max([0.03, 0.8 * parentWidth / (cropWidth * 3)]);
      console.log(`Scale factor: ${scaleFactor} for container width ${parentWidth}`);

      if (scaleFactor < 1) {
        [startCanvas, midCanvas, endCanvas].forEach((cnv) => {
          cnv.style.width  = `${cropWidth * scaleFactor}px`;
          cnv.style.height = `${cropHeight * scaleFactor}px`;
        });
        container.querySelectorAll(".slider-block").forEach((blk) => {
          // Original margin was “0 10px”, so we scale 10px by scaleFactor
          const originalMargin = 5;
          blk.style.marginLeft  = `${originalMargin * scaleFactor}px`;
          blk.style.marginRight = `${originalMargin * scaleFactor}px`;
        });
      } else {
        [startCanvas, midCanvas, endCanvas].forEach((cnv) => {
          cnv.style.width  = "";
          cnv.style.height = "";
        });
        container.querySelectorAll(".slider-block").forEach((blk) => {
          blk.style.marginLeft  = "";
          blk.style.marginRight = "";
        });
      }
    }

    // Run scaling once, and again on window resize
    // scaleContainerToFit();
    // window.addEventListener("resize", scaleContainerToFit);
  });
});
