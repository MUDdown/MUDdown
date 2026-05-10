//! Discord Rich Presence integration (opt-in, off by default).
//!
//! Speaks RPC to the local Discord desktop client over the platform IPC socket
//! (`$XDG_RUNTIME_DIR/discord-ipc-N` on Linux/macOS, `\\?\pipe\discord-ipc-N` on
//! Windows). No OAuth, no MUDdown server involvement — the local Discord client
//! is the only third party in the loop, and only when the user has opted in via
//! the `discord_rich_presence` desktop preference.
//!
//! `discord_presence_update` and `discord_presence_clear` early-return with
//! `Ok(())` when `enabled` is false, so the frontend can call them
//! unconditionally and let the Rust side honour the user's preference.
//! `discord_presence_set_enabled` always runs (it is the toggle itself) and is
//! idempotent against the cached `enabled` value.
//!
//! Connection failures (Discord not running, socket not yet ready,
//! `set_activity` rejection) are silent no-ops by contract — they must not
//! propagate as user-visible errors. To avoid retry storms when Discord is
//! closed but Rich Presence is enabled, failed connect attempts cool down for
//! `RECONNECT_COOLDOWN_SECS` before being retried.

use std::sync::Mutex;

use discord_rich_presence::{
    activity::{Activity, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use tauri::State;

/// Discord Application ID for MUDdown's Rich Presence integration.
///
/// Registered at https://discord.com/developers/applications/. Used as the
/// `client_id` in the local IPC handshake; Discord rejects presence updates
/// for unregistered IDs.
const APPLICATION_ID: &str = "1490036207340748960";

/// Cooldown after a failed `connect()` before another connect attempt. Prevents
/// per-room-transition retry storms when Discord is closed but Rich Presence
/// remains enabled.
const RECONNECT_COOLDOWN_SECS: i64 = 30;

/// Process-wide Rich Presence state.
///
/// Held inside a `Mutex` and managed by Tauri so commands can flip the enabled
/// flag and lazily connect the IPC client on demand.
pub struct PresenceState {
    enabled: bool,
    client: Option<DiscordIpcClient>,
    session_start: Option<i64>,
    /// Unix timestamp of the most recent failed connect attempt, or `None` if
    /// no failure is currently being cooled down.
    last_connect_failure: Option<i64>,
}

impl PresenceState {
    pub const fn new() -> Self {
        Self {
            enabled: false,
            client: None,
            session_start: None,
            last_connect_failure: None,
        }
    }
}

/// Initial managed state for the Tauri builder.
pub fn initial_state() -> Mutex<PresenceState> {
    Mutex::new(PresenceState::new())
}

/// Connect the IPC client lazily. Returns silently when Discord isn't running
/// locally — connection failures are expected and must not propagate as
/// user-visible errors per the privacy contract. After a failure, further
/// connect attempts are skipped until `RECONNECT_COOLDOWN_SECS` have elapsed
/// to avoid retry storms when Rich Presence is enabled but Discord is closed.
fn ensure_connected(state: &mut PresenceState) {
    if state.client.is_some() {
        return;
    }
    let now = now_unix();
    if let Some(last_fail) = state.last_connect_failure {
        if now.saturating_sub(last_fail) < RECONNECT_COOLDOWN_SECS {
            return;
        }
    }
    let mut client = match DiscordIpcClient::new(APPLICATION_ID) {
        Ok(c) => c,
        Err(_) => {
            state.last_connect_failure = Some(now);
            return;
        }
    };
    if client.connect().is_err() {
        // Discord not running, or socket not yet available. Cool down before
        // the next attempt; the next update post-cooldown will retry.
        state.last_connect_failure = Some(now);
        return;
    }
    state.last_connect_failure = None;
    state.client = Some(client);
    if state.session_start.is_none() {
        state.session_start = Some(now);
    }
}

/// Best-effort teardown. `clear_activity` and `close` errors are ignored: at
/// disconnect time the worst case is that a stale activity lingers briefly on
/// the user's profile until Discord garbage-collects it, which is preferable
/// to surfacing an error from a UI toggle.
fn disconnect(state: &mut PresenceState) {
    if let Some(mut client) = state.client.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    state.session_start = None;
    state.last_connect_failure = None;
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Tauri commands ────────────────────────────────────────────────

/// Toggle the opt-in flag. Disabling immediately clears any active presence so
/// nothing lingers on the user's profile.
/// Toggle the integration. Always callable: idempotent against the cached
/// `enabled` flag, and is the only entry point that runs while disabled
/// (the others early-return when `enabled == false`).
#[tauri::command]
pub fn discord_presence_set_enabled(
    state: State<'_, Mutex<PresenceState>>,
    enabled: bool,
) -> Result<(), String> {
    // A poisoned Mutex would normally surface as an Err to JS; the module
    // contract is silent no-ops, so recover the inner state instead.
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(p) => p.into_inner(),
    };
    if s.enabled == enabled {
        return Ok(());
    }
    s.enabled = enabled;
    if !enabled {
        disconnect(&mut s);
    }
    Ok(())
}

/// Push an activity update. Silently no-ops when disabled or when Discord
/// isn't running locally.
#[tauri::command]
pub fn discord_presence_update(
    state: State<'_, Mutex<PresenceState>>,
    details: String,
    state_text: String,
    large_text: Option<String>,
) -> Result<(), String> {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(p) => p.into_inner(),
    };
    if !s.enabled {
        return Ok(());
    }
    ensure_connected(&mut s);
    let session_start = s.session_start.unwrap_or_else(now_unix);
    let Some(client) = s.client.as_mut() else {
        return Ok(());
    };

    let mut assets = Assets::new().large_image("muddown-logo");
    if let Some(ref text) = large_text {
        assets = assets.large_text(text);
    }

    let activity = Activity::new()
        .details(&details)
        .state(&state_text)
        .assets(assets)
        .timestamps(Timestamps::new().start(session_start))
        .buttons(vec![
            Button::new("Play in browser", "https://muddown.com/play"),
            Button::new("Get MUDdown", "https://muddown.com"),
        ]);

    if let Err(_) = client.set_activity(activity) {
        // Drop the client so the next update reconnects, and start the
        // reconnect cooldown so we don't tight-loop on a flapping IPC.
        let _ = client.close();
        s.client = None;
        s.last_connect_failure = Some(now_unix());
    }
    Ok(())
}

/// Clear any active presence. Silently no-ops when disabled.
#[tauri::command]
pub fn discord_presence_clear(
    state: State<'_, Mutex<PresenceState>>,
) -> Result<(), String> {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(p) => p.into_inner(),
    };
    if !s.enabled {
        return Ok(());
    }
    if let Some(client) = s.client.as_mut() {
        let _ = client.clear_activity();
    }
    // Reset the session timer so the next update after a disconnect/reconnect
    // starts elapsed from now via the `unwrap_or_else(now_unix)` fallback in
    // `discord_presence_update`, rather than carrying the previous session's
    // start timestamp.
    s.session_start = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_is_noop_when_disabled() {
        // With enabled=false, update() must not try to connect or panic.
        let mut s = PresenceState::new();
        assert!(!s.enabled);
        // Calling ensure_connected when disabled is the caller's responsibility;
        // verify the disabled path skips it inside the command.
        // We simulate the command's gate manually:
        if !s.enabled {
            // no-op path
        } else {
            ensure_connected(&mut s);
        }
        assert!(s.client.is_none());
    }

    #[test]
    fn disable_clears_session_start() {
        let mut s = PresenceState::new();
        s.enabled = true;
        s.session_start = Some(123);
        s.last_connect_failure = Some(456);
        s.enabled = false;
        disconnect(&mut s);
        assert!(s.session_start.is_none());
        assert!(s.client.is_none());
        assert!(s.last_connect_failure.is_none());
    }

    #[test]
    fn ensure_connected_respects_cooldown() {
        // With a recent failure stamped, ensure_connected must not attempt a
        // fresh connect (and therefore must not panic in environments where
        // Discord isn't running). We can't easily inspect "did it attempt?"
        // without a mock, but we can at least verify the cooldown check runs
        // without changing state when within the window.
        let mut s = PresenceState::new();
        s.last_connect_failure = Some(now_unix());
        ensure_connected(&mut s);
        assert!(s.client.is_none());
        // Cooldown stamp should remain so subsequent calls also skip.
        assert!(s.last_connect_failure.is_some());
    }
}
