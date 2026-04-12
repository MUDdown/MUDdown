use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager, Emitter,
};

/// Update the native window title from the JS frontend.
#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) {
    if let Err(e) = window.set_title(&title) {
        eprintln!("[set_window_title] Failed: {e}");
    }
}

/// Send a native OS notification (e.g. mentions, combat events, NPC contact).
#[tauri::command]
fn send_notification(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    // Notifications are best-effort; permission denial is expected and should not propagate
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Update the system tray tooltip to reflect connection status.
#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Err(e) = tray.set_tooltip(Some(&tooltip)) {
            eprintln!("[set_tray_tooltip] Failed: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .invoke_handler(tauri::generate_handler![set_window_title, send_notification, set_tray_tooltip])
        .setup(|app| {
            let handle = app.handle();

            // ── Menu bar ───────────────────────────────────────────
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&MenuItemBuilder::with_id("connect", "Connect").build(handle)?)
                .item(&MenuItemBuilder::with_id("disconnect", "Disconnect").build(handle)?)
                .separator()
                .quit()
                .build()?;

            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&MenuItemBuilder::with_id("clear", "Clear Output").accelerator("CmdOrCtrl+L").build(handle)?)
                .item(&MenuItemBuilder::with_id("focus_input", "Focus Input").accelerator("CmdOrCtrl+K").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("toggle_inventory", "Toggle Inventory").build(handle)?)
                .item(&MenuItemBuilder::with_id("toggle_hints", "Toggle Hints").build(handle)?)
                .build()?;

            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&MenuItemBuilder::with_id("help_commands", "Game Commands").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("about", "About MUDdown").build(handle)?)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .item(&file_menu)
                .item(&view_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            // ── Menu event handler ─────────────────────────────────
            let handle_clone = handle.clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                // Forward menu actions to the JS frontend
                if let Err(e) = handle_clone.emit("menu-action", id) {
                    eprintln!("[menu] Failed to emit event: {e}");
                }
            });

            // ── System tray ────────────────────────────────────────
            let tray_icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

            let tray_menu = MenuBuilder::new(handle)
                .item(&MenuItemBuilder::with_id("tray_show", "Show MUDdown").build(handle)?)
                .item(&PredefinedMenuItem::separator(handle)?)
                .item(&MenuItemBuilder::with_id("tray_quit", "Quit").build(handle)?)
                .build()?;

            let handle_tray = handle.clone();
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("MUDdown — Disconnected")
                .menu(&tray_menu)
                .on_menu_event(move |_app, event| {
                    match event.id().0.as_str() {
                        "tray_show" => {
                            if let Some(w) = handle_tray.get_webview_window("main") {
                                if let Err(e) = w.show() {
                                    eprintln!("tray_show: failed to show window: {e}");
                                }
                                if let Err(e) = w.set_focus() {
                                    eprintln!("tray_show: failed to set focus: {e}");
                                }
                            }
                        }
                        "tray_quit" => {
                            handle_tray.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(handle)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("error while running MUDdown desktop: {}", e));
}
