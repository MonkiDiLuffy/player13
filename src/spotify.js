import { ensureValidToken, loadTokens } from './auth.js';
import { formatSpotifyError } from './errors.js';
import { getSpotifyAccessError } from './api-check.js';

function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function formatTrack(track) {
  if (!track) return null;
  return {
    id: track.id,
    name: track.name,
    artists: track.artists.map((a) => a.name).join(', '),
    album: track.album.name,
    durationMs: track.duration_ms,
    uri: track.uri,
  };
}

export class SpotifyPlayer {
  constructor(api) {
    this.api = api;
    this.accessError = null;
  }

  async resolveErrorMessage(err) {
    if (this.accessError) return this.accessError;

    const tokens = loadTokens();
    if (tokens?.accessToken && err?.statusCode === 403) {
      const detail = await getSpotifyAccessError(tokens.accessToken);
      if (detail) {
        this.accessError = detail;
        return detail;
      }
    }

    return formatSpotifyError(err);
  }

  async refreshTokenIfNeeded() {
    const tokens = loadTokens();
    if (tokens) {
      await ensureValidToken(this.api, tokens);
    }
  }

  async getPlaybackState() {
    await this.refreshTokenIfNeeded();
    try {
      const { body } = await this.api.getMyCurrentPlaybackState();
      if (!body || !body.item) {
        return { playing: false, track: null, progressMs: 0, device: null };
      }

      return {
        playing: body.is_playing,
        track: formatTrack(body.item),
        progressMs: body.progress_ms ?? 0,
        device: body.device
          ? { name: body.device.name, volume: body.device.volume_percent }
          : null,
        shuffle: body.shuffle_state,
        repeat: body.repeat_state,
      };
    } catch (err) {
      if (err.statusCode === 204) {
        return { playing: false, track: null, progressMs: 0, device: null };
      }
      if (err.statusCode === 403) {
        return {
          playing: false,
          track: null,
          progressMs: 0,
          device: null,
          error: await this.resolveErrorMessage(err),
        };
      }
      const message = await this.resolveErrorMessage(err);
      throw Object.assign(new Error(message), { statusCode: err.statusCode });
    }
  }

  async play() {
    await this.refreshTokenIfNeeded();
    await this.api.play();
  }

  async pause() {
    await this.refreshTokenIfNeeded();
    await this.api.pause();
  }

  async togglePlay() {
    const state = await this.getPlaybackState();
    if (state.playing) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  async next() {
    await this.refreshTokenIfNeeded();
    await this.api.skipToNext();
  }

  async previous() {
    await this.refreshTokenIfNeeded();
    await this.api.skipToPrevious();
  }

  async setVolume(percent) {
    await this.refreshTokenIfNeeded();
    const volume = Math.max(0, Math.min(100, Math.round(percent)));
    await this.api.setVolume(volume);
  }

  async seekRelative(deltaMs) {
    const state = await this.getPlaybackState();
    if (!state.track) return;
    const position = Math.max(
      0,
      Math.min(state.track.durationMs, state.progressMs + deltaMs)
    );
    await this.refreshTokenIfNeeded();
    await this.api.seek(position);
  }

  async searchTracks(query, limit = 15) {
    await this.refreshTokenIfNeeded();
    const { body } = await this.api.searchTracks(query, { limit });
    return body.tracks.items.map(formatTrack);
  }

  async playTrack(uri) {
    await this.refreshTokenIfNeeded();
    await this.api.play({ uris: [uri] });
  }

  async getPlaylists(limit = 20) {
    await this.refreshTokenIfNeeded();
    const { body } = await this.api.getUserPlaylists({ limit });
    return body.items.map((p) => ({
      id: p.id,
      name: p.name,
      tracks: p.tracks.total,
      uri: p.uri,
    }));
  }

  async getPlaylistTracks(playlistId, limit = 30) {
    await this.refreshTokenIfNeeded();
    const { body } = await this.api.getPlaylistTracks(playlistId, { limit });
    return body.items
      .map((item) => formatTrack(item.track))
      .filter(Boolean);
  }

  formatDuration(ms) {
    return formatMs(ms);
  }
}
