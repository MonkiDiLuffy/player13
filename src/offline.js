import { spawn, execFile } from 'child_process';
import { createConnection } from 'net';
import { readdirSync, existsSync, unlinkSync } from 'fs';
import { join, extname, basename, relative, dirname } from 'path';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { MUSIC_FOLDER, AUDIO_EXTENSIONS } from './config.js';

const execFileAsync = promisify(execFile);

function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function parseTrackMeta(filePath, musicRoot) {
  const rel = relative(musicRoot, filePath);
  const folder = dirname(rel);
  const stem = basename(filePath, extname(filePath));
  const dash = stem.match(/^(.+?)\s*[-–—]\s*(.+)$/);

  return {
    id: filePath,
    path: filePath,
    uri: filePath,
    name: dash ? dash[2].trim() : stem,
    artists: dash ? dash[1].trim() : folder === '.' ? 'Local' : folder,
    album: folder === '.' ? 'Music Library' : folder,
    durationMs: 0,
  };
}

function scanDir(dir, root, results = []) {
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, root, results);
    } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(parseTrackMeta(full, root));
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function waitForSocket(socketPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(socketPath)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Timed out waiting for audio player'));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

class MpvEngine {
  constructor() {
    this.socketPath = join(tmpdir(), `player13-mpv-${process.pid}.sock`);
    this.proc = null;
    this.available = null;
  }

  async ensureAvailable() {
    if (this.available !== null) return this.available;
    try {
      await execFileAsync('which', ['mpv']);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async start() {
    if (this.proc) return;

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }

    this.proc = spawn(
      'mpv',
      [
        '--no-video',
        '--idle=yes',
        '--keep-open=yes',
        `--input-ipc-server=${this.socketPath}`,
        '--volume=80',
      ],
      { stdio: 'ignore' }
    );

    this.proc.on('exit', () => {
      this.proc = null;
    });

    await waitForSocket(this.socketPath);
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let data = '';

      socket.on('data', (chunk) => {
        data += chunk.toString();
        const line = data.split('\n').find((l) => l.trim());
        if (!line) return;
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      });

      socket.on('error', reject);
      socket.once('connect', () => {
        socket.write(`${payload}\n`);
      });
    });
  }

  async command(...args) {
    await this.start();
    return this.request(JSON.stringify({ command: args }));
  }

  async getProperty(name) {
    const res = await this.command('get_property', name);
    return res.data;
  }

  async load(filePath) {
    await this.command('loadfile', filePath, 'replace');
  }

  async togglePause() {
    const paused = await this.getProperty('pause');
    await this.command('set_property', 'pause', !paused);
  }

  async pause() {
    await this.command('set_property', 'pause', true);
  }

  async play() {
    await this.command('set_property', 'pause', false);
  }

  async setVolume(percent) {
    await this.command('set_property', 'volume', percent);
  }

  async seekRelative(seconds) {
    await this.command('seek', seconds, 'relative');
  }

  async getState() {
    const [pause, timePos, duration, volume] = await Promise.all([
      this.getProperty('pause'),
      this.getProperty('time-pos'),
      this.getProperty('duration'),
      this.getProperty('volume'),
    ]);

    return {
      playing: !pause,
      progressMs: Math.max(0, (timePos || 0) * 1000),
      durationMs: Math.max(0, (duration || 0) * 1000),
      volume: Math.round(volume ?? 80),
    };
  }

  async stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }
}

class FfplayEngine {
  constructor() {
    this.proc = null;
    this.currentTrack = null;
    this.playing = false;
    this.paused = false;
    this.volume = 80;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pauseAccum = 0;
    this.durationMs = 0;
    this.available = null;
  }

  async ensureAvailable() {
    if (this.available !== null) return this.available;
    try {
      await execFileAsync('which', ['ffplay']);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async probeDuration(filePath) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'quiet',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        filePath,
      ]);
      return Math.round(parseFloat(stdout.trim()) * 1000) || 0;
    } catch {
      return 0;
    }
  }

  async load(filePath) {
    await this.stopInternal();
    this.durationMs = await this.probeDuration(filePath);
    this.currentTrack = filePath;
    this.proc = spawn(
      'ffplay',
      ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(this.volume), filePath],
      { stdio: 'ignore' }
    );
    this.playing = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.pauseAccum = 0;

    this.proc.on('exit', () => {
      if (this.proc) {
        this.playing = false;
        this.proc = null;
      }
    });
  }

  async togglePause() {
    if (!this.proc) return;
    if (this.paused) {
      this.proc.kill('SIGCONT');
      this.pauseAccum += Date.now() - this.pausedAt;
      this.paused = false;
      this.playing = true;
    } else {
      this.proc.kill('SIGSTOP');
      this.pausedAt = Date.now();
      this.paused = true;
      this.playing = false;
    }
  }

  async pause() {
    if (this.proc && !this.paused) await this.togglePause();
  }

  async play() {
    if (this.proc && this.paused) await this.togglePause();
  }

  async setVolume(percent) {
    this.volume = Math.max(0, Math.min(100, percent));
  }

  async seekRelative(seconds) {
    if (!this.proc || !this.currentTrack) return;
    const state = this.getState();
    const durationSec = state.durationMs / 1000;
    const currentSec = state.progressMs / 1000;
    const newSec = Math.max(0, Math.min(durationSec || Infinity, currentSec + seconds));
    const filePath = this.currentTrack;
    const wasPaused = this.paused;

    await this.stopInternal();
    this.durationMs = state.durationMs;
    this.currentTrack = filePath;
    this.proc = spawn(
      'ffplay',
      [
        '-nodisp',
        '-autoexit',
        '-loglevel',
        'quiet',
        '-volume',
        String(this.volume),
        '-ss',
        String(newSec),
        filePath,
      ],
      { stdio: 'ignore' }
    );
    this.playing = !wasPaused;
    this.paused = wasPaused;
    this.startedAt = Date.now() - newSec * 1000;
    this.pauseAccum = 0;

    if (wasPaused) {
      this.pausedAt = Date.now();
      setTimeout(() => {
        if (this.proc && this.paused) this.proc.kill('SIGSTOP');
      }, 100);
    }

    this.proc.on('exit', () => {
      if (this.proc) {
        this.playing = false;
        this.proc = null;
      }
    });
  }

  getState() {
    let progressMs = 0;
    if (this.playing || this.paused) {
      const elapsed = Date.now() - this.startedAt - this.pauseAccum;
      if (this.paused) {
        progressMs = this.pausedAt - this.startedAt - this.pauseAccum;
      } else {
        progressMs = elapsed;
      }
    }

    return {
      playing: this.playing,
      progressMs: Math.max(0, progressMs),
      durationMs: this.durationMs,
      volume: this.volume,
    };
  }

  async stopInternal() {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    this.playing = false;
    this.paused = false;
  }

  async stop() {
    await this.stopInternal();
    this.currentTrack = null;
    this.durationMs = 0;
  }
}

