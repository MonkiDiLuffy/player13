import { execFile } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { promisify } from 'util';
import { YtDlp } from 'ytdlp-nodejs';
import { MUSIC_FOLDER } from './config.js';

const execFileAsync = promisify(execFile);

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'music.youtube.com',
  'm.youtube.com',
]);

async function resolveBinary(name) {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function ensureYtDlp() {
  const binaryPath = await resolveBinary('yt-dlp');
  const ffmpegPath = await resolveBinary('ffmpeg');

  if (!binaryPath) {
    throw new Error('yt-dlp not found. Install it with: sudo apt install yt-dlp');
  }
  if (!ffmpegPath) {
    throw new Error('ffmpeg not found. Install it with: sudo apt install ffmpeg');
  }

  return { binaryPath, ffmpegPath };
}

export function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url.trim());
    return (
      YOUTUBE_HOSTS.has(parsed.hostname) ||
      parsed.hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

export async function downloadYouTubeAudio(url, onUpdate) {
  if (!isYouTubeUrl(url)) {
    throw new Error('Please enter a valid YouTube URL');
  }

  const { binaryPath, ffmpegPath } = await ensureYtDlp();

  if (!existsSync(MUSIC_FOLDER)) {
    mkdirSync(MUSIC_FOLDER, { recursive: true });
  }

  const ytdlp = new YtDlp({ binaryPath, ffmpegPath });
  let title = null;

  const result = await ytdlp
    .download(url)
    .filter('audioonly')
    .type('mp3')
    .quality(0)
    .output(MUSIC_FOLDER)
    .options({ noPlaylist: true })
    .embedMetadata()
    .on('beforeDownload', (info) => {
      title = info.title || 'Unknown title';
      onUpdate?.({ phase: 'starting', title, progress: null });
    })
    .on('progress', (progress) => {
      onUpdate?.({ phase: 'downloading', title, progress });
    })
    .run();

  const savedPath = result.filePaths?.[0];
  if (!savedPath) {
    throw new Error('Download finished but no file was saved');
  }

  onUpdate?.({ phase: 'done', title, progress: { percentage: 100, status: 'finished' } });

  return { filePaths: result.filePaths, title, savedPath };
}
