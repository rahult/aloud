// Playing audio in the desktop app's process instead of a spawned afplay.
//
// The server still owns the queue, the index and the state — this is only an
// output device that happens to live in another process. It parks a WAV under
// an id, asks the app to play that id, and resolves the session's callback
// when the app reports the track finished.
//
// Ids matter: the app can report a sentence finishing just after the session
// moved on, and acting on that would advance the session twice.

export function createRemotePlayer({send, wavDurationMs}) {
  let nextId = 1;
  const parked = new Map(); // id -> {wav, onEnd}
  let current = null;       // the only id whose report we will act on

  function play(wav, onEnd) {
    const id = nextId++;
    parked.set(id, {wav, onEnd});
    current = id;
    send({action: 'play', id});

    const alive = () => current === id;
    return {
      stop() {
        parked.delete(id);
        if (!alive()) return;
        current = null;
        send({action: 'stop'});
      },
      pause() { if (alive()) send({action: 'pause'}); },
      resume() { if (alive()) send({action: 'resume'}); },
    };
  }

  // The app fetches the audio it was asked to play.
  const take = id => parked.get(Number(id))?.wav ?? null;

  // Returns whether the report was acted on, so the route can 404 a report
  // for something we are no longer waiting on.
  function reportEnded(id, error) {
    const key = Number(id);
    const entry = parked.get(key);
    parked.delete(key);
    if (!entry || current !== key) return false;
    current = null;
    entry.onEnd(error);
    return true;
  }

  return {supportsPause: true, play, wavDurationMs, take, reportEnded};
}

// Picks a player per utterance. `supportsPause` is a getter rather than a
// value because the desktop app can come and go while a session is running.
export function createPlayerRouter({local, remote, isAppConnected}) {
  const active = () => (isAppConnected() ? remote : local);
  return {
    get supportsPause() { return active().supportsPause; },
    wavDurationMs: wav => local.wavDurationMs(wav),
    play: (wav, onEnd) => active().play(wav, onEnd),
  };
}
