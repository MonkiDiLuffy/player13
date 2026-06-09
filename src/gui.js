import { basename } from 'path';
import {
  Adjustment,
  Align,
  Application,
  ApplicationFlags,
  Box,
  Button,
  CssProvider,
  Display,
  DrawingArea,
  Entry,
  Image,
  Label,
  ListBox,
  Orientation,
  PolicyType,
  ProgressBar,
  Scale,
  ScrolledWindow,
  SelectionMode,
  StyleContext,
  StyleProviderPriority,
} from '@sigmasd/gtk/gtk4';
import {
  AdwApplicationWindow,
  ActionRow,
  HeaderBar,
  MessageDialog,
  StyleManager,
  ToolbarView,
} from '@sigmasd/gtk/adw';
import { EventLoop } from '@sigmasd/gtk/eventloop';
import { formatSpotifyError } from './errors.js';
import { MUSIC_FOLDER } from './config.js';
import { downloadYouTubeAudio } from './youtube.js';

const SEEK_MS = 10_000;
const VIS_BARS = 28;
const APP_ID = 'com.xiii.player13';
const ELLIPSIZE_END = 3;

const THEME = {
  online: { accent: '#1db954', icon: 'audio-x-generic-symbolic', label: 'Spotify' },
  offline: { accent: '#c084fc', icon: 'folder-music-symbolic', label: 'Offline' },
};

function hashNoise(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43_758.5453;
  return x - Math.floor(x);
}

