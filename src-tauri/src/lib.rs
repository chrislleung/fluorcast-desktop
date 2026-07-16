mod nibi;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            nibi::end_manual_mfa_session,
            nibi::get_manual_mfa_session_commands,
            nibi::open_manual_mfa_login,
            nibi::open_powershell_login,
            nibi::clean_stale_manual_mfa_session,
            nibi::test_manual_mfa_session,
            nibi::test_nibi_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running FluorCast");
}
