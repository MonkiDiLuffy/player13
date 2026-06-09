import blessed from 'blessed';
import { formatSpotifyError } from './errors.js';
import { MUSIC_FOLDER } from './config.js';

const SEEK_MS = 10_000;
const VISUALIZER_BARS = '▁▂▃▄▅▆▇█';
const VISUALIZER_WIDTH = 12;

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
    { key: 'r', label: 'Rescan' },
  ],
};

function formatKeyBadge(key) {
  return `{cyan-fg}{bold}${key}{/bold}{/cyan-fg}`;
}

function formatHint({ key, label }) {
  return `${formatKeyBadge(key)} {gray-fg}${label}{/gray-fg}`;
}

function buildVisualizerFrame(frame, playing) {
  if (!playing) {
    return `{gray-fg}${'▪'.repeat(VISUALIZER_WIDTH)}{/gray-fg}`;
  }

  let bars = '';
  for (let i = 0; i < VISUALIZER_WIDTH; i++) {
    const wave =
      (Math.sin(frame * 0.25 + i * 0.65) + 1) / 2 +
      (Math.sin(frame * 0.55 + i * 1.1) + 1) / 4;
    const height = Math.min(7, Math.floor(wave * 7));
    bars += VISUALIZER_BARS[height];
  }
  return `{green-fg}${bars}{/green-fg}`;
}

function buildProgressBar(progressMs, durationMs, width = 40) {
  if (!durationMs) return `{gray-fg}${'─'.repeat(width)}{/gray-fg}`;

  const pct = Math.min(1, progressMs / durationMs);
  const filled = Math.round(pct * width);
  const head = filled < width ? '╸' : '';
  const bar =
    '{green-fg}' +
    '━'.repeat(Math.max(0, filled - (head ? 1 : 0))) +
    head +
    '{/green-fg}' +
    '{gray-fg}' +
    '─'.repeat(Math.max(0, width - filled)) +
    '{/gray-fg}';
  return bar;
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
    height: 3,
    tags: true,
    style: { fg: 'white', bg: 'green' },
  });

  const nowPlaying = blessed.box({
    parent: screen,
    top: 3,
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
    top: 13,
    left: 2,
    height: 1,
    tags: true,
    content: '0:00 / 0:00',
  });

  const seekFlash = blessed.text({
    parent: screen,
    top: 13,
    right: 2,
    height: 1,
    tags: true,
    content: '',
  });

  const list = blessed.list({
    parent: screen,
    top: 15,
    left: 0,
    width: '100%',
    height: '100%-22',
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
  let animFrame = 0;
  let seekFlashTimer = null;
  let lastPlaybackState = null;

  function isOffline() {
    return mode === 'offline';
  }

  function activePlayer() {
    return isOffline() ? offlinePlayer : spotifyPlayer;
  }

  function updateChrome() {
    const label = isOffline() ? 'OFFLINE' : 'SPOTIFY';
    const color = isOffline() ? 'magenta' : 'green';
    const icon = isOffline() ? '♫' : '♪';
    header.style.bg = color;
    header.setContent(
      `{center}{bold}${icon}  Player13{/bold}  {white-fg}│{/white-fg}  ${label} MODE{/center}`
    );
    statusBar.setContent(renderKeymap(isOffline() ? 'offline' : 'online'));
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

  function renderNowPlaying(state) {
    lastPlaybackState = state;

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

    nowPlaying.style.border.fg = state.playing ? 'green' : 'yellow';

    const statusIcon = state.playing ? '▶' : '⏸';
    const statusColor = state.playing ? 'green' : 'yellow';
    const statusText = state.playing ? 'PLAYING' : 'PAUSED';
    const visualizer = buildVisualizerFrame(animFrame, state.playing);
    const progressBar = buildProgressBar(
      state.progressMs,
      state.track.durationMs,
      Math.max(20, Math.min(50, (screen.width || 80) - 20))
    );

    const device = state.device
      ? `{gray-fg}🔊 ${state.device.name}  ·  Vol ${state.device.volume}%{/gray-fg}`
      : '';

    nowPlaying.setContent(
      `{${statusColor}-fg}{bold}${statusIcon} ${statusText}{/bold}{/${statusColor}-fg}  ${visualizer}\n\n` +
        `{bold}{white-fg}${state.track.name}{/white-fg}{/bold}\n` +
        `{cyan-fg}${state.track.artists}{/cyan-fg}\n` +
        `{gray-fg}${state.track.album}{/gray-fg}\n\n` +
        `${progressBar}\n` +
        device
    );

    progressLabel.setContent(
      `{white-fg}${activePlayer().formatDuration(state.progressMs)}{/white-fg}` +
        `{gray-fg} / {/gray-fg}` +
        `{gray-fg}${activePlayer().formatDuration(state.track.durationMs)}{/gray-fg}`
    );
  }

  function tickAnimation() {
    if (lastPlaybackState?.playing) {
      animFrame += 1;
      renderNowPlaying(lastPlaybackState);
      screen.render();
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
        error: 'Spotify not connected — press o for offline mode',
      });
      screen.render();
      return;
    }

    try {
      const state = await current.getPlaybackState();
      renderNowPlaying(state);
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
    animTimer = setInterval(tickAnimation, 120);
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
