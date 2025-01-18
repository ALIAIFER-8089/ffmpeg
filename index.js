// Import dependencies
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fetch from 'node-fetch';
import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import cors from 'cors';
// ffmpeg.setFfmpegPath('C:/Users/moham/Documents/ffmpeg/bin/ffmpeg.exe');
import ffmpegStatic from 'ffmpeg-static';

console.log('FFmpeg path:', ffmpegStatic);
ffmpeg.setFfmpegPath(ffmpegStatic);


const app = express();
app.use(express.json()); // Add JSON body parser
app.use(cors());
const PORT = 3000;

app.get('/',(req,res)=>{
  res.send('Hello working')
})

// Define __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a permanent directory for storing videos
const videoStorageDir = path.join(__dirname, 'public', 'videos');
fs.ensureDirSync(videoStorageDir);

// Serve static files from the video storage directory
app.use('/output-video', express.static(videoStorageDir));

// Download video from URL
async function downloadVideo(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download video: ${response.statusText}`);
  const fileStream = fs.createWriteStream(outputPath);
  console.log('Download completed');
  
  return new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
}

// Get video length using FFmpeg
function getVideoLength(inputVideo) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputVideo)
      .ffprobe((err, data) => {
        if (err) {
          reject(err);
        } else {
          const duration = data.format.duration;
          resolve(duration);
        }
      });
  });
}

// Detect silence using FFmpeg
function detectSilence(inputVideo) {
  return new Promise((resolve, reject) => {
    const currentDir = __dirname;
    const silenceLog = path.join(currentDir, 'silence_log.txt');
    const tempOutput = path.join(currentDir, 'temp_output.mp4');

    ffmpeg(inputVideo)
      .audioFilters('silencedetect=n=-50dB:d=1').output('-') // Discard actual output
      .outputOptions('-f', 'null') // Null output
      .on('stderr', (line) => {
        if (line.includes('silence_start') || line.includes('silence_end')) {
          fs.appendFileSync(silenceLog, line + '\n');
        }
      })
      .on('end', () => {
        fs.removeSync(tempOutput);
        resolve(parseSilenceLog(silenceLog));
      })
      .on('error', reject)
      .run();
  });
}

// Parse silence log
function parseSilenceLog(logFile) {
  const silenceIntervals = [];
  const logContent = fs.readFileSync(logFile, 'utf-8');
  const silenceRegex = /silence_(start|end):\s([0-9.]+)/g;
  let match;

  while ((match = silenceRegex.exec(logContent)) !== null) {
    if (match[1] === 'start') {
      silenceIntervals.push({ start: parseFloat(match[2]) });
    } else if (match[1] === 'end') {
      silenceIntervals[silenceIntervals.length - 1].end = parseFloat(match[2]);
    }
  }

  return silenceIntervals;
}

// Calculate segments with audio (non-silent parts)
function calculateAudioSegments(silenceIntervals, videoLength) {
  const audioSegments = [];
  let currentTime = 0;

  silenceIntervals.forEach((interval) => {
    if (interval.start > currentTime) {
      audioSegments.push({
        start: currentTime,
        end: interval.start
      });
    }
    currentTime = interval.end;
  });

  if (currentTime < videoLength) {
    audioSegments.push({
      start: currentTime,
      end: videoLength
    });
  }

  return audioSegments;
}

// Merge intro video with the main video
async function mergeIntro(introVideo, mainVideo, outputVideo) {
  return new Promise((resolve, reject) => {
    // Create a temporary scaled version of the intro video
    const scaledIntroPath = path.join(os.tmpdir(), 'scaled_intro.mp4');
    
    // First, scale the intro video with high quality settings
    ffmpeg()
      .input(introVideo)
      .outputOptions(
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:-1:-1:color=black,setsar=1:1',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18', // Lower CRF = higher quality (range 0-51)
        '-profile:v', 'high',
        '-level', '4.0',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '192k',    // Higher audio bitrate
        '-ar', '48000'     // Standard audio sample rate
      )
      .output(scaledIntroPath)
      .on('end', () => {
        // Now concatenate using concat demuxer with high quality settings
        const concatListPath = path.join(os.tmpdir(), 'concat_list.txt');
        const concatContent = `file '${scaledIntroPath}'\nfile '${mainVideo}'`;
        fs.writeFileSync(concatListPath, concatContent);

        ffmpeg()
          .input(concatListPath)
          .inputOptions('-f', 'concat', '-safe', '0')
          .outputOptions(
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-profile:v', 'high',
            '-level', '4.0',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-max_muxing_queue_size', '9999'
          )
          .output(outputVideo)
          .on('stderr', (stderrLine) => {
            console.log('FFmpeg STDERR: ' + stderrLine);
          })
          .on('end', () => {
            // Clean up temporary files
            fs.removeSync(scaledIntroPath);
            fs.removeSync(concatListPath);
            resolve();
          })
          .on('error', (err) => {
            fs.removeSync(scaledIntroPath);
            fs.removeSync(concatListPath);
            console.error('FFmpeg Error: ', err);
            reject(err);
          })
          .run();
      })
      .on('error', (err) => {
        console.error('FFmpeg Scaling Error: ', err);
        reject(err);
      })
      .run();
  });
}

// Merge outro video with the main video
async function mergeOutro(mainVideo, outroVideo, outputVideo) {
  return new Promise((resolve, reject) => {
    // Create a temporary scaled version of the outro video
    const scaledOutroPath = path.join(os.tmpdir(), 'scaled_outro.mp4');
    
    // First, scale the outro video with high quality settings
    ffmpeg()
      .input(outroVideo)
      .outputOptions(
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:-1:-1:color=black,setsar=1:1',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-profile:v', 'high',
        '-level', '4.0',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000'
      )
      .output(scaledOutroPath)
      .on('end', () => {
        // Now concatenate using concat demuxer with high quality settings
        const concatListPath = path.join(os.tmpdir(), 'concat_list.txt');
        const concatContent = `file '${mainVideo}'\nfile '${scaledOutroPath}'`;
        fs.writeFileSync(concatListPath, concatContent);

        ffmpeg()
          .input(concatListPath)
          .inputOptions('-f', 'concat', '-safe', '0')
          .outputOptions(
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-profile:v', 'high',
            '-level', '4.0',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-max_muxing_queue_size', '9999'
          )
          .output(outputVideo)
          .on('stderr', (stderrLine) => {
            console.log('FFmpeg STDERR: ' + stderrLine);
          })
          .on('end', () => {
            // Clean up temporary files
            fs.removeSync(scaledOutroPath);
            fs.removeSync(concatListPath);
            resolve();
          })
          .on('error', (err) => {
            fs.removeSync(scaledOutroPath);
            fs.removeSync(concatListPath);
            console.error('FFmpeg Error: ', err);
            reject(err);
          })
          .run();
      })
      .on('error', (err) => {
        console.error('FFmpeg Scaling Error: ', err);
        reject(err);
      })
      .run();
  });
}

// Function to calculate segments to keep based on cut segments
// Function to calculate segments to keep based on cut segments
function calculateKeepSegments(cutSegments, videoLength) {
  const keepSegments = [];
  let currentTime = 0;

  // Sort cut segments by start time
  cutSegments.sort((a, b) => a.startTime - b.startTime);

  cutSegments.forEach((cut) => {
    const startTime = cut.startTime || 0; // Ensure start time is valid
    const endTime = cut.endTime || videoLength; // Ensure end time is valid

    // Add segment before the cut, if it exists
    if (startTime > currentTime) {
      keepSegments.push({
        start: currentTime,
        end: startTime,
      });
    }

    currentTime = endTime; // Move the current time past the cut
  });

  // Add the remaining segment after the last cut, if any
  if (currentTime < videoLength) {
    keepSegments.push({
      start: currentTime,
      end: videoLength,
    });
  }

  return keepSegments;
}


// API to merge intro video
app.post('/merge-intro', async (req, res) => {
  console.log(req.body);
  
  const { introVideo, videoUrl } = req.body;
  const introVideoPath = path.join(os.tmpdir(), 'intro.mp4');
  const mainVideoPath = path.join(os.tmpdir(), 'main.mp4');
  const outputVideoPath = path.join(videoStorageDir, 'merged_intro.mp4');

  try {
    // Download videos
    await downloadVideo(introVideo, introVideoPath);
    await downloadVideo(videoUrl, mainVideoPath);

    // Merge intro with the main video
    await mergeIntro(introVideoPath, mainVideoPath, outputVideoPath);

    const outputUrl = `http://localhost:${PORT}/output-video/${path.basename(outputVideoPath)}`;
    res.json({ videoUrl: outputUrl });

    // Cleanup
    fs.removeSync(introVideoPath);
    fs.removeSync(mainVideoPath);
  } catch (error) {
    console.error('Error merging intro:', error);
    res.status(500).send('Failed to merge intro video');
  }
});

