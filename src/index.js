#!/usr/bin/env node

import { validateConfig } from './config.js';
import { authenticate, getAuthenticatedApi } from './auth.js';
import { SpotifyPlayer } from './spotify.js';
import { OfflinePlayer } from './offline.js';
import { createPlayerUI } from './ui.js';

async function createSpotifyPlayer() {
  validateConfig();
  const api = await getAuthenticatedApi();
  return new SpotifyPlayer(api);
}

async function main() {
  const authOnly = process.argv.includes('--auth-only');
  const offlineOnly =
    process.argv.includes('--offline') || process.argv.includes('--offline-mode');

  if (authOnly) {
    validateConfig();
    console.log('Authenticating with Spotify...');
    await authenticate();
    console.log('Success! Tokens saved. Run `npm start` to launch the player.');
    return;
  }

  const offlinePlayer = await new OfflinePlayer().init();

  const getSpotifyPlayer = async () => {
    try {
      return await createSpotifyPlayer();
    } catch (err) {
      throw new Error(
        err.message || 'Spotify login failed. Run `npm run auth` first.'
      );
    }
  };

  if (!offlineOnly) {
    try {
      const spotifyPlayer = await createSpotifyPlayer();
      createPlayerUI({
        getSpotifyPlayer: async () => spotifyPlayer,
        offlinePlayer,
        initialMode: 'online',
      });
      return;
    } catch {
      // Fall back to offline mode when Spotify is unavailable.
    }
  }

  createPlayerUI({
    getSpotifyPlayer,
    offlinePlayer,
    initialMode: 'offline',
  });
}

main().catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
