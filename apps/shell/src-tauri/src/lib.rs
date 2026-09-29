use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Shows the overlay and gives it keyboard focus.
fn reveal(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Toggles the overlay. Hiding rather than closing keeps the webview warm, so
/// the orb and the SSE connection survive between invocations.
fn toggle(window: &WebviewWindow) {
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => reveal(window),
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

#[tauri::command]
fn hide_overlay(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn show_overlay(window: WebviewWindow) {
    reveal(&window);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![hide_overlay, show_overlay])
        .setup(|app| {
            let handle = app.handle().clone();

            // ---- Tray ------------------------------------------------------
            let toggle_item = MenuItemBuilder::with_id("toggle", "Show Assistant").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle_item])
                .separator()
                .items(&[&quit_item])
                .build()?;

            TrayIconBuilder::with_id("assistant-tray")
                .menu(&menu)
                // The menu should not pop on left click; that gesture toggles
                // the overlay, which is the thing you actually want 99% of the time.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => {
                        if let Some(window) = main_window(app) {
                            toggle(&window);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = main_window(tray.app_handle()) {
                            toggle(&window);
                        }
                    }
                })
                .build(app)?;

            // ---- Global hotkey ---------------------------------------------
            let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);

            app.global_shortcut().on_shortcut(hotkey, move |app, _, event| {
                // Fire on press only; without this the release fires a second
                // toggle and the window flickers straight back shut.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let Some(window) = main_window(app) else { return };

                let was_visible = window.is_visible().unwrap_or(false);
                toggle(&window);

                // Revealing via the hotkey means "I want to talk", so tell the
                // UI to start listening rather than just appearing.
                if !was_visible {
                    let _ = app.emit("assistant://hotkey-activate", ());
                }
            })?;

            // Start hidden and live in the tray.
            if std::env::var("ASSISTANT_START_VISIBLE").is_err() {
                if let Some(window) = main_window(&handle) {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the overlay should tuck it away, not end the session.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Assistant");
}