export class OfflinePlayer {
  constructor() {
    this.mpv = new MpvEngine();
    this.ffplay = new FfplayEngine();
    this.engine = null;
    this.tracks = [];
    this.queue = [];
    this.queueIndex = -1;
    this.currentTrack = null;
    this.readyError = null;
  }

  async init() {
    if (!this.engine) {
      if (await this.mpv.ensureAvailable()) {
        this.engine = this.mpv;
        await this.mpv.start();
      } else if (await this.ffplay.ensureAvailable()) {
        this.engine = this.ffplay;
      } else {
        this.readyError =
          'No audio player found. Install mpv (`sudo apt install mpv`) or ffplay.';
      }
    }

    this.rescan();
    return this;
  }

  rescan() {
    this.tracks = scanDir(MUSIC_FOLDER, MUSIC_FOLDER);
  }

  formatDuration(ms) {
    return formatMs(ms);
  }

  getTrackList() {
    return this.tracks;
  }

  getFolders() {
    const folders = new Map();
    for (const track of this.tracks) {
      const folder = track.album;
      if (!folders.has(folder)) {
        folders.set(folder, { id: folder, name: folder, tracks: 0, uri: folder });
      }
      folders.get(folder).tracks += 1;
    }
    return [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getFolderTracks(folderName) {
    return this.tracks.filter((t) => t.album === folderName);
  }

  searchTracks(query, limit = 50) {
    const q = query.toLowerCase();
    return this.tracks
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.artists.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q)
      )
      .slice(0, limit);
  }

  async playTrack(uri) {
    if (this.readyError) throw new Error(this.readyError);

    const index = this.tracks.findIndex((t) => t.path === uri);
    if (index === -1) throw new Error('Track not found');

    this.queue = this.tracks;
    this.queueIndex = index;
    await this.playCurrent();
  }

  async playCurrent() {
    const track = this.queue[this.queueIndex];
    if (!track) return;

    await this.engine.load(track.path);
    this.currentTrack = { ...track };
    const state = await this.engine.getState();
    this.currentTrack.durationMs = state.durationMs || track.durationMs;
  }

  async getPlaybackState() {
    if (this.readyError) {
      return {
        playing: false,
        track: null,
        progressMs: 0,
        device: null,
        error: this.readyError,
      };
    }

    if (!this.currentTrack) {
      return {
        playing: false,
        track: null,
        progressMs: 0,
        device: { name: 'Local files', volume: this.engine?.volume ?? 80 },
      };
    }

    const state = await this.engine.getState();
    const ended =
      state.durationMs > 0 &&
      state.progressMs >= state.durationMs - 500 &&
      !state.playing;

    if (ended && this.queueIndex < this.queue.length - 1) {
      this.queueIndex += 1;
      await this.playCurrent();
      return this.getPlaybackState();
    }

    return {
      playing: state.playing,
      track: {
        ...this.currentTrack,
        durationMs: state.durationMs || this.currentTrack.durationMs,
      },
      progressMs: state.progressMs,
      device: { name: 'Local files', volume: state.volume },
    };
  }

  async togglePlay() {
    if (!this.currentTrack && this.tracks.length > 0) {
      this.queue = this.tracks;
      this.queueIndex = 0;
      await this.playCurrent();
      return;
    }
    if (this.engine) await this.engine.togglePause();
  }

  async play() {
    if (this.engine) await this.engine.play();
  }

  async pause() {
    if (this.engine) await this.engine.pause();
  }

  async next() {
    if (!this.queue.length) return;
    this.queueIndex = (this.queueIndex + 1) % this.queue.length;
    await this.playCurrent();
  }

  async previous() {
    if (!this.queue.length) return;
    const state = await this.engine.getState();
    if (state.progressMs > 3000) {
      await this.playCurrent();
      return;
    }
    this.queueIndex = (this.queueIndex - 1 + this.queue.length) % this.queue.length;
    await this.playCurrent();
  }

  async setVolume(percent) {
    if (this.engine) await this.engine.setVolume(percent);
  }

  async seekRelative(deltaMs) {
    if (!this.engine || !this.currentTrack) return;
    await this.engine.seekRelative(deltaMs / 1000);
  }

  async getPlaylists() {
    return this.getFolders();
  }

  async getPlaylistTracks(folderId) {
    return this.getFolderTracks(folderId);
  }

  async stop() {
    if (this.engine) await this.engine.stop();
    this.currentTrack = null;
    this.queueIndex = -1;
  }
}
