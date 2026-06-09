import blessed from 'blessed';
import { basename } from 'path';
import { formatSpotifyError } from './errors.js';
import { MUSIC_FOLDER } from './config.js';
import { downloadYouTubeAudio } from './youtube.js';

const SEEK_MS = 10_000;
const VISUALIZER_BARS = '▁▂▃▄▅▆▇█';
const VISUALIZER_WIDTH = 12;
const LOGO = [
  '▄▖▖ ▄▖▖▖▄▖▄▖▗ ▄▖',
  '▙▌▌ ▌▌▌▌▙▖▙▘▜ ▄▌',
  '▌ ▙▖▛▌▐ ▙▖▌▌▟▖▄▌',
];
const THEME = {
  online: { accentHex: '#22c55e', headerBg: 'green' },
  offline: { accentHex: '#a855f7', headerBg: '#6b21a8' },
};

const KEY_HINT_GROUPS = {
  playback: [
    { key: 'Space', label: 'Play/Pause' },
    { key: ', .', label: '±10s' },
    { key: 'n / p', label: 'Next / Prev' },
  ],
  library: [
    { key: '/', label: 'Search' },
    { key: 'Enter', label: 'Play' },
    { key: 'l', label: 'Library' },
  ],
  system: [
    { key: '+ / -', label: 'Volume' },
    { key: 'o', label: 'Mode' },
    { key: 'q', label: 'Quit' },
  ],
};

const MODE_HINTS = {
  online: { key: 'l', label: 'Playlists' },
  offline: [
    { key: 'l', label: 'Folders' },
    { key: 'd', label: 'Download' },
    { key: 'r', label: 'Rescan' },
  ],
};

function formatKeyBadge(key) {
  return `{cyan-fg}{bold}${key}{/bold}{/cyan-fg}`;
}

function formatHint({ key, label }) {
  return `${formatKeyBadge(key)} {gray-fg}${label}{/gray-fg}`;
}

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

function buildVisualizerBars(levels, playing, accentHex) {
  if (!playing) {
    return `{gray-fg}${'▪'.repeat(VISUALIZER_WIDTH)}{/gray-fg}`;
  }

  let bars = '';
  for (let i = 0; i < levels.length; i++) {
    const height = Math.min(7, Math.floor(levels[i] * 7));
    bars += VISUALIZER_BARS[height];
  }
  return `{${accentHex}-fg}${bars}{/}`;
}

function buildProgressBar(progressMs, durationMs, accentHex, width = 40) {
  if (!durationMs) return `{gray-fg}${'─'.repeat(width)}{/gray-fg}`;

  const pct = Math.min(1, progressMs / durationMs);
  const filled = Math.round(pct * width);
  const head = filled < width ? '╸' : '';
  const bar =
    `{${accentHex}-fg}` +
    '━'.repeat(Math.max(0, filled - (head ? 1 : 0))) +
    head +
    '{/}' +
    '{gray-fg}' +
    '─'.repeat(Math.max(0, width - filled)) +
    '{/gray-fg}';
  return bar;
}

function buildHeaderContent(isOffline, label, icon) {
  const { accentHex } = THEME[isOffline ? 'offline' : 'online'];
  const modeLine = `{bold}${icon} Player13{/bold}  {white-fg}│{/white-fg}  {${accentHex}-fg}${label} MODE{/}`;

  return LOGO.map((line, index) => {
    const logo = `{${accentHex}-fg}${line}{/}`;
    return index === 1 ? `${logo}  ${modeLine}` : logo;
  }).join('\n');
}

function renderKeymap(mode) {
  const modeHints = MODE_HINTS[mode];
  const extra = Array.isArray(modeHints) ? modeHints : [modeHints];
  const groups = [
    [...KEY_HINT_GROUPS.playback],
    [...KEY_HINT_GROUPS.library, ...extra],
    KEY_HINT_GROUPS.system,
  ];

  return groups
    .map((group) => group.map(formatHint).join('  '))
    .join('\n');
}