// API to merge outro video
app.post('/merge-outro', async (req, res) => {
  const { outroVideo, videoUrl } = req.body;
  const outroVideoPath = path.join(os.tmpdir(), 'outro.mp4');
  const mainVideoPath = path.join(os.tmpdir(), 'main.mp4');
  const outputVideoPath = path.join(videoStorageDir, 'merged_outro.mp4');

  try {
    // Download videos
    await downloadVideo(outroVideo, outroVideoPath);
    await downloadVideo(videoUrl, mainVideoPath);

    // Merge outro with the main video
    await mergeOutro(mainVideoPath, outroVideoPath, outputVideoPath);

    const outputUrl = `http://localhost:${PORT}/output-video/${path.basename(outputVideoPath)}`;
    res.json({ videoUrl: outputUrl });

    // Cleanup
    fs.removeSync(outroVideoPath);
    fs.removeSync(mainVideoPath);
  } catch (error) {
    console.error('Error merging outro:', error);
    res.status(500).send('Failed to merge outro video');
  }
});

// Extract and merge audio parts
function processVideo(inputVideo, outputVideo, silenceIntervals, videoLength) {
  return new Promise((resolve, reject) => {
    const audioSegments = calculateAudioSegments(silenceIntervals, videoLength);
    const tempDir = path.join(os.tmpdir(), 'temp_segments');

    fs.removeSync(tempDir);
    fs.ensureDirSync(tempDir);

    const concatFile = path.join(tempDir, 'concat.txt');
    const extractedFiles = [];

    let completedSegments = 0;

    audioSegments.forEach((segment, index) => {
      const outputSegment = path.join(tempDir, `segment_${index}.mp4`);
      extractedFiles.push(outputSegment);
      console.log('IN final');
      ffmpeg(inputVideo)
        .setStartTime(segment.start)
        .setDuration(segment.end - segment.start)
        .output(outputSegment)
        .outputOptions('-threads', '4')
        .on('end', () => {
          completedSegments++;
          if (completedSegments === audioSegments.length) {
            const concatContent = extractedFiles.map(f => `file '${f}'`).join('\n');
            fs.writeFileSync(concatFile, concatContent);

            ffmpeg()
              .input(concatFile)
              .inputOptions('-f', 'concat', '-safe', '0')
              .outputOptions('-c', 'copy', '-threads', '4')
              .output(outputVideo)
              .on('end', () => {
                fs.removeSync(tempDir);
                resolve();
              })
              .on('error', (err) => {
                fs.removeSync(tempDir);
                reject(err);
              })
              .run();
          }
        })
        .on('error', reject)
        .run();
    });
  });
}

