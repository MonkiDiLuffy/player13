import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

config({ path: join(ROOT, '.env') });

export const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
export const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
export const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || 'https://127.0.0.1:8888/callback';

export const TOKEN_PATH = join(ROOT, '.spotify-tokens.json');

export const MUSIC_FOLDER =
  process.env.MUSIC_FOLDER || join(ROOT, 'music');

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.wav',
  '.m4a',
  '.aac',
  '.opus',
  '.webm',
]);

export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export function validateConfig() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error(
      'Missing Spotify credentials. Copy .env.example to .env and fill in your values.'
    );
    console.error('Create an app at https://developer.spotify.com/dashboard');
    process.exit(1);
  }
}
