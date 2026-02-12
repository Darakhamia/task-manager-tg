import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { log } from './logger';
import { getFile, downloadFile } from './telegram';

const TMP_DIR = '/tmp';
const FFMPEG_TIMEOUT_MS = 60_000;

/**
 * Download a Telegram voice file and convert it to mp3 via ffmpeg.
 * Returns the path to the resulting mp3 file and a cleanup function.
 */
export async function downloadAndConvert(
  token: string,
  fileId: string,
  requestId: string,
): Promise<{ mp3Path: string; cleanup: () => Promise<void> }> {
  const id = uuid();
  const inputPath = join(TMP_DIR, `${id}.opus`);
  const outputPath = join(TMP_DIR, `${id}.mp3`);

  // 1. Get file metadata
  log.info('Getting Telegram file info', { requestId, fileId });
  const fileMeta = await getFile(token, fileId);
  if (!fileMeta.file_path) {
    throw new Error('Telegram returned empty file_path');
  }

  // 2. Download
  log.info('Downloading voice file', { requestId, filePath: fileMeta.file_path });
  const buffer = await downloadFile(token, fileMeta.file_path);
  await writeFile(inputPath, buffer);
  log.info('Voice file saved', { requestId, inputPath, bytes: buffer.length });

  // 3. Convert with ffmpeg
  log.info('Converting to mp3', { requestId });
  await ffmpegConvert(inputPath, outputPath);
  log.info('Conversion complete', { requestId, outputPath });

  // 4. Cleanup helper
  const cleanup = async () => {
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  };

  return { mp3Path: outputPath, cleanup };
}

function ffmpegConvert(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', output];
    const proc = execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        log.error('ffmpeg error', { error: err.message, stderr });
        reject(new Error(`ffmpeg failed: ${err.message}`));
        return;
      }
      resolve();
    });
    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });
  });
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // file already gone — that's fine
  }
}