export function createPlayerUI({ getSpotifyPlayer, offlinePlayer, initialMode = 'online' }) {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Player13',
    fullUnicode: true,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    tags: true,
    style: { fg: 'white', bg: 'green' },
  });

  const nowPlaying = blessed.box({
    parent: screen,
    top: 4,
    left: 0,
    width: '100%',
    height: 10,
    border: { type: 'line' },
    label: ' Now Playing ',
    tags: true,
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
    },
    content: 'Loading...',
  });

  const progressLabel = blessed.text({
    parent: screen,
    top: 14,
    left: 2,
    height: 1,
    tags: true,
    content: '0:00 / 0:00',
  });

  const seekFlash = blessed.text({
    parent: screen,
    top: 14,
    right: 2,
    height: 1,
    tags: true,
    content: '',
  });

  const list = blessed.list({
    parent: screen,
    top: 16,
    left: 0,
    width: '100%',
    height: '100%-23',
    border: { type: 'line' },
    label: ' Library ',
    keys: true,
    vi: true,
    mouse: true,
    style: {
      border: { fg: 'yellow' },
      selected: { bg: 'green', fg: 'black', bold: true },
      item: { fg: 'white' },
    },
    items: [],
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 5,
    tags: true,
    border: { type: 'line' },
    label: ' Controls ',
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'gray' },
    },
  });

  const messageBox = blessed.message({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 7,
    border: { type: 'line' },
    hidden: true,
    style: { border: { fg: 'red' } },
  });

  let mode = initialMode;
  let player = offlinePlayer;
  let spotifyPlayer = null;
  let listMode = 'idle';
  let listData = [];
  let pollTimer = null;
  let animTimer = null;
  let seekFlashTimer = null;
  let lastPlaybackState = null;
  let lastPollAt = 0;
  let displayedLevels = Array(VISUALIZER_WIDTH).fill(0);

  function isOffline() {
    return mode === 'offline';
  }

  function activePlayer() {
    return isOffline() ? offlinePlayer : spotifyPlayer;
  }

  function theme() {
    return THEME[isOffline() ? 'offline' : 'online'];
  }

  function updateChrome() {
    const label = isOffline() ? 'OFFLINE' : 'SPOTIFY';
    const icon = isOffline() ? '♫' : '♪';
    const { headerBg, accentHex } = theme();

    header.style.bg = headerBg;
    header.setContent(buildHeaderContent(isOffline(), label, icon));

    list.style.selected.bg = isOffline() ? '#7c3aed' : 'green';
    list.style.border.fg = isOffline() ? accentHex : 'yellow';

    statusBar.setContent(renderKeymap(isOffline() ? 'offline' : 'online'));
  }

  function interpolatedProgress(state) {
    if (!state?.playing || !state.track) return state?.progressMs ?? 0;
    const elapsed = Date.now() - lastPollAt;
    return Math.min(
      state.track.durationMs || Infinity,
      (state.progressMs ?? 0) + elapsed
    );
  }

  function showSeekFlash(deltaMs) {
    const sign = deltaMs > 0 ? '+' : '−';
    const secs = Math.abs(deltaMs) / 1000;
    seekFlash.setContent(`{yellow-fg}{bold}${sign}${secs}s{/bold}{/yellow-fg}`);
    screen.render();
    clearTimeout(seekFlashTimer);
    seekFlashTimer = setTimeout(() => {
      seekFlash.setContent('');
      screen.render();
    }, 800);
  }

  function showError(err) {
    const msg = typeof err === 'string' ? err : formatSpotifyError(err);
    messageBox.display(msg, 3, () => screen.render());
  }

  function renderNowPlaying(state, levels = displayedLevels) {
    lastPlaybackState = state;
    const { accentHex } = theme();
    const progressMs = state.playing ? interpolatedProgress(state) : state.progressMs ?? 0;

    if (state.error) {
      const title = isOffline() ? 'Offline player issue' : 'Spotify API blocked';
      const lines = state.error.match(/.{1,58}(\s|$)/g) || [state.error];
      nowPlaying.style.border.fg = 'red';
      nowPlaying.setContent(
        `{red-fg}⚠ ${title}{/red-fg}\n\n` +
          lines.map((line) => line.trim()).join('\n')
      );
      progressLabel.setContent('—');
      return;
    }

    if (!state.track) {
      const hint = isOffline()
        ? `Add audio files to ${MUSIC_FOLDER}\nThen press r to rescan`
        : 'Search for a track or open a playlist';
      nowPlaying.style.border.fg = 'gray';
      nowPlaying.setContent(
        `{center}{gray-fg}No active playback{/gray-fg}\n\n{center}${hint}{/center}`
      );
      progressLabel.setContent('—');
      return;
    }

    nowPlaying.style.border.fg = state.playing
      ? isOffline()
        ? '#a855f7'
        : 'green'
      : 'yellow';

    const statusIcon = state.playing ? '▶' : '⏸';
    const statusText = state.playing ? 'PLAYING' : 'PAUSED';
    const statusLine = state.playing
      ? `{${accentHex}-fg}{bold}${statusIcon} ${statusText}{/bold}{/}`
      : `{yellow-fg}{bold}${statusIcon} ${statusText}{/bold}{/yellow-fg}`;
    const visualizer = buildVisualizerBars(levels, state.playing, accentHex);
    const progressBar = buildProgressBar(
      progressMs,
      state.track.durationMs,
      accentHex,
      Math.max(20, Math.min(50, (screen.width || 80) - 20))
    );

    const device = state.device
      ? `{gray-fg}🔊 ${state.device.name}  ·  Vol ${state.device.volume}%{/gray-fg}`
      : '';

    nowPlaying.setContent(
      `${statusLine}  ${visualizer}\n\n` +
        `{bold}{white-fg}${state.track.name}{/white-fg}{/bold}\n` +
        `{cyan-fg}${state.track.artists}{/cyan-fg}\n` +
        `{gray-fg}${state.track.album}{/gray-fg}\n\n` +
        `${progressBar}\n` +
        device
    );

    progressLabel.setContent(
      `{white-fg}${activePlayer().formatDuration(progressMs)}{/white-fg}` +
        `{gray-fg} / {/gray-fg}` +
        `{gray-fg}${activePlayer().formatDuration(state.track.durationMs)}{/gray-fg}`
    );
  }

  function tickAnimation() {
    if (!lastPlaybackState?.playing || !lastPlaybackState.track) return;

    const progressMs = interpolatedProgress(lastPlaybackState);
    const trackKey =
      lastPlaybackState.track.id ||
      lastPlaybackState.track.uri ||
      lastPlaybackState.track.name ||
      '';
    const amplitude = lastPlaybackState.audioAmplitude ?? 1;
    const target = computeAudioLevels(progressMs, VISUALIZER_WIDTH, trackKey, amplitude);

    displayedLevels = displayedLevels.map((level, index) => {
      const delta = target[index] - level;
      return level + delta * 0.42;
    });

    renderNowPlaying(lastPlaybackState, displayedLevels);
    screen.render();
  }

  async function refreshPlayback() {
    const current = activePlayer();
    if (!current) {
      renderNowPlaying({
        playing: false,
        track: null,
        progressMs: 0,
        device: null,
        error: 'Spotify not connected — press o for offline mode',
      });
      screen.render();
      return;
    }

    try {
      const state = await current.getPlaybackState();
      lastPollAt = Date.now();
      if (state.playing && state.track) {
        const trackKey = state.track.id || state.track.uri || state.track.name || '';
        const target = computeAudioLevels(
          state.progressMs ?? 0,
          VISUALIZER_WIDTH,
          trackKey,
          state.audioAmplitude ?? 1
        );
        displayedLevels = target;
      } else {
        displayedLevels = Array(VISUALIZER_WIDTH).fill(0);
      }
      renderNowPlaying(state, displayedLevels);
      screen.render();
    } catch (err) {
      renderNowPlaying({
        playing: false,
        track: null,
        progressMs: 0,
        device: null,
        error: formatSpotifyError(err),
      });
      screen.render();
    }
  }

  async function seekBy(deltaMs) {
    const current = activePlayer();
    if (!current) return showError('No active player');
    try {
      await current.seekRelative(deltaMs);
      showSeekFlash(deltaMs);
      setTimeout(refreshPlayback, 150);
    } catch (e) {
      showError(e);
    }
  }

  function setListItems(items, label, listModeValue) {
    listData = items;
    listMode = listModeValue;
    list.setLabel(` ${label} `);
    list.setItems(
      items.length
        ? items.map((item) =>
            listModeValue === 'playlists'
              ? `${item.name} (${item.tracks} tracks)`
              : `${item.name} — ${item.artists}`
          )
        : ['No results']
    );
    list.select(0);
    screen.render();
  }

  async function loadLibraryList() {
    if (isOffline()) {
      const tracks = offlinePlayer.getTrackList();
      setListItems(tracks, `Local Library (${tracks.length})`, 'tracks');
      return;
    }

    list.setLabel(' Library ');
    list.setItems(['Press / to search or l for playlists']);
    listMode = 'idle';
    listData = [];
    screen.render();
  }

  async function runSearch() {
    const current = activePlayer();
    if (!current) {
      showError('Spotify not connected');
      return;
    }

    const prompt = blessed.prompt({
      parent: screen,
      border: { type: 'line' },
      height: 5,
      width: '50%',
      top: 'center',
      left: 'center',
      label: ' Search ',
      tags: true,
      keys: true,
      vi: true,
      style: { border: { fg: 'cyan' } },
    });

    prompt.input('Search tracks:', '', async (err, value) => {
      if (err || !value?.trim()) return;
      try {
        const tracks = await current.searchTracks(value.trim());
        setListItems(tracks, 'Search Results', 'tracks');
      } catch (e) {
        showError(e);
      }
    });
  }

  async function loadPlaylists() {
    const current = activePlayer();
    if (!current) {
      showError('Spotify not connected');
      return;
    }

    try {
      const playlists = await current.getPlaylists();
      setListItems(
        playlists,
        isOffline() ? 'Music Folders' : 'Your Playlists',
        'playlists'
      );
    } catch (e) {
      showError(e);
    }
  }

  async function rescanLibrary() {
    if (!isOffline()) return;
    offlinePlayer.rescan();
    await loadLibraryList();
    refreshPlayback();
  }

  function renderDownloadOverlay(overlay, { title, progress }) {
    const { accentHex } = theme();
    const barWidth = Math.max(20, Math.min(40, Math.floor((screen.width || 80) * 0.45)));
    const pct = progress?.percentage;
    const progressBar =
      pct !== undefined
        ? buildProgressBar(pct, 100, accentHex, barWidth)
        : `{gray-fg}${'─'.repeat(barWidth)}{/gray-fg}`;

    const status =
      progress?.status === 'finished'
        ? '{green-fg}Complete{/green-fg}'
        : pct !== undefined
          ? `{${accentHex}-fg}${progress.percentage_str || `${Math.round(pct)}%`}{/}`
          : '{yellow-fg}Preparing…{/yellow-fg}';

    const details = [
      progress?.speed_str ? `{gray-fg}${progress.speed_str}{/gray-fg}` : null,
      progress?.eta_str ? `{gray-fg}ETA ${progress.eta_str}{/gray-fg}` : null,
      progress?.downloaded_str && progress?.total_str
        ? `{gray-fg}${progress.downloaded_str} / ${progress.total_str}{/gray-fg}`
        : null,
    ]
      .filter(Boolean)
      .join('  ·  ');

    overlay.setContent(
      `{bold}{white-fg}${title || 'Fetching video info…'}{/white-fg}{/bold}\n\n` +
        `${progressBar}\n` +
        `${status}` +
        (details ? `\n${details}` : '')
    );
    screen.render();
  }

  async function runYouTubeDownload() {
    if (!isOffline()) return;

    const prompt = blessed.prompt({
      parent: screen,
      border: { type: 'line' },
      height: 5,
      width: '60%',
      top: 'center',
      left: 'center',
      label: ' YouTube Download ',
      tags: true,
      keys: true,
      vi: true,
      style: { border: { fg: '#a855f7' } },
    });

    prompt.input('Paste YouTube URL:', '', async (err, value) => {
      if (err || !value?.trim()) return;

      clearInterval(pollTimer);

      const overlay = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 9,
        border: { type: 'line' },
        label: ' Downloading ',
        tags: true,
        style: {
          border: { fg: '#a855f7' },
          fg: 'white',
          bg: 'black',
        },
        content: 'Starting…',
      });

      renderDownloadOverlay(overlay, { title: null, progress: null });

      try {
        const result = await downloadYouTubeAudio(value.trim(), (update) => {
          renderDownloadOverlay(overlay, update);
        });

        overlay.destroy();
        offlinePlayer.rescan();
        await loadLibraryList();

        const fileName = basename(result.savedPath);
        messageBox.display(
          `{green-fg}Saved to music folder:{/green-fg}\n${fileName}`,
          3,
          () => screen.render()
        );
      } catch (e) {
        overlay.destroy();
        showError(e);
      } finally {
        startPolling();
        screen.render();
      }
    });
  }

  async function playSelection() {
    const current = activePlayer();
    if (!current) return;

    const index = list.selected;
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
      showError(e);
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
        player = spotifyPlayer;
      } catch (e) {
        showError(e.message || 'Could not connect to Spotify');
        return;
      }
    } else {
      mode = 'offline';
      player = offlinePlayer;
    }

    updateChrome();
    await loadLibraryList();
    startPolling();
    refreshPlayback();
  }

  function bindControls() {
    screen.key(['space'], async () => {
      const current = activePlayer();
      if (!current) return showError('No active player');
      try {
        await current.togglePlay();
        setTimeout(refreshPlayback, 200);
      } catch (e) {
        showError(e);
      }
    });

    screen.key([','], () => seekBy(-SEEK_MS));
    screen.key(['.'], () => seekBy(SEEK_MS));
    screen.key(['S-left'], () => seekBy(-SEEK_MS));
    screen.key(['S-right'], () => seekBy(SEEK_MS));

    screen.key(['n'], async () => {
      const current = activePlayer();
      if (!current) return;
      try {
        await current.next();
        setTimeout(refreshPlayback, 300);
      } catch (e) {
        showError(e);
      }
    });

    screen.key(['p'], async () => {
      const current = activePlayer();
      if (!current) return;
      try {
        await current.previous();
        setTimeout(refreshPlayback, 300);
      } catch (e) {
        showError(e);
      }
    });

    screen.key(['+', '='], async () => {
      const current = activePlayer();
      if (!current) return;
      try {
        const state = await current.getPlaybackState();
        const vol = state.device?.volume ?? 50;
        await current.setVolume(vol + 10);
        refreshPlayback();
      } catch (e) {
        showError(e);
      }
    });

    screen.key(['-', '_'], async () => {
      const current = activePlayer();
      if (!current) return;
      try {
        const state = await current.getPlaybackState();
        const vol = state.device?.volume ?? 50;
        await current.setVolume(vol - 10);
        refreshPlayback();
      } catch (e) {
        showError(e);
      }
    });

    screen.key(['/'], () => runSearch());
    screen.key(['l'], () => loadPlaylists());
    screen.key(['r'], () => rescanLibrary());
    screen.key(['d'], () => runYouTubeDownload());
    screen.key(['o'], () => switchMode());
    screen.key(['enter'], () => playSelection());
    screen.key(['q', 'C-c'], async () => {
      await offlinePlayer.stop();
      process.exit(0);
    });

    list.on('select', () => playSelection());
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

  bindControls();
  updateChrome();
  loadLibraryList();
  startPolling();
  startAnimation();
  refreshPlayback();
  screen.render();

  return {
    destroy() {
      clearInterval(pollTimer);
      clearInterval(animTimer);
      clearTimeout(seekFlashTimer);
      screen.destroy();
    },
  };
}
