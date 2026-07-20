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
            nibi::get_restricted_robot_public_key,
            nibi::open_manual_mfa_login,
            nibi::open_powershell_login,
            nibi::clean_stale_manual_mfa_session,
            nibi::persistent_shell_read,
            nibi::persistent_shell_send_input,
            nibi::persistent_shell_start,
            nibi::persistent_shell_status,
            nibi::persistent_shell_stop,
            nibi::persistent_shell_test_readiness,
            nibi::check_local_ssh_capabilities,
            nibi::test_manual_mfa_session,
            nibi::test_nibi_connection,
            nibi::test_robot_automation,
            nibi::run_nibi_remote_command,
            nibi::download_nibi_file,
            nibi::upload_nibi_file,
            nibi::prediction_output_temp_file_path,
            nibi::read_prediction_output_file,
            nibi::write_prediction_input_temp_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running FluorCast");
}