// Existing API for processing video
app.get('/process-video', async (req, res) => {
  const videoUrl = req.query.videoUrl || 'https://www.w3schools.com/tags/mov_bbb.mp4';
  const inputVideo = path.join(os.tmpdir(), 'input.mp4');
  const outputVideo = path.join(videoStorageDir, 'output.mp4'); // Save to the permanent video storage folder

  fs.writeFile(path.join(__dirname, 'silence_log.txt'), '', (err) => {
    if (err) {
      console.error('Error clearing file:', err);
      return res.status(500).send('Failed to clear file content.');
    }
  });

  try {
    await downloadVideo(videoUrl, inputVideo);
    const videoLength = await getVideoLength(inputVideo);
    const silenceIntervals = await detectSilence(inputVideo);
    console.log('Silence Intervals:', silenceIntervals);
    await processVideo(inputVideo, outputVideo, silenceIntervals, videoLength);

    const processedVideoUrl = `http://localhost:3000/output-video/${path.basename(outputVideo)}`;
    res.json({ videoUrl: processedVideoUrl });

    res.on('finish', () => {
      fs.removeSync(inputVideo);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing video');
  }
});

// Optimized function to process the video by trimming and concatenating segments
async function trimProcessVideo(inputVideo, outputVideo, keepSegments) {
  const tempDir = path.join(os.tmpdir(), 'temp_segments');
  fs.removeSync(tempDir);
  fs.ensureDirSync(tempDir);

  const concatFile = path.join(tempDir, 'concat.txt');
  const extractedFiles = [];

  // Process segments in parallel
  await Promise.all(
    keepSegments.map((segment, index) => {
      const outputSegment = path.join(tempDir, `segment_${index}.mp4`);
      extractedFiles.push(outputSegment);

      return new Promise((resolve, reject) => {
        ffmpeg(inputVideo)
          .setStartTime(segment.start)
          .setDuration(segment.end - segment.start)
          .outputOptions('-c', 'copy') // Avoid re-encoding
          .output(outputSegment)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    })
  );

  // Create the concat file
  const concatContent = extractedFiles.map((f) => `file '${f}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  // Concatenate segments
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions('-f', 'concat', '-safe', '0')
      .outputOptions('-c', 'copy') // Avoid re-encoding
      .output(outputVideo)
      .on('end', () => {
        fs.removeSync(tempDir);
        resolve();
      })
      .on('error', (err) => {
        fs.removeSync(tempDir);
        reject(err);
      })
      .run();
  });
}

// API endpoint to process video based on segments
app.post('/trim-video', async (req, res) => {
  const videoUrl = req.body.url;
   console.log(req.body,'bodyData');
   
  const cutSegments = req.body.segments || []; // Array of {start, end} objects

  if (!Array.isArray(cutSegments)) {
    return res.status(400).send('Segments must be an array of {start, end} objects');
  }

  const inputVideo = path.join(os.tmpdir(), 'input.mp4');
  const outputVideo = path.join(videoStorageDir, 'output.mp4');

  try {
    // Download the video
    await downloadVideo(videoUrl, inputVideo);

    // Get the video length
    const videoLength = await getVideoLength(inputVideo);

    // Calculate segments to keep
    const keepSegments = calculateKeepSegments(cutSegments, videoLength);
    console.log('Segments to keep:', keepSegments);

    // Process the video
    await trimProcessVideo(inputVideo, outputVideo, keepSegments);
    const processedVideoUrl = `http://localhost:3000/output-video/${path.basename(outputVideo)}`;
    res.json({ videoUrl: processedVideoUrl });

    res.on('finish', () => {
      fs.removeSync(inputVideo);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing video');
  }
});
// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