function computeAudioLevels(progressMs, barCount, trackKey = '', amplitude = 1) {
  const t = progressMs / 1000;
  const seed = trackKey.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const levels = [];

  for (let i = 0; i < barCount; i++) {
    const band = i / barCount;
    const bassWeight = 1 - band * 0.55;
    const freq1 = 2.2 + i * 0.48;
    const freq2 = 4.8 + i * 0.31;
    const freq3 = 0.9 + (i % 4) * 0.14;
    const noise = hashNoise(t * 3.7 + i * 17 + seed);

    const wave =
      ((Math.sin(t * freq1 * Math.PI + i * 0.75 + seed * 0.01) + 1) / 2) * 0.34 * bassWeight +
      ((Math.sin(t * freq2 * Math.PI + i * 1.15) + 1) / 2) * 0.28 +
      ((Math.sin(t * freq3 * Math.PI * 2 + hashNoise(i + seed)) + 1) / 2) * 0.22 +
      noise * 0.16;

    const beat = ((Math.sin(t * Math.PI * 2 + seed * 0.02) + 1) / 2) * 0.14 * bassWeight;
    levels.push(Math.min(1, Math.max(0.04, (wave + beat) * amplitude)));
  }

  return levels;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function escapeMarkup(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function applyAppStyles() {
  const provider = new CssProvider();
  provider.loadFromData(`
    window.player13 { background-color: #121212; color: #ffffff; }

    .p13-header { background-color: #080808; color: #ffffff; }
    .app-title { font-weight: 800; font-size: 1.05em; color: #ffffff; }

    .mode-pill {
      border-radius: 9999px;
      padding: 4px 16px;
      font-weight: 700;
      background-color: #1f1f1f;
    }
    .mode-pill.mode-online { color: #1db954; }
    .mode-pill.mode-offline { color: #c084fc; }
    .mode-pill:hover { background-color: #2a2a2a; }

    .sidebar {
      background-color: #000000;
      border-radius: 12px;
      padding: 14px 10px;
    }
    .sidebar-title {
      color: #b3b3b3;
      font-weight: 800;
      font-size: 0.78em;
      padding: 2px 8px;
    }
    .nav-btn {
      background-color: transparent;
      color: #b3b3b3;
      font-weight: 700;
      border-radius: 8px;
      padding: 8px 10px;
    }
    .nav-btn:hover { color: #ffffff; background-color: #1a1a1a; }

    entry.search {
      background-color: #242424;
      color: #ffffff;
      border-radius: 9999px;
      padding: 8px 16px;
      border: 1px solid #2e2e2e;
    }
    entry.search:focus-within { border-color: #535353; }

    .hero { border-radius: 14px; padding: 20px; }
    .hero.hero-online {
      background-image: linear-gradient(135deg, #14532d, #16281c 55%, #121212);
    }
    .hero.hero-offline {
      background-image: linear-gradient(135deg, #4c1d95, #2a1b3d 55%, #121212);
    }

    .art-box { border-radius: 10px; min-width: 104px; min-height: 104px; }
    .art-box.art-online { background-image: linear-gradient(160deg, #1db954, #0d6e33); }
    .art-box.art-offline { background-image: linear-gradient(160deg, #a855f7, #5b21b6); }
    .art-box image { color: rgba(0, 0, 0, 0.65); }

    .np-chip {
      font-weight: 800;
      font-size: 0.72em;
      color: rgba(255, 255, 255, 0.85);
    }
    .np-title { font-size: 1.9em; font-weight: 900; color: #ffffff; }
    .np-artist { color: #e6e6e6; font-weight: 600; }
    .np-album { color: #9a9a9a; font-size: 0.88em; }

    .lib-label { color: #ffffff; font-weight: 800; font-size: 1.02em; }

    list.tracklist { background-color: transparent; }
    list.tracklist row { border-radius: 8px; padding: 2px 8px; }
    list.tracklist row:hover { background-color: #1d1d1d; }
    list.tracklist row:selected { background-color: #2a2a2a; }
    .row-duration { color: #8f8f8f; font-size: 0.85em; }

    .player-bar {
      background-color: #181818;
      border-top: 1px solid #282828;
      padding: 10px 16px;
    }
    .bar-art { border-radius: 6px; min-width: 48px; min-height: 48px; }
    .bar-title { color: #ffffff; font-weight: 700; font-size: 0.92em; }
    .bar-artist { color: #a0a0a0; font-size: 0.8em; }
    .time-label { color: #a0a0a0; font-size: 0.76em; }

    .play-btn {
      background-color: #ffffff;
      color: #000000;
      border-radius: 9999px;
      min-width: 42px;
      min-height: 42px;
      padding: 0;
    }
    .play-btn:hover { background-color: #f0f0f0; }
    .ctrl-btn {
      background-color: transparent;
      color: #b3b3b3;
      border-radius: 9999px;
      min-width: 32px;
      min-height: 32px;
      padding: 0;
    }
    .ctrl-btn:hover { color: #ffffff; background-color: rgba(255, 255, 255, 0.08); }

    scale.seekbar { padding: 0; }
    scale.seekbar trough {
      background-color: #4d4d4d;
      border-radius: 3px;
      min-height: 5px;
    }
    scale.seekbar highlight { background-color: #ffffff; border-radius: 3px; }
    scale.seekbar:hover highlight { background-color: #1db954; }
    scale.seekbar slider {
      background-color: #ffffff;
      border-radius: 9999px;
      min-width: 13px;
      min-height: 13px;
      opacity: 0;
    }
    scale.seekbar:hover slider { opacity: 1; }

    scale.volbar trough {
      background-color: #4d4d4d;
      border-radius: 3px;
      min-height: 4px;
    }
    scale.volbar highlight { background-color: #ffffff; border-radius: 3px; }
    scale.volbar:hover highlight { background-color: #1db954; }
    scale.volbar slider {
      background-color: #ffffff;
      border-radius: 9999px;
      min-width: 11px;
      min-height: 11px;
      opacity: 0;
    }
    scale.volbar:hover slider { opacity: 1; }
    .vol-icon { color: #b3b3b3; }
  `);
  const display = Display.getDefault();
  if (display) {
    StyleContext.addProviderForDisplay(display, provider, StyleProviderPriority.APPLICATION);
  }
}

function showMessage(parent, heading, body) {
  const dialog = new MessageDialog(parent, heading, body);
  dialog.addResponse('ok', 'OK');
  dialog.setDefaultResponse('ok');
  dialog.setCloseResponse('ok');
  dialog.present();
}

function showError(parent, err) {
  const msg = typeof err === 'string' ? err : formatSpotifyError(err);
  showMessage(parent, 'Error', msg);
}

export function createPlayerGUI({ getSpotifyPlayer, offlinePlayer, initialMode = 'online' }) {
  applyAppStyles();
  StyleManager.getDefault().setColorScheme(2); // PREFER_DARK

  const app = new Application(APP_ID, ApplicationFlags.NONE);
  const eventLoop = new EventLoop();

  let mode = initialMode;
  let spotifyPlayer = null;
  let listMode = 'idle';
  let listData = [];
  let pollTimer = null;
  let animTimer = null;
  let lastPlaybackState = null;
  let lastPollAt = 0;
  let displayedLevels = Array(VIS_BARS).fill(0.05);
  let accentColor = THEME.online.accent;

  // Control-state guards (fix slider feedback loops and API spam).
  let progressUpdating = false;
  let seekDragging = false;
  let seekCommitTimer = null;
  let volumeUpdating = false;
  let volumeCommitTimer = null;
  let lastVolumeInteraction = 0;
  let lastElapsedText = '';

  let win;
  let statusChip;
  let heroBox;
  let artBox;
  let heroArt;
  let heroTitle;
  let heroArtist;
  let heroAlbum;
  let visualizerArea;
  let barArtBox;
  let barArt;
  let barTitle;
  let barArtist;
  let playButton;
  let elapsedLabel;
  let durationLabel;
  let progressAdjustment;
  let progressScale;
  let volumeAdjustment;
  let volumeScale;
  let libraryLabel;
  let listBox;
  let searchEntry;
  let modeButton;
  let playlistsNavBtn;
  let rescanButton;
  let downloadButton;

  function isOffline() {
    return mode === 'offline';
  }

  function activePlayer() {
    return isOffline() ? offlinePlayer : spotifyPlayer;
  }

  function theme() {
    return THEME[isOffline() ? 'offline' : 'online'];
  }

  function interpolatedProgress(state) {
    if (!state?.playing || !state.track) return state?.progressMs ?? 0;
    const elapsed = Date.now() - lastPollAt;
    return Math.min(state.track.durationMs || Infinity, (state.progressMs ?? 0) + elapsed);
  }

  function swapCss(widget, removeClass, addClass) {
    widget.removeCssClass(removeClass);
    widget.addCssClass(addClass);
  }

  function updateModeChrome() {
    const { accent, icon, label } = theme();
    accentColor = accent;

    modeButton.setLabel(label);
    if (isOffline()) {
      swapCss(modeButton, 'mode-online', 'mode-offline');
      swapCss(heroBox, 'hero-online', 'hero-offline');
      swapCss(artBox, 'art-online', 'art-offline');
      swapCss(barArtBox, 'art-online', 'art-offline');
    } else {
      swapCss(modeButton, 'mode-offline', 'mode-online');
      swapCss(heroBox, 'hero-offline', 'hero-online');
      swapCss(artBox, 'art-offline', 'art-online');
      swapCss(barArtBox, 'art-offline', 'art-online');
    }

    heroArt.setFromIconName(icon);
    barArt.setFromIconName(icon);
    playlistsNavBtn.setLabel(isOffline() ? 'Folders' : 'Playlists');
    rescanButton.setVisible(isOffline());
    downloadButton.setVisible(isOffline());
    searchEntry.setPlaceholderText(
      isOffline() ? 'Search your library' : 'What do you want to play?'
    );
    visualizerArea.queueDraw();
  }

  function updateProgressUI(progressMs, durationMs) {
    durationLabel.setText(fmt(durationMs));
    if (seekDragging) return; // let the user's drag own the UI

    const text = fmt(durationMs > 0 ? Math.min(progressMs, durationMs) : 0);
    if (text !== lastElapsedText) {
      lastElapsedText = text;
      elapsedLabel.setText(text);
    }

    progressUpdating = true;
    progressAdjustment.setValue(
      durationMs > 0 ? Math.min(1000, (progressMs / durationMs) * 1000) : 0
    );
    progressUpdating = false;
  }

  function renderNowPlaying(state) {
    lastPlaybackState = state;

    if (state.error) {
      statusChip.setText(isOffline() ? '⚠ OFFLINE PLAYER ISSUE' : '⚠ SPOTIFY UNAVAILABLE');
      heroTitle.setText(state.error.slice(0, 120));
      heroArtist.setText(isOffline() ? '' : 'Switch to Offline mode to play local files');
      heroAlbum.setText('');
      barTitle.setText('Player13');
      barArtist.setText('No playback');
      updateProgressUI(0, 0);
      playButton.setIconName('media-playback-start-symbolic');
      visualizerArea.queueDraw();
      return;
    }

    if (!state.track) {
      statusChip.setText(isOffline() ? 'LOCAL LIBRARY' : 'SPOTIFY');
      heroTitle.setText('Nothing playing');
      heroArtist.setText(
        isOffline()
          ? `Add audio files to ${MUSIC_FOLDER}, then hit Rescan`
          : 'Search or pick a track to start listening'
      );
      heroAlbum.setText('');
      barTitle.setText('—');
      barArtist.setText('');
      updateProgressUI(0, 0);
      playButton.setIconName('media-playback-start-symbolic');
      visualizerArea.queueDraw();
      return;
    }

    statusChip.setText(
      state.playing
        ? isOffline() ? '▶ PLAYING · LOCAL' : '▶ PLAYING · SPOTIFY'
        : '⏸ PAUSED'
    );
    heroTitle.setText(state.track.name);
    heroArtist.setText(state.track.artists);
    heroAlbum.setText(state.track.album || '');
    barTitle.setText(state.track.name);
    barArtist.setText(state.track.artists);

    const duration = state.track.durationMs || 0;
    const progressMs = state.playing ? interpolatedProgress(state) : state.progressMs ?? 0;
    updateProgressUI(progressMs, duration);

    // Only sync the volume slider when the user hasn't touched it recently —
    // otherwise stale poll data fights the drag and the knob jumps back.
    if (state.device?.volume != null && Date.now() - lastVolumeInteraction > 1500) {
      const polled = state.device.volume;
      if (Math.abs(polled - volumeAdjustment.getValue()) > 1) {
        volumeUpdating = true;
        volumeAdjustment.setValue(polled);
        volumeUpdating = false;
      }
    }

    playButton.setIconName(
      state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic'
    );
    visualizerArea.queueDraw();
  }

  function drawVisualizer(_area, cr, width, height) {
    const rgb = hexToRgb(accentColor);
    const gap = 4;
    const barWidth = Math.max(3, (width - gap * (VIS_BARS - 1)) / VIS_BARS);
    const r = barWidth / 2;
    const playing = Boolean(lastPlaybackState?.playing);

    for (let i = 0; i < VIS_BARS; i++) {
      const level = displayedLevels[i] ?? 0.05;
      const barHeight = Math.max(3, level * (height - r));
      const x = i * (barWidth + gap);
      const y = height - barHeight;
      const alpha = playing ? 0.35 + level * 0.6 : 0.16;

      cr.setSourceRgba(rgb.r, rgb.g, rgb.b, alpha);
      cr.arc(x + r, y + r, r, Math.PI, 2 * Math.PI);
      cr.fill();
      cr.rectangle(x, y + r, barWidth, Math.max(1, barHeight - r));
      cr.fill();
    }
  }

  async function refreshPlayback() {
    const current = activePlayer();
    if (!current) {
      renderNowPlaying({
        playing: false,
        track: null,
        progressMs: 0,
        device: null,
        error: 'Spotify not connected — switch to Offline mode',
      });
      return;
    }

    try {
      const state = await current.getPlaybackState();
      lastPollAt = Date.now();
      if (state.playing && state.track) {
        const trackKey = state.track.id || state.track.uri || state.track.name || '';
        displayedLevels = computeAudioLevels(
          state.progressMs ?? 0,
          VIS_BARS,
          trackKey,
          state.audioAmplitude ?? 1
        );
      } else {
        displayedLevels = Array(VIS_BARS).fill(0.05);
      }
      renderNowPlaying(state);
    } catch (err) {
      renderNowPlaying({
        playing: false,
        track: null,
        progressMs: 0,
        device: null,
        error: formatSpotifyError(err),
      });
    }
  }

  // Animation tick only interpolates progress and the visualizer; the full
  // render (labels, volume, icons) happens on poll. The old code re-rendered
  // everything every 60ms which made the volume slider unusable.
  function tickAnimation() {
    const state = lastPlaybackState;
    if (!state?.playing || !state.track) return;

    const progressMs = interpolatedProgress(state);
    const trackKey = state.track.id || state.track.uri || state.track.name || '';
    const target = computeAudioLevels(
      progressMs,
      VIS_BARS,
      trackKey,
      state.audioAmplitude ?? 1
    );

    displayedLevels = displayedLevels.map((level, index) => {
      const delta = target[index] - level;
      return level + delta * 0.42;
    });

    visualizerArea.queueDraw();
    updateProgressUI(progressMs, state.track.durationMs || 0);
  }

  async function seekBy(deltaMs) {
    const current = activePlayer();
    if (!current) return showError(win, 'No active player');
    try {
      await current.seekRelative(deltaMs);
      setTimeout(refreshPlayback, 150);
    } catch (e) {
      showError(win, e);
    }
  }

  async function commitSeek() {
    const state = lastPlaybackState;
    const current = activePlayer();
    const duration = state?.track?.durationMs || 0;
    if (!current || !duration) {
      seekDragging = false;
      return;
    }

    const targetMs = (progressAdjustment.getValue() / 1000) * duration;
    const deltaMs = targetMs - interpolatedProgress(state);

    try {
      await current.seekRelative(deltaMs);
    } catch (e) {
      showError(win, e);
    } finally {
      setTimeout(() => {
        seekDragging = false;
        refreshPlayback();
      }, 200);
    }
  }

  function setListItems(items, label, listModeValue) {
    listData = items;
    listMode = listModeValue;
    libraryLabel.setText(label);
    listBox.removeAll();

    if (!items.length) {
      const row = new ActionRow();
      row.setTitle('No results');
      row.setSensitive(false);
      listBox.append(row);
      return;
    }

    for (const item of items) {
      const row = new ActionRow();
      if (listModeValue === 'playlists') {
        row.setTitle(escapeMarkup(item.name));
        row.setSubtitle(escapeMarkup(`${item.tracks} tracks`));
        const chevron = new Image({ iconName: 'go-next-symbolic' });
        row.addSuffix(chevron);
      } else {
        row.setTitle(escapeMarkup(item.name));
        row.setSubtitle(escapeMarkup(`${item.artists} — ${item.album}`));
        if (item.durationMs > 0) {
          const duration = new Label(fmt(item.durationMs));
          duration.addCssClass('row-duration');
          row.addSuffix(duration);
        }
      }
      listBox.append(row);
    }
  }

  async function loadLibraryList() {
    if (isOffline()) {
      const tracks = offlinePlayer.getTrackList();
      setListItems(tracks, `Your Library · ${tracks.length} tracks`, 'tracks');
      return;
    }

    libraryLabel.setText('Library — search or open your playlists');
    listBox.removeAll();
    listMode = 'idle';
    listData = [];
  }

  async function runSearch(query) {
    const current = activePlayer();
    if (!current) {
      showError(win, 'Spotify not connected');
      return;
    }

    const trimmed = query?.trim();
    if (!trimmed) return;

    try {
      const tracks = await current.searchTracks(trimmed);
      setListItems(tracks, `Results for “${trimmed}”`, 'tracks');
    } catch (e) {
      showError(win, e);
    }
  }

  async function loadPlaylists() {
    const current = activePlayer();
    if (!current) {
      showError(win, 'Spotify not connected');
      return;
    }

    try {
      const playlists = await current.getPlaylists();
      setListItems(playlists, isOffline() ? 'Music Folders' : 'Your Playlists', 'playlists');
    } catch (e) {
      showError(win, e);
    }
  }

  async function rescanLibrary() {
    if (!isOffline()) return;
    offlinePlayer.rescan();
    await loadLibraryList();
    refreshPlayback();
  }

  function openUrlDialog(heading, body, placeholder, onSubmit) {
    const dialog = new AdwApplicationWindow(app);
    dialog.setTitle(heading);
    dialog.setDefaultSize(480, 180);
    dialog.setModal(true);
    dialog.setTransientFor(win);

    const box = new Box(Orientation.VERTICAL, 12);
    box.setMarginTop(16);
    box.setMarginBottom(16);
    box.setMarginStart(16);
    box.setMarginEnd(16);

    const desc = new Label(body);
    desc.setWrap(true);
    desc.setXalign(0);

    const entry = new Entry();
    entry.setPlaceholderText(placeholder);

    const actions = new Box(Orientation.HORIZONTAL, 8);
    actions.setHalign(Align.END);

    const cancelBtn = new Button('Cancel');
    cancelBtn.onClick(() => dialog.destroy());

    const submitBtn = new Button('Download');
    submitBtn.addCssClass('suggested-action');
    submitBtn.onClick(async () => {
      const value = entry.getText().trim();
      if (!value) return;
      submitBtn.setSensitive(false);
      await onSubmit(value, dialog);
      if (dialog.getVisible()) {
        submitBtn.setSensitive(true);
      }
    });

    actions.append(cancelBtn);
    actions.append(submitBtn);

    box.append(desc);
    box.append(entry);
    box.append(actions);
    dialog.setContent(box);
    dialog.present();
    entry.grabFocus();
  }

  async function runYouTubeDownload() {
    if (!isOffline()) return;

    openUrlDialog(
      'YouTube Download',
      'Paste a YouTube URL to save audio into your music folder.',
      'https://youtube.com/watch?v=…',
      async (url, dialog) => {
        dialog.destroy();

        const progressWin = new AdwApplicationWindow(app);
        progressWin.setTitle('Downloading…');
        progressWin.setDefaultSize(420, 120);
        progressWin.setModal(true);
        progressWin.setTransientFor(win);

        const progressBox = new Box(Orientation.VERTICAL, 12);
        progressBox.setMarginTop(16);
        progressBox.setMarginBottom(16);
        progressBox.setMarginStart(16);
        progressBox.setMarginEnd(16);

        const status = new Label('Fetching audio from YouTube…');
        status.setXalign(0);
        const bar = new ProgressBar();
        bar.setShowText(true);

        progressBox.append(status);
        progressBox.append(bar);
        progressWin.setContent(progressBox);
        progressWin.present();

        clearInterval(pollTimer);

        try {
          const result = await downloadYouTubeAudio(url, (update) => {
            const pct = update.progress?.percentage;
            if (pct !== undefined) {
              bar.setFraction(pct / 100);
              bar.setText(update.progress.percentage_str || `${Math.round(pct)}%`);
            }
            if (update.title) {
              status.setText(update.title);
            }
          });

          progressWin.destroy();
          offlinePlayer.rescan();
          await loadLibraryList();

          const fileName = basename(result.savedPath);
          showMessage(win, 'Download complete', `Saved: ${fileName}`);
        } catch (e) {
          progressWin.destroy();
          showError(win, e);
        } finally {
          startPolling();
        }
      }
    );
  }

  async function playSelection(index) {
    const current = activePlayer();
    if (!current) return;

    const item = listData[index];
    if (!item) return;

    try {
      if (listMode === 'playlists') {
        const tracks = await current.getPlaylistTracks(item.id);
        setListItems(tracks, item.name, 'tracks');
      } else if (listMode === 'tracks' && item.uri) {
        await current.playTrack(item.uri);
        setTimeout(refreshPlayback, 300);
      }
    } catch (e) {
      showError(win, e);
    }
  }

  async function switchMode() {
    if (isOffline()) {
      try {
        await offlinePlayer.stop();
        if (!spotifyPlayer) {
          spotifyPlayer = await getSpotifyPlayer();
        }
        mode = 'online';
      } catch (e) {
        showError(win, e.message || 'Could not connect to Spotify');
        return;
      }
    } else {
      mode = 'offline';
    }

    updateModeChrome();
    await loadLibraryList();
    startPolling();
    refreshPlayback();
  }

  function startPolling() {
    clearInterval(pollTimer);
    const interval = isOffline() ? 500 : 2000;
    pollTimer = setInterval(refreshPlayback, interval);
  }

  function startAnimation() {
    clearInterval(animTimer);
    animTimer = setInterval(tickAnimation, 60);
  }

  function makeControlButton(icon, tooltip, onClick) {
    const btn = new Button();
    btn.setIconName(icon);
    btn.setTooltipText(tooltip);
    btn.addCssClass('ctrl-btn');
    btn.addCssClass('flat');
    btn.onClick(onClick);
    return btn;
  }

  function buildSidebar() {
    const sidebar = new Box(Orientation.VERTICAL, 4);
    sidebar.addCssClass('sidebar');
    sidebar.setSizeRequest(200, -1);

    const sideTitle = new Label('YOUR LIBRARY');
    sideTitle.addCssClass('sidebar-title');
    sideTitle.setXalign(0);
    sidebar.append(sideTitle);

    const libraryNavBtn = new Button('Tracks');
    libraryNavBtn.addCssClass('nav-btn');
    libraryNavBtn.addCssClass('flat');
    libraryNavBtn.onClick(() => loadLibraryList());
    sidebar.append(libraryNavBtn);

    playlistsNavBtn = new Button('Playlists');
    playlistsNavBtn.addCssClass('nav-btn');
    playlistsNavBtn.addCssClass('flat');
    playlistsNavBtn.onClick(() => loadPlaylists());
    sidebar.append(playlistsNavBtn);

    rescanButton = new Button('Rescan folder');
    rescanButton.addCssClass('nav-btn');
    rescanButton.addCssClass('flat');
    rescanButton.setTooltipText(`Rescan ${MUSIC_FOLDER}`);
    rescanButton.onClick(() => rescanLibrary());
    sidebar.append(rescanButton);

    downloadButton = new Button('Download audio');
    downloadButton.addCssClass('nav-btn');
    downloadButton.addCssClass('flat');
    downloadButton.setTooltipText('Download audio from a YouTube URL');
    downloadButton.onClick(() => runYouTubeDownload());
    sidebar.append(downloadButton);

    return sidebar;
  }

  function buildHero() {
    heroBox = new Box(Orientation.HORIZONTAL, 18);
    heroBox.addCssClass('hero');
    heroBox.addCssClass('hero-online');

    artBox = new Box(Orientation.VERTICAL, 0);
    artBox.addCssClass('art-box');
    artBox.addCssClass('art-online');
    artBox.setValign(Align.CENTER);
    heroArt = new Image({ iconName: THEME.online.icon });
    heroArt.setPixelSize(48);
    heroArt.setHexpand(true);
    heroArt.setVexpand(true);
    heroArt.setHalign(Align.CENTER);
    heroArt.setValign(Align.CENTER);
    artBox.append(heroArt);

    const infoBox = new Box(Orientation.VERTICAL, 4);
    infoBox.setValign(Align.CENTER);

    statusChip = new Label('');
    statusChip.addCssClass('np-chip');
    statusChip.setXalign(0);

    heroTitle = new Label('');
    heroTitle.addCssClass('np-title');
    heroTitle.setXalign(0);
    heroTitle.setEllipsize(ELLIPSIZE_END);

    heroArtist = new Label('');
    heroArtist.addCssClass('np-artist');
    heroArtist.setXalign(0);
    heroArtist.setEllipsize(ELLIPSIZE_END);

    heroAlbum = new Label('');
    heroAlbum.addCssClass('np-album');
    heroAlbum.setXalign(0);
    heroAlbum.setEllipsize(ELLIPSIZE_END);

    infoBox.append(statusChip);
    infoBox.append(heroTitle);
    infoBox.append(heroArtist);
    infoBox.append(heroAlbum);

    visualizerArea = new DrawingArea();
    visualizerArea.setContentHeight(96);
    visualizerArea.setHexpand(true);
    visualizerArea.setValign(Align.END);
    visualizerArea.setDrawFunc(drawVisualizer);

    heroBox.append(artBox);
    heroBox.append(infoBox);
    heroBox.append(visualizerArea);
    return heroBox;
  }

  function buildPlayerBar() {
    const bar = new Box(Orientation.HORIZONTAL, 16);
    bar.addCssClass('player-bar');

    // Left: mini art + track info
    const left = new Box(Orientation.HORIZONTAL, 10);
    left.setSizeRequest(230, -1);

    barArtBox = new Box(Orientation.VERTICAL, 0);
    barArtBox.addCssClass('bar-art');
    barArtBox.addCssClass('art-online');
    barArtBox.setValign(Align.CENTER);
    barArt = new Image({ iconName: THEME.online.icon });
    barArt.setPixelSize(22);
    barArt.setHexpand(true);
    barArt.setVexpand(true);
    barArt.setHalign(Align.CENTER);
    barArt.setValign(Align.CENTER);
    barArtBox.append(barArt);

    const trackBox = new Box(Orientation.VERTICAL, 2);
    trackBox.setValign(Align.CENTER);
    barTitle = new Label('—');
    barTitle.addCssClass('bar-title');
    barTitle.setXalign(0);
    barTitle.setEllipsize(ELLIPSIZE_END);
    barArtist = new Label('');
    barArtist.addCssClass('bar-artist');
    barArtist.setXalign(0);
    barArtist.setEllipsize(ELLIPSIZE_END);
    trackBox.append(barTitle);
    trackBox.append(barArtist);

    left.append(barArtBox);
    left.append(trackBox);

    // Center: transport controls + seek bar
    const center = new Box(Orientation.VERTICAL, 6);
    center.setHexpand(true);
    center.setValign(Align.CENTER);

    const controls = new Box(Orientation.HORIZONTAL, 10);
    controls.setHalign(Align.CENTER);

    const seekBackBtn = makeControlButton(
      'media-seek-backward-symbolic',
      'Seek −10s',
      () => seekBy(-SEEK_MS)
    );
    const prevBtn = makeControlButton(
      'media-skip-backward-symbolic',
      'Previous',
      async () => {
        const current = activePlayer();
        if (!current) return;
        try {
          await current.previous();
          setTimeout(refreshPlayback, 300);
        } catch (e) {
          showError(win, e);
        }
      }
    );

    playButton = new Button();
    playButton.setIconName('media-playback-start-symbolic');
    playButton.setTooltipText('Play / Pause');
    playButton.addCssClass('play-btn');
    playButton.onClick(async () => {
      const current = activePlayer();
      if (!current) return showError(win, 'No active player');
      try {
        await current.togglePlay();
        setTimeout(refreshPlayback, 200);
      } catch (e) {
        showError(win, e);
      }
    });

    const nextBtn = makeControlButton(
      'media-skip-forward-symbolic',
      'Next',
      async () => {
        const current = activePlayer();
        if (!current) return;
        try {
          await current.next();
          setTimeout(refreshPlayback, 300);
        } catch (e) {
          showError(win, e);
        }
      }
    );
    const seekFwdBtn = makeControlButton(
      'media-seek-forward-symbolic',
      'Seek +10s',
      () => seekBy(SEEK_MS)
    );

    controls.append(seekBackBtn);
    controls.append(prevBtn);
    controls.append(playButton);
    controls.append(nextBtn);
    controls.append(seekFwdBtn);

    const progressRow = new Box(Orientation.HORIZONTAL, 8);
    elapsedLabel = new Label('0:00');
    elapsedLabel.addCssClass('time-label');
    elapsedLabel.setSizeRequest(40, -1);
    elapsedLabel.setXalign(1);

    progressAdjustment = new Adjustment(0, 0, 1000, 5, 50, 0);
    progressScale = new Scale(Orientation.HORIZONTAL, progressAdjustment);
    progressScale.addCssClass('seekbar');
    progressScale.setDrawValue(false);
    progressScale.setHexpand(true);
    progressScale.onValueChanged(() => {
      if (progressUpdating) return;
      const duration = lastPlaybackState?.track?.durationMs || 0;
      if (!duration) return;
      seekDragging = true;
      elapsedLabel.setText(fmt((progressAdjustment.getValue() / 1000) * duration));
      clearTimeout(seekCommitTimer);
      seekCommitTimer = setTimeout(commitSeek, 350);
    });

    durationLabel = new Label('0:00');
    durationLabel.addCssClass('time-label');
    durationLabel.setSizeRequest(40, -1);
    durationLabel.setXalign(0);

    progressRow.append(elapsedLabel);
    progressRow.append(progressScale);
    progressRow.append(durationLabel);

    center.append(controls);
    center.append(progressRow);

    // Right: volume
    const right = new Box(Orientation.HORIZONTAL, 8);
    right.setValign(Align.CENTER);
    right.setHalign(Align.END);

    const volIcon = new Image({ iconName: 'audio-volume-high-symbolic' });
    volIcon.addCssClass('vol-icon');
    volIcon.setPixelSize(16);

    volumeAdjustment = new Adjustment(80, 0, 100, 5, 10, 0);
    volumeScale = new Scale(Orientation.HORIZONTAL, volumeAdjustment);
    volumeScale.addCssClass('volbar');
    volumeScale.setDrawValue(false);
    volumeScale.setSizeRequest(110, -1);
    volumeScale.setTooltipText('Volume');
    volumeScale.onValueChanged(() => {
      if (volumeUpdating) return;
      lastVolumeInteraction = Date.now();
      clearTimeout(volumeCommitTimer);
      volumeCommitTimer = setTimeout(async () => {
        const current = activePlayer();
        if (!current) return;
        try {
          await current.setVolume(Math.round(volumeAdjustment.getValue()));
        } catch (e) {
          showError(win, e);
        }
      }, 200);
    });

    right.append(volIcon);
    right.append(volumeScale);

    bar.append(left);
    bar.append(center);
    bar.append(right);
    return bar;
  }

  function buildWindow() {
    win = new AdwApplicationWindow(app);
    win.setTitle('Player13');
    win.setDefaultSize(1060, 720);
    win.addCssClass('player13');

    const toolbar = new ToolbarView();

    const header = new HeaderBar();
    header.addCssClass('p13-header');
    const titleWidget = new Label('Player13');
    titleWidget.addCssClass('app-title');
    header.setTitleWidget(titleWidget);

    modeButton = new Button('Spotify');
    modeButton.addCssClass('mode-pill');
    modeButton.addCssClass('mode-online');
    modeButton.setTooltipText('Toggle Spotify / Offline mode');
    modeButton.onClick(() => switchMode());
    header.packEnd(modeButton);

    toolbar.addTopBar(header);

    // Main area: sidebar + content
    const main = new Box(Orientation.HORIZONTAL, 14);
    main.setMarginTop(14);
    main.setMarginBottom(14);
    main.setMarginStart(14);
    main.setMarginEnd(14);
    main.setVexpand(true);

    const sidebar = buildSidebar();

    const content = new Box(Orientation.VERTICAL, 12);
    content.setHexpand(true);

    searchEntry = new Entry();
    searchEntry.addCssClass('search');
    searchEntry.setPlaceholderText('What do you want to play?');
    searchEntry.onActivate(() => runSearch(searchEntry.getText()));

    const hero = buildHero();

    libraryLabel = new Label('');
    libraryLabel.addCssClass('lib-label');
    libraryLabel.setXalign(0);

    listBox = new ListBox();
    listBox.addCssClass('tracklist');
    listBox.setSelectionMode(SelectionMode.SINGLE);
    listBox.onRowActivated((row) => {
      const index = row.getIndex();
      if (index >= 0) playSelection(index);
    });

    const scrolled = new ScrolledWindow();
    scrolled.setPolicy(PolicyType.NEVER, PolicyType.AUTOMATIC);
    scrolled.setMinContentHeight(180);
    scrolled.setVexpand(true);
    scrolled.setChild(listBox);

    content.append(searchEntry);
    content.append(hero);
    content.append(libraryLabel);
    content.append(scrolled);

    main.append(sidebar);
    main.append(content);

    toolbar.setContent(main);
    toolbar.addBottomBar(buildPlayerBar());
    win.setContent(toolbar);

    win.onCloseRequest(() => {
      clearInterval(pollTimer);
      clearInterval(animTimer);
      clearTimeout(seekCommitTimer);
      clearTimeout(volumeCommitTimer);
      offlinePlayer.stop().finally(() => {
        eventLoop.stop();
        app.quit();
      });
      return true;
    });

    updateModeChrome();
    loadLibraryList();
    startPolling();
    startAnimation();
    refreshPlayback();
    win.present();
  }

  app.onActivate(() => {
    if (!spotifyPlayer && !isOffline()) {
      getSpotifyPlayer()
        .then((player) => {
          spotifyPlayer = player;
          buildWindow();
        })
        .catch(() => {
          mode = 'offline';
          buildWindow();
        });
    } else {
      buildWindow();
    }
  });

  app.onShutdown(() => {
    clearInterval(pollTimer);
    clearInterval(animTimer);
  });

  eventLoop.start(app);

  return {
    destroy() {
      clearInterval(pollTimer);
      clearInterval(animTimer);
      eventLoop.stop();
      app.quit();
    },
  };
}
